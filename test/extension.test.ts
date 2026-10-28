/**
 * Regression tests for the unpacked Chrome companion itself.
 *
 * These execute the shipped JavaScript rather than a TypeScript reimplementation. The
 * DOM adapter runs against tiny structural fakes for the ChatGPT shapes we have seen in
 * the browser, and the service worker runs in a VM with fake Chrome storage so its
 * restart/durability rules are exercised without needing a Chrome process in CI.
 */

import { promises as fs } from 'node:fs';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../src/main/version.js');
const EXTENSION_BRIDGE_PROTOCOL = 16;
const OPEN_CONVERSATION_INVENTORY_TIMEOUT_MS_FOR_TEST = 1_500;
const CLEANUP_CONVERSATION_INVENTORY_TIMEOUT_MS_FOR_TEST = 5_000;

let domSource = '';
let backgroundSource = '';
let contentSource = '';
let goalAnswerProjectionSource = '';
let currentRecorderVersion = 0;

beforeAll(async () => {
  [domSource, backgroundSource, contentSource] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'extension', 'chatgpt-dom.js'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'extension', 'background.js'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'extension', 'content.js'), 'utf8')
  ]);
  backgroundSource = backgroundSource.replace(/\r\n/g, '\n');
  contentSource = contentSource.replace(/\r\n/g, '\n');
  const projectionStart = contentSource.indexOf('  function goalAnswerReplacesPriorError(goal) {');
  const projectionEnd = contentSource.indexOf('\n  function goalStageView(goal)', projectionStart);
  if (projectionStart < 0 || projectionEnd < 0) throw new Error('Shipped current-answer projection is missing');
  goalAnswerProjectionSource = contentSource.slice(projectionStart, projectionEnd);
  currentRecorderVersion = Number(/const RECORDER_VERSION = (\d+);/.exec(contentSource)?.[1]);
  if (!Number.isSafeInteger(currentRecorderVersion) || currentRecorderVersion < 1) throw new Error('Shipped recorder protocol version is missing');
});

describe('extension release metadata', () => {
  it('keeps the background page protocol aligned with the shipped isolated recorder', () => {
    const backgroundVersion = Number(/const PAGE_RECORDER_VERSION = (\d+);/.exec(backgroundSource)?.[1]);
    expect(backgroundVersion).toBe(currentRecorderVersion);
  });
  it.each(['visible', 'hidden', 'navigation', 'focus-roundtrip', 'pairing-change', 'disabled', 'permission-denied'])('captures debug pixels only for a stable visible exact document: %s', async mode => {
    const start = backgroundSource.indexOf('async function captureBrowserDebug(offer) {');
    const end = backgroundSource.indexOf('\nasync function deliverJournalBatch', start);
    expect(start).toBeGreaterThan(0);
    const conversation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    let epoch = 3, focusListener: (() => void) | undefined;
    const call = vi.fn(async (_path, _body, _retry, accepted) => ({ ok: accepted() }));
    const capture = vi.fn(async () => {
      if (mode === 'navigation') epoch++;
      if (mode === 'focus-roundtrip') focusListener?.();
      if (mode === 'pairing-change') context.connectionEpoch++;
      return 'data:image/jpeg;base64,QUJD';
    });
    const context = { connectionEpoch: 1, instanceId: 'profile-test', unassignedHistoryUncertain: false,
      token: 'test-token', disconnected: false,
      browserDebugCaptureInFlight: false, browserDebugCaptureLastAt: 0, setTimeout, clearTimeout,
      unassignedHistoryConversation: () => false, cleanConversationId: (value: string) => value === conversation ? value : null,
      conversationFromUrl: () => conversation, tabConversations: { '4': conversation },
      tabDocuments: { '4': 'document' }, tabEpochs: { '4': 3 }, Date,
      ownsDocument: (source: { navigationEpoch: number }) => source.navigationEpoch === epoch,
      chrome: { storage: { local: { get: async () => ({ browserDebugScreenshots: mode !== 'disabled' }) } },
        permissions: { contains: async () => mode !== 'permission-denied' },
        tabs: { query: async () => mode === 'hidden' ? [] : [{ id: 4, windowId: 2, url: 'https://chatgpt.com/c/test' }],
        get: async () => ({ active: true, windowId: 2, url: 'https://chatgpt.com/c/test' }), captureVisibleTab: capture,
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() } },
        windows: { get: async () => ({ focused: true, state: 'normal' }),
          onFocusChanged: { addListener: (fn: () => void) => { focusListener = fn; }, removeListener: vi.fn() } } }, call };
    const run = vm.runInNewContext(`${backgroundSource.slice(start, end)}; captureBrowserDebug`, context);
    await run({ id: 'capture', conversationId: conversation, expiresAt: Date.now() + 30_000 });
    const packet = JSON.parse(call.mock.calls[0]![1].body);
    expect(Boolean(packet.image)).toBe(mode === 'visible');
    expect(capture).toHaveBeenCalledTimes(['hidden', 'disabled', 'permission-denied'].includes(mode) ? 0 : 1);
    if (mode === 'pairing-change') expect(call.mock.calls[0]![3]()).toBe(false);
  });
  it('shows account restriction as attention even when cached work or a helper lacks Goal metadata', () => {
    const start = contentSource.indexOf('  function refreshTabStatus() {');
    const end = contentSource.indexOf('\n  function injectStage()', start);
    for (const goalConfig of [null, { enabled: true, mode: 'loop', health: { state: 'working' } }]) {
      const setTabStatus = vi.fn();
      const context = { status: { connected: true }, conversationId: 'test', goalConfig,
        CLF_DOM: { conversationId: () => 'test', errors: () => [{ reason: 'account_restricted' }],
          generating: () => true, setTabStatus },
        nativeErrorAttention: true, goalError: null, goalErrorCode: '', goalDraft: null, goalPhase: '', generating: true,
        pendingTools: 1, job: null, goalBusy: false, bootstrap: 'worker', agent: null, finiteOneOff: false,
        observed: { pulledAt: Date.now() } };
      vm.runInNewContext(`${goalAnswerProjectionSource}\n${contentSource.slice(start, end)}; refreshTabStatus();`, context);
      expect(setTabStatus).toHaveBeenCalledWith('error', '');
    }
  });
  it('does not show cached working state while the saved Loop reply is blocked on model confirmation', () => {
    const start = contentSource.indexOf('  function refreshTabStatus() {');
    const end = contentSource.indexOf('\n  function injectStage()', start);
    const setTabStatus = vi.fn();
    vm.runInNewContext(`${goalAnswerProjectionSource}\n${contentSource.slice(start, end)}; refreshTabStatus();`, {
      status: { connected: true }, conversationId: 'test',
      goalConfig: { enabled: true, mode: 'loop', health: { state: 'working' } },
      CLF_DOM: { conversationId: () => 'test', errors: () => [], generating: () => false, setTabStatus },
      goalPhase: 'model-wait', nativeErrorAttention: false, goalError: null, goalErrorCode: '',
      goalDraft: { stage: 'ready' }, generating: false, pendingTools: 0,
      job: null, goalBusy: false, bootstrap: null, agent: null, finiteOneOff: false,
      observed: { pulledAt: Date.now() }
    });
    expect(setTabStatus).toHaveBeenCalledWith('error', '');
  });
  it('keeps the app package, bundled extension and bridge protocol on the same release', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    const lock = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package-lock.json'), 'utf8')) as {
      version: string;
      packages?: Record<string, { version?: string }>;
    };
    const manifest = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
    ) as { version: string; name: string; description: string; action: { default_title: string } };
    expect(pkg.version).toBe(APP_VERSION);
    expect(lock.version).toBe(APP_VERSION);
    expect(lock.packages?.['']?.version).toBe(APP_VERSION);
    expect(manifest.version).toBe(APP_VERSION);
    expect(manifest.name).toBe('Luna Forge X7 Companion');
    expect(manifest.description).toContain('Luna Forge X7');
    expect(manifest.action.default_title).toBe('Luna Forge X7 Companion');
    expect(BRIDGE_PROTOCOL).toBe(EXTENSION_BRIDGE_PROTOCOL);
    expect(backgroundSource).toContain(`const BRIDGE_PROTOCOL = ${EXTENSION_BRIDGE_PROTOCOL};`);
  });

  /**
   * The Fiber helper is the one piece of this extension that runs in ChatGPT's own
   * JavaScript context, and it only does so because the manifest says `"world": "MAIN"`.
   * Lose that one word and the file still loads, still finds nothing — `__reactFiber is
   * invisible from an isolated world — and fails closed, so every collapsed row silently
   * goes back to standing for one call. That is a regression with no symptom, which is
   * why it is pinned here.
   */
  it('runs only the fiber and bounded usage readers in the page context', async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
    ) as { content_scripts: Array<{ js: string[]; world?: string }> };

    const main = manifest.content_scripts.filter((entry) => entry.world === 'MAIN');
    expect(main).toHaveLength(2);
    expect(main.flatMap((entry) => entry.js).sort()).toEqual(['fiber.js', 'usage.js']);
    // The rest stays isolated: the page must not be able to reach the code that talks to
    // the service worker, holds the bridge token, or decides what gets recorded.
    for (const entry of manifest.content_scripts) {
      if (entry.world === 'MAIN') continue;
      expect(entry.js).not.toContain('fiber.js');
      expect(entry.world ?? 'ISOLATED').toBe('ISOLATED');
    }
  });

  it('declares grouping plus Chrome 125 direct-control permissions without dropping tabGroups', async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
    ) as { permissions: string[]; host_permissions: string[]; minimum_chrome_version: string };
    expect(manifest.permissions).toContain('tabGroups');
    expect(manifest.permissions).toEqual(expect.arrayContaining(['debugger', 'tabs', 'clipboardWrite']));
    expect(manifest.host_permissions).toEqual(expect.arrayContaining(['http://*/*', 'https://*/*']));
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(125);
  });

  /**
   * The helper's whole justification is that it reads props the page owns. What it may
   * hand back is an allowlist, and these are the two things that must never be in it: a
   * tool's arguments, which are the user's text, and the secrets observed inside them.
   */
  it('never sends tool arguments or secrets out of the page context', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'extension', 'fiber.js'), 'utf8');
    // Comments discuss the secrets by name; the code must never touch them.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/agent_key|authorization|access_token/i);
    // Request arguments are never turned into an object. They used to be parsed for their
    // `path`, which meant the arguments — the user's text, and the secrets observed inside
    // them — existed as live values in this scope, one careless line from crossing over.
    // The path is read off the front of the string instead, so `args` is never walked.
    // The bounded native Core RESULT reader now parses one typed MCP envelope solely
    // for its opaque post-commit witness. Keep that exception local: request readers
    // and the rest of the page helper still cannot parse or serialize payload objects.
    const resultStart = code.indexOf('  function coreResultReceipt(');
    const resultEnd = code.indexOf('\n  function localCountOf(', resultStart);
    expect(resultStart).toBeGreaterThanOrEqual(0);
    expect(resultEnd).toBeGreaterThan(resultStart);
    const resultReader = code.slice(resultStart, resultEnd);
    expect(resultReader.match(/JSON\.parse/g)).toHaveLength(2);
    expect(resultReader).toContain('JSON.parse(raw)');
    // The second decoder is exclusively the own, self-contained MCP resource
    // after its URI/MIME/size gates. Request arguments and nested text remain
    // unparsed; neither envelope nor resource content may cross the page boundary.
    expect(resultReader).toContain('JSON.parse(resource.text)');
    expect(resultReader).toContain("resource.text.length > 128");
    expect(resultReader).toContain("Object.keys(resource).length !== 3");
    expect(resultReader).toContain("resource.uri !== 'urn:cos:result-receipt:v1:' + receipt.id");
    expect(resultReader).toContain("resource.mimeType === 'application/vnd.chat-on-steroids.result-receipt+json'");

    expect(resultReader).toContain("message.author?.role !== 'tool'");
    expect(resultReader).toContain("content.content_type !== 'code' || content.language !== 'json'");
    expect(resultReader).toContain('return receiptId;');
    expect(code.slice(0, resultStart) + code.slice(resultEnd)).not.toMatch(/JSON\.parse/);
    expect(code).not.toMatch(/\bargs\b/);
    // Nor may a whole object be serialised across, which would defeat the allowlist.
    expect(code).not.toMatch(/JSON\.stringify/);
  });

  /**
   * The installed popup showed "Paired · port 8765" with a green dot and, underneath it,
   * a six-digit code field and a Pair button — a page contradicting itself about the one
   * thing it exists to report. There is nothing to type any more, so the way to keep that
   * from coming back is for the markup to have no field to type into.
   */
  it('has no pairing-code UI anywhere in the popup', async () => {
    const dir = path.join(process.cwd(), 'extension');
    const [html, js] = await Promise.all([
      fs.readFile(path.join(dir, 'popup.html'), 'utf8'),
      fs.readFile(path.join(dir, 'popup.js'), 'utf8')
    ]);
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toMatch(/000000|six[- ]digit|pairing code/i);
    expect(html).not.toMatch(/type=["'](?:text|number|password)["']/i);
    expect(js).not.toMatch(/\bcode\b/);
    // The message the worker understands carries no code either.
    expect(js).not.toMatch(/type: 'pair'[^}]*code/);
  });

  it('ships Overwrite on by default and keeps recorded activity timestamps always on', async () => {
    const dir = path.join(process.cwd(), 'extension');
    const [content, html, js] = await Promise.all([
      fs.readFile(path.join(dir, 'content.js'), 'utf8'),
      fs.readFile(path.join(dir, 'popup.html'), 'utf8'),
      fs.readFile(path.join(dir, 'popup.js'), 'utf8')
    ]);
    expect(content).toContain("const RENDER_STREAM_KEY = 'renderStreamEnabled';");
    expect(content).toContain('let RENDER_STREAM = TEST_MODE ? false : true;');
    expect(content).toContain('let SHOW_TIMES = TEST_MODE ? false : true;');
    expect(html).toContain('id="overwriteToggle"');
    expect(html).toContain('id="timeToggle" type="checkbox" checked disabled');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('id="overwriteBtn"');
    expect(js).toContain("const RENDER_STREAM_KEY = 'renderStreamEnabled';");
    expect(js).not.toContain("const SHOW_TIMES_KEY = 'showStreamTimes';");
    expect(js).not.toContain("$('timeToggle').addEventListener('change'");
    expect(js).toContain('chrome.storage.local.set');
    expect(js).toContain("type: 'overwriteNow'");
    expect(backgroundSource).toContain('patch.showStreamTimes = true;');
    expect(backgroundSource).toContain('durations: true');
    expect(backgroundSource).toContain('async overwriteNow()');
    expect(backgroundSource).toContain("chrome.tabs.sendMessage(id, { type: 'clf-overwrite-now' })");
  });
});

// ---------------------------------------------------------------------- DOM

const TURN_SELECTOR = 'section[data-testid^="conversation-turn"]';
const TOOL_SELECTOR = 'span[class*="tool-message"]';

class FakeNode {
  textContent = '';
  innerText = '';
  className = '';
  tagName = 'DIV';
  children: FakeNode[] = [];
  disabled = false;
  clicks = 0;
  private attrs = new Map<string, string>();
  private all = new Map<string, FakeNode[]>();
  private closestMatches = new Set<string>();

  constructor(attrs: Record<string, string> = {}, text = '') {
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value);
    this.textContent = text;
    this.innerText = text;
    this.className = attrs.class ?? '';
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.all.get(selector) ?? [];
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  with(selector: string, nodes: FakeNode[]): this {
    this.all.set(selector, nodes);
    return this;
  }

  under(selector: string): this {
    this.closestMatches.add(selector);
    return this;
  }

  closest(selector: string): FakeNode | null {
    return this.closestMatches.has(selector) ? this : null;
  }

  /** Flat fakes: a node only ever contains itself, which is all toolBlocks() asks. */
  contains(other: FakeNode): boolean {
    return other === this;
  }

  getClientRects(): Array<{ width: number; height: number }> {
    return [{ width: 100, height: 40 }];
  }

  click(): void {
    this.clicks += 1;
  }
}

/** A tool block as the live page renders it: a short header line and nothing else. */
function toolBlock(label = 'Called tool'): FakeNode {
  return new FakeNode({ class: 'pointer-events-none contents' }, label);
}

interface DomApi {
  conversationId(): string | null;
  conversationFromPath(pathname: unknown): string | null;
  turns(): Array<{ node: FakeNode; nodes: FakeNode[]; id: string | null; role: string | null }>;
  messages(): Array<{ id: string; role: string; text: string; turnId: string | null }>;
  progressLine(turn: unknown): string | null;
  interrupted(turn: unknown): boolean;
  markProgress(turn: unknown): number;
  hideProgress(turn: unknown, hidden: boolean): void;
  toolBlocks(turn: unknown): FakeNode[];
  errors(): string[];
}

function loadDom(
  sections: FakeNode[],
  pathname = '/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  extraSelectors: Record<string, FakeNode[]> = {}
): DomApi {
  const document = {
    querySelectorAll: (selector: string) => (selector === TURN_SELECTOR ? sections : extraSelectors[selector] ?? []),
    querySelector: () => null
  };
  const context = vm.createContext({ document, location: { pathname } });
  vm.runInContext(domSource, context, { filename: 'chatgpt-dom.js' });
  return (context as unknown as { CLF_DOM: DomApi }).CLF_DOM;
}

function turn(role: 'user' | 'assistant', id: string): FakeNode {
  return new FakeNode({ 'data-testid': 'conversation-turn-1', 'data-turn': role, 'data-turn-id': id });
}

describe('ChatGPT DOM adapter', () => {
  const CONVERSATION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  /**
   * Project conversations are routed under the project, and everything downstream — app
   * session, ownership registry, caller attribution — is keyed on the id this returns.
   * A shared snapshot is deliberately not a conversation this document can own.
   */
  it('recognises a conversation at the site root and inside a Project, and only those', () => {
    const dom = loadDom([]);
    for (const accepted of [
      `/c/${CONVERSATION}`,
      `/c/${CONVERSATION}/`,
      `/g/g-p-68abcdef1234/c/${CONVERSATION}`,
      `/g/g-p-68abcdef1234/c/${CONVERSATION}/`,
      `/g/g-abcdef/c/${CONVERSATION}`
    ]) {
      expect(dom.conversationFromPath(accepted), accepted).toBe(CONVERSATION);
    }

    for (const rejected of [
      '/',
      '/c/short',
      `/share/c/${CONVERSATION}`,
      `/share/${CONVERSATION}`,
      `/gpts/c/${CONVERSATION}`,
      `/g/g-p-one/g/g-p-two/c/${CONVERSATION}`
    ]) {
      expect(dom.conversationFromPath(rejected), rejected).toBeNull();
    }

    expect(dom.conversationFromPath(null)).toBeNull();
    expect(dom.conversationFromPath(undefined)).toBeNull();
  });

  it('reads the live route through that same parser', () => {
    expect(loadDom([], `/g/g-p-68abcdef1234/c/${CONVERSATION}`).conversationId()).toBe(CONVERSATION);
    expect(loadDom([], `/share/c/${CONVERSATION}`).conversationId()).toBeNull();
    expect(loadDom([], '/').conversationId()).toBeNull();
  });

  it('groups split assistant sections that share one data-turn-id before counting tool blocks', () => {
    const user = turn('user', 'user-1');
    const a1 = turn('assistant', 'request-1').with(TOOL_SELECTOR, [toolBlock(), toolBlock()]);
    const a2 = turn('assistant', 'request-1').with(TOOL_SELECTOR, [toolBlock(), toolBlock(), toolBlock()]);
    const dom = loadDom([user, a1, a2]);

    const turns = dom.turns();
    expect(turns).toHaveLength(2);
    const assistant = turns[1]!;
    expect(assistant.id).toBe('request-1');
    expect(assistant.nodes).toEqual([a1, a2]);
    expect(dom.toolBlocks(assistant)).toHaveLength(5);
  });

  /**
   * `div.pointer-events-none.contents` is a layout shape ChatGPT also uses for containers
   * that hold a whole answer. Counting one of those as a tool block inflates the block
   * count of the turn, which is exactly what the relabelling has to match against.
   */
  it('refuses a display-contents container that holds prose rather than a tool label', () => {
    const prose = toolBlock('a very long assistant answer').with('.markdown', [new FakeNode({}, 'answer')]);
    const real = toolBlock();
    const assistant = turn('assistant', 'request-3').with(TOOL_SELECTOR, [prose, real]);
    const dom = loadDom([assistant]);

    expect(dom.toolBlocks(dom.turns()[0]!)).toEqual([real]);
  });

  it('does not mistake ChatGPT transport-failure markdown for a completed assistant answer', () => {
    const failure = new FakeNode({}, 'Message delivery timed out. Please try again. Retry');
    const assistant = turn('assistant', 'request-failed')
      .with('[data-message-id]', [])
      .with('.markdown', [failure])
      .with('[data-interrupted="true"]', []);
    const dom = loadDom([assistant]);

    expect(dom.messages()).toEqual([]);
    // An occurrence, not a bare string: the node is what tells one showing of this banner
    // apart from the next, and the turn is what scopes it.
    expect(dom.errors()).toMatchObject([
      { text: 'Message delivery timed out. Please try again. Retry', node: failure, turnId: 'request-failed' }
    ]);
  });

  it('classifies and acknowledges only the exact visible account-throttle dialog', () => {
    const heading = new FakeNode({}, 'Too many requests');
    const button = new FakeNode({}, 'Got it');
    button.tagName = 'BUTTON';
    const dialog = new FakeNode({},
      "Too many requests You're making requests too quickly. We've temporarily limited access to your conversations to protect your data. Please wait a few minutes before trying again. Got it")
      .with('h1,h2,h3,[role="heading"]', [heading])
      .with('button', [button]);
    const dom = loadDom([], '/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      '[role="dialog"], [role="alertdialog"]': [dialog]
    });

    expect(dom.errors()).toMatchObject([
      { reason: 'access_throttle_notice', blocking: true, recoverable: false, node: dialog }
    ]);
    expect(button.clicks).toBe(1);
    // Re-observation may preserve the diagnostic, but it must not click the modal twice.
    dom.errors();
    expect(button.clicks).toBe(1);
  });

  it('records assistant prose from .markdown when ChatGPT supplies no assistant data-message-id', () => {
    const userMessage = new FakeNode(
      { 'data-message-id': 'user-message-1', 'data-message-author-role': 'user' },
      'do the thing'
    );
    const user = turn('user', 'user-1').with('[data-message-id]', [userMessage]);

    const liveProgress = new FakeNode({}, 'Reading files').under('[data-interrupted]');
    const finalA = new FakeNode({}, 'First paragraph');
    const finalB = new FakeNode({}, 'Second paragraph');
    const assistant = turn('assistant', 'request-2')
      .with('[data-message-id]', [])
      .with('.markdown', [liveProgress, finalA, finalB])
      .with('[data-interrupted="true"]', []);

    const messages = loadDom([user, assistant]).messages();
    // toMatchObject rather than toEqual: each message also carries the section it was read
    // from, which is what lets the content script tell a message left behind by a chat it
    // has navigated away from apart from one belonging to the chat it is on now.
    expect(messages).toMatchObject([
      { id: 'user-message-1', role: 'user', text: 'do the thing', turnId: 'user-1', interrupted: false, node: user },
      {
        id: 'assistant:request-2',
        role: 'assistant',
        text: 'Second paragraph',
        turnId: 'request-2',
        interrupted: false,
        node: assistant
      }
    ]);
    expect(messages).toHaveLength(2);
  });

  it('marks only the observed progress containers so the overlay can make them legible', () => {
    const firstBox = new FakeNode({ 'data-interrupted': 'true' }, 'Thinking');
    const secondBox = new FakeNode({ 'data-interrupted': 'true' }, 'Running tests');
    const a1 = turn('assistant', 'request-progress').with('[data-interrupted]', [firstBox]);
    const a2 = turn('assistant', 'request-progress').with('[data-interrupted]', [secondBox]);
    const dom = loadDom([a1, a2]);
    const logical = dom.turns()[0]!;
    expect(dom.markProgress(logical)).toBe(2);
    expect(firstBox.getAttribute('data-clf-progress')).toBe('1');
    expect(secondBox.getAttribute('data-clf-progress')).toBe('1');
    expect(dom.markProgress(logical)).toBe(0);
  });

  it('never hides a progress container that ChatGPT has put the answer inside', () => {
    // ChatGPT reparents the finished prose into a data-interrupted box on some turns.
    // Hiding by the attribute alone therefore hid the answer as well, which is what left
    // completed turns showing "Worked for 45s" over an empty gap with no way to get the
    // text back. Commentary is replaceable; the answer is not.
    const commentary = new FakeNode({ 'data-interrupted': 'false' }, 'Reading files');
    const answer = new FakeNode({ 'data-interrupted': 'false' }, 'Here is the summary');
    answer.with('.markdown', [new FakeNode({ class: 'markdown' }, 'Here is the summary')]);
    const section = turn('assistant', 'request-answer').with('[data-interrupted]', [commentary, answer]);
    const dom = loadDom([section]);
    const logical = dom.turns()[0]!;

    dom.hideProgress(logical, true);
    expect(commentary.getAttribute('data-clf-native-hidden')).toBe('1');
    expect(answer.getAttribute('data-clf-native-hidden')).toBeNull();

    dom.hideProgress(logical, false);
    expect(commentary.getAttribute('data-clf-native-hidden')).toBeNull();
  });

  it('reads every progress container of the turn, in order, rather than only the last', () => {
    const firstBox = new FakeNode({ 'data-interrupted': 'true' }, 'Thinking\nReading files');
    const secondBox = new FakeNode({ 'data-interrupted': 'true' }, 'Running tool\nRunning tests');
    const a1 = turn('assistant', 'request-3')
      .with('[data-interrupted]', [firstBox])
      .with('[data-interrupted="true"]', [firstBox]);
    const a2 = turn('assistant', 'request-3')
      .with('[data-interrupted]', [secondBox])
      .with('[data-interrupted="true"]', [secondBox]);
    const dom = loadDom([a1, a2]);
    const logical = dom.turns()[0]!;

    // Taking only the newest box made this value shrink whenever ChatGPT grew a new one,
    // and a shrink reads as new text to the delta logic, which printed it all over again.
    expect(dom.progressLine(logical)).toBe('Thinking\nReading files\nRunning tool\nRunning tests');
    expect(dom.interrupted(logical)).toBe(true);
  });
});

// --------------------------------------------------------------- service worker

class FakeStorageArea {
  data: Record<string, unknown>;
  /** Optional quota used to make writes fail the way Chrome does. */
  maxBytes: number | null = null;
  /** Deterministic transient write failure seam for durability/restart regressions. */
  failNextSets = 0;
  /**
   * Optional read latency, in milliseconds.
   *
   * Chrome answers a read from another process, so a read is not instant and two readers
   * do not advance in lockstep. The snapshot is still taken when the read is *issued* —
   * that is the whole point of modelling it: a read issued before someone else's write
   * can be answered after it, and then it carries stale data into live state.
   */
  lagMs = 0;
  /** Per-write completion delay; the snapshot is taken before waiting, like an async IPC write. */
  setDelays: number[] = [];
  private setCount = 0;

  constructor(initial: Record<string, unknown> = {}) {
    this.data = structuredClone(initial);
  }

  async get(keys: string[] | string | null): Promise<Record<string, unknown>> {
    const wanted = keys === null ? Object.keys(this.data) : Array.isArray(keys) ? keys : [keys];
    const snapshot = Object.fromEntries(
      wanted.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])])
    );
    if (this.lagMs > 0) await new Promise((resolve) => setTimeout(resolve, this.lagMs));
    return snapshot;
  }

  async set(values: Record<string, unknown>): Promise<void> {
    if (this.failNextSets > 0) {
      this.failNextSets--;
      throw new Error('synthetic storage write failure');
    }
    const next = { ...this.data, ...structuredClone(values) };
    if (this.maxBytes !== null && Buffer.byteLength(JSON.stringify(next), 'utf8') > this.maxBytes) {
      throw new Error('QUOTA_BYTES exceeded');
    }
    const delay = this.setDelays[this.setCount++] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    this.data = next;
  }

  async remove(keys: string[] | string): Promise<void> {
    const removed = new Set(Array.isArray(keys) ? keys : [keys]);
    this.data = Object.fromEntries(Object.entries(this.data).filter(([key]) => !removed.has(key)));
  }
}

interface WorkerHarness {
  send(message: Record<string, unknown>, tabId?: number, documentId?: string, senderUrl?: string): Promise<any>;
  /** Fires Chrome's real tab-close lifecycle event. */
  closeTab(tabId: number, removeInfo?: { windowId?: number; isWindowClosing?: boolean }): Promise<void>;
  /** Fires only Chrome's navigation-start signal, without inventing a replacement document. */
  startTabNavigation(tabId: number, url?: string): Promise<void>;
  /** Completes navigation with no URL, as Chrome does outside granted hosts. */
  completeTabNavigation(tabId: number): Promise<void>;
  /** Fires Chrome's tab URL-change lifecycle event. */
  navigateTab(tabId: number, url: string): Promise<void>;
  /** Fires a same-document pushState without claiming a replacement document. */
  changeTabUrl(tabId: number, url: string): Promise<void>;
  /** Fires the extension install/update lifecycle event. */
  installed(reason?: string): Promise<void>;
  /** Fires Chrome's whole-browser startup lifecycle event. */
  startBrowser(): Promise<void>;
  /** Fires the periodic maintenance alarm this worker schedules for itself. */
  fireAlarm(name?: string): Promise<void>;
  /** Registers the browser document that owns subsequent tab-scoped messages. */
  registerTab(tabId: number, documentId?: string, senderUrl?: string): Promise<any>;
  /** Fires Chrome's tab-created lifecycle event, the way opening a link in a new tab does. */
  createTab(tab: { id: number; url?: string; pendingUrl?: string; autoDiscardable?: boolean; discarded?: boolean; active?: boolean }): Promise<void>;
  tabsCreate: ReturnType<typeof vi.fn>;
  tabsQuery: ReturnType<typeof vi.fn>;
  tabsUpdate: ReturnType<typeof vi.fn>;
  tabsSendMessage: ReturnType<typeof vi.fn>;
  tabsRemove: ReturnType<typeof vi.fn>;
  tabsReload: ReturnType<typeof vi.fn>;
  runtimeReload: ReturnType<typeof vi.fn>;
  windowsUpdate: ReturnType<typeof vi.fn>;
  scriptingExecuteScript: ReturnType<typeof vi.fn>;
  scriptingInsertCSS: ReturnType<typeof vi.fn>;
  alarmCreate: ReturnType<typeof vi.fn>;
  alarmClear: ReturnType<typeof vi.fn>;
}

function response(status: number, data: unknown) {
  const body =
    data && typeof data === 'object' && (data as Record<string, unknown>).app === 'chat-on-steroids'
      ? { bridge: EXTENSION_BRIDGE_PROTOCOL, compatible: true, ...structuredClone(data as Record<string, unknown>) }
      : structuredClone(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    }
  };
}

function loadWorker(options: {
  local: FakeStorageArea;
  session: FakeStorageArea;
  fetch?: (input: string, init?: Record<string, unknown>) => Promise<ReturnType<typeof response>>;
  tabsGet?: (tabId: number) => Promise<{ id?: number; url?: string; pendingUrl?: string; status?: string; autoDiscardable?: boolean; discarded?: boolean }>;
  tabsQuery?: (query?: Record<string, unknown>) => Promise<
    Array<{ id?: number; windowId?: number; url?: string; pendingUrl?: string; status?: string; autoDiscardable?: boolean; discarded?: boolean; active?: boolean }>
  >;
  tabsCreate?: (properties: Record<string, unknown>) => Promise<Record<string, unknown>>;
  tabsUpdate?: (tabId: number, properties: Record<string, unknown>) => Promise<Record<string, unknown>>;
  tabsSendMessage?: (tabId: number, message: Record<string, unknown>) => Promise<unknown>;
  windowsGet?: (windowId: number) => Promise<{ id?: number; focused?: boolean; state?: string }>;
  windowsUpdate?: (windowId: number, properties: Record<string, unknown>) => Promise<Record<string, unknown>>;
  WebSocket?: unknown;
  browserController?: { revoke(): Promise<void>; ready?(): Promise<void>; pump?(): Promise<void> };
}): WorkerHarness {
  let listener: ((message: any, sender: any, sendResponse: (value: any) => void) => boolean) | null = null;
  const tabRemovedListeners: Array<(tabId: number, removeInfo?: { windowId?: number; isWindowClosing?: boolean }) => void> = [];
  const tabCreatedListeners: Array<(tab: { id?: number; url?: string; pendingUrl?: string }) => void> = [];
  const tabUpdatedListeners: Array<(tabId: number, changeInfo: { url?: string; status?: string }) => void> = [];
  const installedListeners: Array<(details: { reason: string }) => void> = [];
  const startupListeners: Array<() => void> = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const knownTabs = new Map<
    number,
    { id: number; windowId: number; url?: string; pendingUrl?: string; status?: string; autoDiscardable?: boolean; discarded?: boolean; active?: boolean }
  >();
  const tabsCreate = vi.fn(options.tabsCreate ?? (async ({ url }: { url?: string } = {}) => {
    knownTabs.set(99, { id: 99, windowId: 7, ...(url ? { url } : {}), status: 'loading' });
    return { id: 99, windowId: 7, ...(url ? { url } : {}), status: 'loading' };
  }));
  const removedTabs = new Set<number>();
  const queryTabs = options.tabsQuery ?? (async () => [...knownTabs.values()]);
  const matchesUrlPattern = (value: unknown, pattern: string) => {
    if (typeof value !== 'string') return false;
    return pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
  };
  const tabsQuery = vi.fn(async (query?: Record<string, unknown>) => {
    const urls = Array.isArray(query?.url) ? query.url.filter((value): value is string => typeof value === 'string') : [];
    return (await queryTabs(query)).filter(tab =>
      (!Number.isInteger(tab.id) || !removedTabs.has(tab.id!)) &&
      (!urls.length || urls.some(pattern => matchesUrlPattern(tab.url, pattern)))
    );
  });
  const tabsUpdate = vi.fn(options.tabsUpdate ?? (async (id: number, properties: { autoDiscardable?: boolean; active?: boolean } = {}) => {
    const tab = knownTabs.get(id);
    if (tab && typeof properties.autoDiscardable === 'boolean') tab.autoDiscardable = properties.autoDiscardable;
    if (tab && typeof properties.active === 'boolean') tab.active = properties.active;
    if (tab && typeof (properties as { url?: unknown }).url === 'string') tab.url = (properties as { url: string }).url;
    return { id, windowId: 7, ...properties };
  }));
  const tabsSendMessage = vi.fn(options.tabsSendMessage ?? (async () => ({ ok: true })));
  const tabsRemove = vi.fn(async (id: number) => { removedTabs.add(id); knownTabs.delete(id); });
  const tabsReload = vi.fn(async (id: number) => {
    const tab = knownTabs.get(id);
    if (tab) tab.discarded = false;
  });
  const runtimeReload = vi.fn();
  const scriptingExecuteScript = vi.fn(async () => []);
  const scriptingInsertCSS = vi.fn(async () => undefined);
  const alarmCreate = vi.fn(() => undefined);
  const alarmClear = vi.fn(async () => true);
  const windowsUpdate = vi.fn(options.windowsUpdate ?? (async () => ({ id: 7 })));
  const documentNumbers = new Map<number, number>();
  const currentDocuments = new Map<number, string>();
  const documentFor = (tabId: number): string => {
    const current = currentDocuments.get(tabId);
    if (current) return current;
    const created = `document-${tabId}-0`;
    currentDocuments.set(tabId, created);
    documentNumbers.set(tabId, 0);
    return created;
  };
  const chrome = {
    ...(options.browserController?.pump ? { debugger: {
      onEvent: { addListener() {} }, onDetach: { addListener() {} }
    } } : {}),
    storage: { local: options.local, session: options.session },
    runtime: {
      id: 'fcckeonnadegkheflpbppbddkpkdhjip',
      reload: runtimeReload,
      getManifest: () => ({ version: '1.6.0' }),
      onMessage: {
        addListener(fn: typeof listener) {
          listener = fn;
        }
      },
      onInstalled: {
        addListener(fn: (details: { reason: string }) => void) {
          installedListeners.push(fn);
        }
      },
      onStartup: {
        addListener(fn: () => void) {
          startupListeners.push(fn);
        }
      }
    },
    windows: { update: windowsUpdate, get: options.windowsGet ?? (async (id: number) => ({ id, type: 'normal', incognito: false, focused: true })) },
    scripting: {
      executeScript: scriptingExecuteScript,
      insertCSS: scriptingInsertCSS
    },
    alarms: {
      create: alarmCreate,
      clear: alarmClear,
      onAlarm: {
        addListener(fn: (alarm: { name: string }) => void) {
          alarmListeners.push(fn);
        }
      }
    },
    tabs: {
      create: tabsCreate,
      query: tabsQuery,
      update: tabsUpdate,
      get: options.tabsGet ?? vi.fn(async () => {
        throw new Error('tab state unavailable in this harness');
      }),
      sendMessage: tabsSendMessage,
      remove: tabsRemove,
      reload: tabsReload,
      onCreated: {
        addListener(fn: (tab: { id?: number; url?: string; pendingUrl?: string }) => void) {
          tabCreatedListeners.push(fn);
        }
      },
      onRemoved: {
        addListener(fn: (tabId: number, removeInfo?: { windowId?: number; isWindowClosing?: boolean }) => void) {
          tabRemovedListeners.push(fn);
        }
      },
      onUpdated: {
        addListener(fn: (tabId: number, changeInfo: { url?: string; status?: string }) => void) {
          tabUpdatedListeners.push(fn);
        }
      }
    }
  };
  const fetch = options.fetch ?? (async () => response(503, {}));
  // This legacy VM harness exercises non-debugger hosts. The real MV3 entry fixture loads the
  // module graph separately; strip static imports here because vm.runInNewContext is a script.
  vm.runInNewContext(backgroundSource.replace(/^import .*$/gm, '') + '\nif (testBrowserController) browserController = Promise.resolve(testBrowserController);', {
    chrome,
    fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    URL,
    URLSearchParams,
    TextEncoder,
    performance,
    crypto: webcrypto,
    WebSocket: options.WebSocket,
    testBrowserController: options.browserController,
    console
  }, { filename: 'background.js' });
  if (!listener) throw new Error('background.js did not register a message listener');

  return {
    tabsCreate,
    tabsQuery,
    tabsUpdate,
    tabsSendMessage,
    tabsRemove,
    tabsReload,
    runtimeReload,
    windowsUpdate,
    scriptingExecuteScript,
    scriptingInsertCSS,
    alarmCreate,
    alarmClear,
    async fireAlarm(name = 'clf-bridge-drain') {
      for (const fn of alarmListeners) fn({ name });
      for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async installed(reason = 'update') {
      for (const fn of installedListeners) fn({ reason });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async startBrowser() {
      for (const fn of startupListeners) fn();
      for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async createTab(tab: { id: number; url?: string; pendingUrl?: string; autoDiscardable?: boolean; discarded?: boolean; active?: boolean }) {
      removedTabs.delete(tab.id);
      knownTabs.set(tab.id, {
        id: tab.id,
        windowId: 7,
        ...(tab.url ? { url: tab.url } : {}),
        ...(tab.pendingUrl ? { pendingUrl: tab.pendingUrl } : {}),
        status: 'complete',
        autoDiscardable: tab.autoDiscardable ?? true,
        ...(typeof tab.discarded === 'boolean' ? { discarded: tab.discarded } : {}),
        ...(typeof tab.active === 'boolean' ? { active: tab.active } : {})
      });
      for (const fn of tabCreatedListeners) fn(tab);
      for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async closeTab(tabId: number, removeInfo = { windowId: 7, isWindowClosing: false }) {
      knownTabs.delete(tabId);
      for (const fn of tabRemovedListeners) fn(tabId, removeInfo);
      for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async startTabNavigation(tabId: number, url?: string) {
      for (const fn of tabUpdatedListeners) fn(tabId, { ...(url ? { url } : {}), status: 'loading' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async completeTabNavigation(tabId: number) {
      for (const fn of tabUpdatedListeners) fn(tabId, { status: 'complete' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    registerTab(tabId, documentId = documentFor(tabId)) {
      return new Promise((resolve, reject) => {
        try {
          const keep = listener!(
            { type: 'register_document' },
            { tab: { id: tabId }, documentId, frameId: 0 },
            resolve
          );
          if (keep !== true) reject(new Error('listener did not keep the response channel open'));
        } catch (err) {
          reject(err);
        }
      });
    },
    async changeTabUrl(tabId: number, url: string) {
      knownTabs.set(tabId, { id: tabId, windowId: 7, url, status: 'complete' });
      for (const fn of tabUpdatedListeners) fn(tabId, { url });
      for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 0));
    },
    async navigateTab(tabId: number, url: string) {
      knownTabs.set(tabId, { id: tabId, windowId: 7, url });
      const chatGpt = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/i.test(url);
      for (const fn of tabUpdatedListeners) fn(tabId, { url, ...(chatGpt ? { status: 'loading' } : {}) });
      let newDocument: string | null = null;
      if (chatGpt) {
        const next = (documentNumbers.get(tabId) ?? 0) + 1;
        documentNumbers.set(tabId, next);
        newDocument = `document-${tabId}-${next}`;
        currentDocuments.set(tabId, newDocument);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Static content injection registers the new ChatGPT document before its normal page
      // traffic. Model that handshake here rather than letting a later bind implicitly clear
      // a terminal lease.
      if (newDocument) {
        await new Promise((resolve, reject) => {
          try {
            const keep = listener!(
              { type: 'register_document' },
              { tab: { id: tabId }, documentId: newDocument, frameId: 0 },
              resolve
            );
            if (keep !== true) reject(new Error('listener did not keep the response channel open'));
          } catch (err) {
            reject(err);
          }
        });
      }
    },
    send(message, tabId = 1, documentId = documentFor(tabId), senderUrl) {
      if (message.type === 'bind' && typeof message.conversationId === 'string') {
        knownTabs.set(tabId, {
          ...knownTabs.get(tabId),
          id: tabId,
          windowId: 7,
          url: `https://chatgpt.com/c/${message.conversationId}`,
          autoDiscardable: knownTabs.get(tabId)?.autoDiscardable ?? true
        });
      }
      return new Promise((resolve, reject) => {
        try {
          const keep = listener!(message, { tab: { id: tabId }, documentId, frameId: 0, url: senderUrl }, resolve);
          if (keep !== true) reject(new Error('listener did not keep the response channel open'));
        } catch (err) {
          reject(err);
        }
      });
    }
  };
}

function journalOf(session: FakeStorageArea): any[] {
  const value = session.data.journal;
  return Array.isArray(value) ? value : [];
}

describe('custody-preserving companion reload', () => {
  const popupUrl = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
  const conversationId = '11111111-2222-3333-4444-555555555555';
  const idle = () => ({ ok: true, epoch: 0, runId: 'reload-page', conversationId,
    streaming: false, generating: false, pendingTools: 0, jobBusy: false, goalBusy: false,
    projectCreateBusy: false, pluginRefreshBusy: false, modelCatalogBusy: false,
    desktopInputBusy: false, composerOccupied: false, queued: 0, queueBytes: 0 });
  const request = (worker: WorkerHarness) => worker.send({ type: 'reloadCompanion' }, 99, 'popup', popupUrl);

  it('publishes all three existing outboxes to Main before reloading, without changing their identities', async () => {
    const receipt = { kind: 'input', id: 'original-input', owner: 'original-document',
      conversationId, messageId: 'original-native-message', queuedAt: Date.now() };
    const close = { conversationId: '99999999-2222-3333-4444-555555555555', queuedAt: Date.now() };
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token', instanceId: 'profile-reload',
      closeOutbox: [close], commandAckOutbox: [receipt] });
    const session = new FakeStorageArea();
    let healthy = false;
    const received: Array<{ route: string; body: any }> = [];
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const route = new URL(input).pathname;
      if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true, instanceId: 'profile-reload' });
      if (['/events', '/input/ack', '/closed'].includes(route)) {
        if (!healthy) return response(503, {});
        received.push({ route, body: JSON.parse(String(init.body)) });
        return response(200, { ok: true });
      }
      return response(404, {});
    } });
    await worker.send({ type: 'events', conversationId, entries: [{ conversationId,
      event: { kind: 'progress', time: 1, text: 'original retained observation' } }] });
    expect(journalOf(session)).toHaveLength(1);
    healthy = true;
    expect(await request(worker)).toMatchObject({ ok: true, reloading: true });
    expect(received.map(entry => entry.route)).toEqual(['/input/ack', '/events', '/closed']);
    expect(received[0]?.body).toMatchObject({ id: receipt.id, owner: receipt.owner, messageId: receipt.messageId });
    expect(received[1]?.body).toMatchObject({ conversationId, events: [{ kind: 'progress', text: 'original retained observation' }] });
    expect(received[2]?.body).toMatchObject({ conversationId: close.conversationId });
    expect(journalOf(session)).toEqual([]);
    expect(local.data.commandAckOutbox).toEqual([]);
    expect(local.data.closeOutbox).toEqual([]);
    expect(worker.runtimeReload).toHaveBeenCalledTimes(1);
    expect(local.data.instanceId).toBe('profile-reload');
  });

  it('keeps a failed observation delivery and never reloads or claims it sent', async () => {
    const session = new FakeStorageArea();
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session,
      fetch: async input => new URL(input).pathname === '/hello'
        ? response(200, { app: 'chat-on-steroids', paired: true }) : response(503, {}) });
    await worker.send({ type: 'events', conversationId, entries: [{ conversationId,
      event: { kind: 'progress', time: 1, text: 'must survive' } }] });
    const before = structuredClone(journalOf(session));
    expect(await request(worker)).toMatchObject({ ok: false, error: 'reload_deferred', pendingWork: { journal: 1 } });
    expect(journalOf(session)).toEqual(before);
    expect(worker.runtimeReload).not.toHaveBeenCalled();
  });

  it('joins an already-running journal delivery instead of mistaking normal drain acknowledgement for completion', async () => {
    let healthy = false, started = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const session = new FakeStorageArea();
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session,
      fetch: async input => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/events' && healthy) { started = true; await gate; return response(200, { ok: true }); }
        return response(503, {});
      } });
    await worker.send({ type: 'events', conversationId, entries: [{ conversationId,
      event: { kind: 'progress', time: 1, text: 'in-flight exact journal' } }] });
    healthy = true;
    await worker.send({ type: 'status' });
    await vi.waitFor(() => expect(started).toBe(true));
    const reloading = request(worker);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(worker.runtimeReload).not.toHaveBeenCalled();
    expect(journalOf(session)).toHaveLength(1);
    release();
    expect(await reloading).toMatchObject({ ok: true, reloading: true });
    expect(journalOf(session)).toEqual([]);
    expect(worker.runtimeReload).toHaveBeenCalledTimes(1);
  });

  it.each(['idle', 'streaming', 'draft', 'helper', 'unobservable'])('retains every open ChatGPT page, including %s pages, without mistaking an observation for a quiescence lock', async reason => {
    const worker = loadWorker({ local: new FakeStorageArea({ disconnected: true }), session: new FakeStorageArea(),
      tabsSendMessage: async () => { if (reason === 'unobservable') throw new Error('no content receiver'); return idle(); } });
    await worker.send({ type: 'bind', conversationId });
    expect(await request(worker)).toMatchObject({ ok: false, error: 'reload_deferred', pendingWork: { openChatgptTabs: 1 } });
    expect(worker.runtimeReload).not.toHaveBeenCalled();
    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(worker.tabsSendMessage.mock.calls.some(([, message]) => message.type === 'clf-tab-close-check')).toBe(false);
  });

  it('reloads an empty account only after two fresh zero-document inventories', async () => {
    const worker = loadWorker({ local: new FakeStorageArea({ disconnected: true }), session: new FakeStorageArea() });
    await worker.send({ type: 'drain' });
    const before = worker.tabsQuery.mock.calls.length;
    expect(await request(worker)).toMatchObject({ ok: true, reloading: true });
    expect(worker.tabsQuery.mock.calls.length - before).toBeGreaterThanOrEqual(2);
    expect(worker.runtimeReload).toHaveBeenCalledTimes(1);
    expect(worker.tabsRemove).not.toHaveBeenCalled();
  });


  it.each([
    ['initial', 1, 'about:blank', 'https://chatgpt.com/'],
    ['final', 2, 'about:blank', 'https://chatgpt.com/'],
    ['initial', 1, 'https://example.com/', 'https://chatgpt.com/c/' + conversationId],
    ['final', 2, 'https://example.com/', 'https://chatgpt.com/c/' + conversationId],
    ['initial', 1, '', 'https://chat.openai.com/c/' + conversationId],
    ['final', 2, '', 'https://chat.openai.com/c/' + conversationId]
  ] as const)('retains a ChatGPT navigation before commit at the %s reload inventory (%s, %s -> %s)', async (_phase, after, url, pendingUrl) => {
    let armed = false, inventories = 0;
    const worker = loadWorker({ local: new FakeStorageArea({ disconnected: true }), session: new FakeStorageArea(),
      tabsQuery: async () => armed && ++inventories >= after
        ? [{ id: 73, url, pendingUrl, status: 'loading' }] : [] });
    await worker.send({ type: 'drain' });
    armed = true;
    expect(await request(worker)).toMatchObject({ ok: false, error: 'reload_deferred',
      pendingWork: { openChatgptTabs: 1 } });
    expect(inventories).toBe(after);
    expect(worker.runtimeReload).not.toHaveBeenCalled();
    expect(worker.tabsRemove).not.toHaveBeenCalled();
  });

  it.each([
    ['https://chatgpt.com/', 'https://example.com/away', false],
    ['https://example.com/', 'https://chatgpt.com.evil.invalid/', true],
    ['about:blank', 'https://example.com/', true],
    ['https://example.com/', 'http://chatgpt.com/', true]
  ] as const)('classifies reload inventory by committed and pending supported origins (%s -> %s)', async (url, pendingUrl, allowed) => {
    let armed = false;
    const worker = loadWorker({ local: new FakeStorageArea({ disconnected: true }), session: new FakeStorageArea(),
      tabsQuery: async () => armed ? [{ id: 74, url, pendingUrl, status: 'loading' }] : [] });
    await worker.send({ type: 'drain' });
    armed = true;
    const reply = await request(worker);
    expect(reply).toMatchObject(allowed ? { ok: true, reloading: true }
      : { ok: false, error: 'reload_deferred', pendingWork: { openChatgptTabs: 1 } });
    expect(worker.runtimeReload).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(worker.tabsRemove).not.toHaveBeenCalled();
  });

  it('preserves a durable tab identity lease and generation through safe reload and worker restart', async () => {
    const generation = 'a'.repeat(32), lease = `${generation}_already-issued-command-lease`;
    const local = new FakeStorageArea({ disconnected: true, commandLeaseGeneration: generation, commandTabLeases: { '1': lease } });
    const session = new FakeStorageArea();
    const sendMessage = async (_id: number, message: Record<string, unknown>) => message.type === 'clf-page-status' ? idle()
      : { safe: true, conversationId, navigationEpoch: 0 };
    const worker = loadWorker({ local, session, tabsSendMessage: sendMessage });
    await worker.send({ type: 'drain' });
    expect(await request(worker)).toMatchObject({ ok: true, reloading: true });
    expect(local.data.commandTabLeases).toEqual({ '1': lease });
    expect(local.data.commandLeaseGeneration).toBe(generation);
    const restarted = loadWorker({ local, session: new FakeStorageArea(), tabsSendMessage: sendMessage });
    await restarted.send({ type: 'drain' });
    expect(await request(restarted)).toMatchObject({ ok: true, reloading: true });
    expect(local.data.commandTabLeases).toEqual({ '1': lease });
    expect(local.data.commandLeaseGeneration).toBe(generation);
  });

  it.each(['read-failed', 'missing-key', 'wrong-generation', 'wrong-map'])('defers when retained identity-lease durability is %s', async reason => {
    const generation = 'b'.repeat(32), lease = `${generation}_retained-identity-lease`;
    const local = new FakeStorageArea({ disconnected: true, commandLeaseGeneration: generation, commandTabLeases: { '1': lease } });
    const worker = loadWorker({ local, session: new FakeStorageArea(),
      tabsSendMessage: async (_id, message) => message.type === 'clf-page-status' ? idle()
        : { safe: true, conversationId, navigationEpoch: 0 } });
    await worker.send({ type: 'drain' });
    const get = local.get.bind(local);
    local.get = async keys => {
      if (Array.isArray(keys) && keys.length === 2 && keys.includes('commandTabLeases')) {
        if (reason === 'read-failed') throw new Error('PRIVATE_STORAGE_ERROR');
        const stored = await get(keys);
        if (reason === 'missing-key') delete stored.commandTabLeases;
        if (reason === 'wrong-generation') stored.commandLeaseGeneration = 'c'.repeat(32);
        if (reason === 'wrong-map') stored.commandTabLeases = { '1': 'another-retained-lease' };
        return stored;
      }
      return get(keys);
    };
    const reply = await request(worker);
    expect(reply).toMatchObject({ ok: false, error: 'reload_deferred', pendingWork: { leaseDurabilityUnverified: 1 } });
    expect(JSON.stringify(reply)).not.toContain('PRIVATE_STORAGE_ERROR');
    expect(local.data.commandTabLeases).toEqual({ '1': lease });
    expect(worker.runtimeReload).not.toHaveBeenCalled();
  });

  it.each(['new-journal', 'new-tab', 'new-lease', 'connection-change', 'inventory-error'])('rechecks custody when %s appears during the final zero-document inventory', async reason => {
    const generation = 'd'.repeat(32), lease = `${generation}_original-identity-lease`;
    const local = new FakeStorageArea({ disconnected: true, commandLeaseGeneration: generation, commandTabLeases: { '1': lease } });
    const session = new FakeStorageArea();
    let injected = false, armed = false, inventories = 0;
    let worker!: WorkerHarness;
    worker = loadWorker({ local, session, tabsQuery: async () => {
      if (armed && ++inventories === 2) {
        injected = true;
        if (reason === 'new-journal') await worker.send({ type: 'events', conversationId,
          entries: [{ conversationId, event: { kind: 'progress', time: 2, text: 'late retained event' } }] });
        if (reason === 'new-tab') return [{ id: 1, url: `https://chatgpt.com/c/${conversationId}` }];
        if (reason === 'new-lease') {
          await worker.registerTab(2);
          await worker.send({ type: 'redeem', id: 'late-command', client: 'late-document' }, 2);
        }
        if (reason === 'connection-change') await worker.send({ type: 'unpair' });
        if (reason === 'inventory-error') throw new Error('PRIVATE_INVENTORY_FAILURE');
      }
      return [];
    } });
    await worker.send({ type: 'drain' });
    armed = true;
    expect(await request(worker)).toMatchObject({ ok: false, error: 'reload_deferred' });
    expect(injected).toBe(true);
    expect(worker.runtimeReload).not.toHaveBeenCalled();
    if (reason === 'new-journal') expect(journalOf(session)).toHaveLength(1);
    if (reason === 'new-lease') expect(Object.keys(local.data.commandTabLeases as object)).toHaveLength(2);
  });

  it.each(['projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner', 'read-failed', 'read-timeout', 'late-owner'])('does not let a durable identity lease skip retained-owner verification (%s)', async reason => {
    const generation = 'e'.repeat(32), lease = `${generation}_durable-identity-lease`;
    const local = new FakeStorageArea({ disconnected: true, commandLeaseGeneration: generation, commandTabLeases: { '1': lease } });
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    await worker.send({ type: 'drain' });
    const get = session.get.bind(session);
    let ownerReads = 0;
    session.get = async keys => {
      if (Array.isArray(keys) && keys.length === 3 && keys.includes('modelCatalogOwner')) {
        ownerReads++;
        if (reason === 'read-failed') throw new Error('PRIVATE_OWNER_READ_FAILURE');
        if (reason === 'read-timeout') return new Promise(() => undefined);
        if (reason === 'late-owner' && ownerReads === 2) return { projectCreateOwner: { id: 'late-helper-owner' } };
        if (!reason.startsWith('read-') && reason !== 'late-owner') return { [reason]: { id: 'retained-helper-owner' } };
      }
      return get(keys);
    };
    const reply = await request(worker);
    const key = reason === 'read-failed' ? 'ownerReadFailed' : reason === 'read-timeout' ? 'ownerReadTimedOut'
      : reason === 'late-owner' ? 'projectCreateOwner' : reason;
    expect(reply).toMatchObject({ ok: false, error: 'reload_deferred', pendingWork: { [key]: 1 } });
    expect(JSON.stringify(reply)).not.toMatch(/PRIVATE_|helper-owner/);
    expect(local.data.commandTabLeases).toEqual({ '1': lease });
    expect(worker.runtimeReload).not.toHaveBeenCalled();
  });

  it.each(['/input/ack', '/closed'])('retains an unaccepted %s receipt instead of reloading', async failedRoute => {
    const receipt = { kind: 'input', id: 'original-input', owner: 'original-document',
      conversationId, messageId: 'original-native-message', queuedAt: Date.now() };
    const close = { conversationId, queuedAt: Date.now() };
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token', instanceId: 'profile-reload',
      ...(failedRoute === '/input/ack' ? { commandAckOutbox: [receipt] } : { closeOutbox: [close] }) });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: async input => new URL(input).pathname === '/hello'
      ? response(200, { app: 'chat-on-steroids', paired: true, instanceId: 'profile-reload' }) : response(503, {}) });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await request(worker)).toMatchObject({ ok: false, error: 'reload_deferred' });
    expect(local.data[failedRoute === '/input/ack' ? 'commandAckOutbox' : 'closeOutbox']).toEqual([failedRoute === '/input/ack' ? receipt : close]);
    expect(worker.runtimeReload).not.toHaveBeenCalled();
  });

  it('keeps the session-only owned removal receipt until tabs.onRemoved has handed it to its existing close owner', async () => {
    const receipt = { tab: 41, documentId: 'removed-document', navigationEpoch: 2, conversationId, phase: 'issued' };
    const session = new FakeStorageArea({ automaticTabRetirements: { '41': receipt } });
    const worker = loadWorker({ local: new FakeStorageArea({ disconnected: true }), session });
    expect(await request(worker)).toMatchObject({ ok: false, error: 'reload_deferred', pendingWork: { tabCloseReceipts: 1 } });
    expect(session.data.automaticTabRetirements).toEqual({ '41': receipt });
    expect(worker.runtimeReload).not.toHaveBeenCalled();
  });

  it('holds new maintenance, urgent-open and browser-control admission during the final inventory, then allows normal wake after deferral', async () => {
    let socket!: { onmessage?: (event: { data: string }) => void };
    class WakeSocket {
      readyState = 1;
      onmessage?: (event: { data: string }) => void;
      constructor(readonly url: string) { socket = this; }
      send() {}
      close() { this.readyState = 3; }
    }
    let finalInventory!: () => void, release!: () => void, armed = false, inventories = 0, statusReads = 0;
    const entered = new Promise<void>(resolve => { finalInventory = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pump = vi.fn(async () => undefined);
    const session = new FakeStorageArea();
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session,
      browserController: { revoke: async () => undefined, ready: async () => undefined, pump }, WebSocket: WakeSocket,
      tabsQuery: async () => {
        if (armed && ++inventories === 2) { finalInventory(); await gate; return [{ id: 1, url: `https://chatgpt.com/c/${conversationId}` }]; }
        return [];
      },
      fetch: async input => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/status') { statusReads++; return response(200, { ok: true, repairs: [], recoveryMonitoring: false }); }
        return response(200, { ok: true });
      } });
    await worker.send({ type: 'events', conversationId, entries: [{ conversationId,
      event: { kind: 'progress', time: 1, text: 'establish wake channel' } }] });
    armed = true;
    const reload = request(worker);
    await entered;
    socket.onmessage?.({ data: 'wake' });
    socket.onmessage?.({ data: 'browser-control' });
    socket.onmessage?.({ data: 'open-conversation' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(statusReads).toBe(0);
    expect(pump).not.toHaveBeenCalled();
    expect(session.data.modelCatalogOwner).toBeUndefined();
    release();
    expect(await reload).toMatchObject({ ok: false, error: 'reload_deferred', pendingWork: { openChatgptTabs: 1 } });
    expect(worker.runtimeReload).not.toHaveBeenCalled();
    armed = false;
    socket.onmessage?.({ data: 'wake' });
    await vi.waitFor(() => { expect(statusReads).toBeGreaterThan(0); expect(pump).toHaveBeenCalled(); });
  });

  it('forwards a second normal browser-control wake to the real incumbent re-poll while retaining its pending promises for reload', async () => {
    let socket!: { onmessage?: (event: { data: string }) => void }, release!: () => void;
    class WakeSocket {
      readyState = 1;
      onmessage?: (event: { data: string }) => void;
      constructor(readonly url: string) { socket = this; }
      send() {}
      close() { this.readyState = 3; }
    }
    const gate = new Promise<void>(resolve => { release = resolve; });
    const controlSource = await fs.readFile(new URL('../extension/browser-control.js', import.meta.url), 'utf8');
    const createControl = vm.runInNewContext(controlSource.replace(/^import .*$/gm, '').replace('export function createBrowserControl', 'function createBrowserControl') + '; createBrowserControl;',
      { crypto: webcrypto, setTimeout, clearTimeout, TextEncoder, navigator: { userAgent: 'Chrome' } });
    let polls = 0;
    const controller = createControl({ storage: { session: new FakeStorageArea() }, permissions: { contains: async () => true } },
      async (_route: string, init: { body: string }) => {
        if (JSON.parse(init.body).action === 'poll') { polls++; if (polls === 1) await gate; }
        return { ok: true, data: { policy: { read: true, write: false }, epoch: 'test-epoch', requests: [] } };
      });
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
      browserController: controller, WebSocket: WakeSocket,
      fetch: async input => new URL(input).pathname === '/hello' ? response(200, { app: 'chat-on-steroids', paired: true }) : response(200, { ok: true }) });
    await worker.send({ type: 'events', conversationId, entries: [{ conversationId,
      event: { kind: 'progress', time: 1, text: 'establish wake channel' } }] });
    socket.onmessage?.({ data: 'browser-control' });
    await vi.waitFor(() => expect(polls).toBe(1));
    socket.onmessage?.({ data: 'browser-control' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const blocked = await request(worker);
    expect(blocked).toMatchObject({ ok: false, error: 'reload_deferred' });
    expect(blocked.pendingWork.browserControlFlight).toBeGreaterThan(0);
    expect(worker.runtimeReload).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(polls).toBe(2));
    expect(await request(worker)).toMatchObject({ ok: true, reloading: true });
  });

  it('allows a second normal urgent-open wake to poll and acknowledge its new nonce while the first snapshot is delayed', async () => {
    let socket!: { onmessage?: (event: { data: string }) => void }, release!: () => void;
    class WakeSocket {
      readyState = 1;
      onmessage?: (event: { data: string }) => void;
      constructor(readonly url: string) { socket = this; }
      send() {}
      close() { this.readyState = 3; }
    }
    const gate = new Promise<void>(resolve => { release = resolve; });
    const open = { conversationId, requestId: 'second-wake-request', nonce: 'a'.repeat(32) };
    const target = { id: 17, windowId: 7, url: `https://chatgpt.com/c/${conversationId}`, status: 'complete' };
    let snapshots = 0;
    const acknowledgements: Array<Record<string, unknown>> = [];
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
      WebSocket: WakeSocket, tabsQuery: async () => [target], tabsGet: async () => target,
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/status') {
          snapshots++;
          if (snapshots === 1) { await gate; return response(200, { ok: true, openConversationRequests: [] }); }
          return response(200, { ok: true, openConversationRequests: [open] });
        }
        if (route === '/browser/open-chat') acknowledgements.push(JSON.parse(String(init.body)));
        return response(200, { ok: true });
      } });
    await worker.send({ type: 'events', conversationId, entries: [{ conversationId,
      event: { kind: 'progress', time: 1, text: 'establish wake channel' } }] });
    try {
      socket.onmessage?.({ data: 'open-conversation' });
      await vi.waitFor(() => expect(snapshots).toBe(1));
      socket.onmessage?.({ data: 'open-conversation' });
      await vi.waitFor(() => expect(acknowledgements).toEqual([expect.objectContaining(open)]));
      expect(snapshots).toBe(2);
      expect(worker.tabsCreate).not.toHaveBeenCalled();
    } finally { release(); }
  });

  it('retains unknown or newly appeared tabs and retained helper owners rather than inventing safe custody', async () => {
    const session = new FakeStorageArea({ modelCatalogOwner: { id: 'retained-helper-owner' } });
    const worker = loadWorker({ local: new FakeStorageArea({ disconnected: true }), session });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await request(worker)).toMatchObject({ ok: false, error: 'reload_deferred', pendingWork: { modelCatalogOwner: 1 } });
    expect(session.data.modelCatalogOwner).toEqual({ id: 'retained-helper-owner' });
    expect(worker.runtimeReload).not.toHaveBeenCalled();
    const unknown = loadWorker({ local: new FakeStorageArea({ disconnected: true }), session: new FakeStorageArea(),
      tabsQuery: async () => [{ id: 17, url: `https://chatgpt.com/c/${conversationId}` }] });
    expect(await request(unknown)).toMatchObject({ ok: false, error: 'reload_deferred' });
    expect(unknown.runtimeReload).not.toHaveBeenCalled();
  });

  it('reports retired helper elections as a sanitized subset of retained input openings', async () => {
    const inputId = 'a1111111-2222-4333-8444-555555555555';
    const owner = 'private-helper-owner-document';
    const opening = { tab: 41, stage: 'retired', retiredAt: Date.now(), temporary: true,
      owner, conversationId };
    const local = new FakeStorageArea({ disconnected: true, inputOpenings: { [inputId]: opening } });
    const worker = loadWorker({ local, session: new FakeStorageArea() });
    await new Promise(resolve => setTimeout(resolve, 0));

    const reply = await request(worker);

    expect(reply).toMatchObject({ ok: false, error: 'reload_deferred', pendingWork: {
      inputOpenings: 1, retiredHelperElections: 1
    } });
    expect(JSON.stringify(reply)).not.toContain(owner);
    expect(local.data.inputOpenings).toEqual({ [inputId]: opening });
    expect(worker.runtimeReload).not.toHaveBeenCalled();
    expect(worker.tabsRemove).not.toHaveBeenCalled();
  });

  it('refuses requests from native pages or foreign extension pages without draining or reloading', async () => {
    const worker = loadWorker({ local: new FakeStorageArea(), session: new FakeStorageArea() });
    for (const url of [`https://chatgpt.com/c/${conversationId}`, 'chrome-extension://foreign/popup.html']) {
      expect(await worker.send({ type: 'reloadCompanion' }, 1, 'page', url)).toMatchObject({ ok: false, error: 'popup_required' });
    }
    expect(worker.runtimeReload).not.toHaveBeenCalled();
  });
});

describe('browser identity', () => {
  it('rehydrates proven connector identity from this paired Main status without another store', async () => {
    const names = { core: 'Luna Forge X7 Gary Windows Core', desktop: 'Desktop', plugins: 'Plugins' };
    const apps = { core: [{ appId: 'asdk_app_renamed', linkId: 'link_own', name: 'Renamed Core' }], desktop: [], plugins: [] };
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const fetch = async (input: string) => new URL(input).pathname === '/hello'
      ? response(200, { app: 'chat-on-steroids', paired: true })
      : response(200, { ok: true, connectorNames: names, connectorApps: apps });
    const worker = loadWorker({ local, session, fetch });
    await worker.fireAlarm();
    expect(await worker.send({ type: 'status' })).toMatchObject({ connectorApps: apps, connectorNames: names });
    const restarted = loadWorker({ local, session, fetch });
    await restarted.fireAlarm();
    expect(await restarted.send({ type: 'status' })).toMatchObject({ connectorApps: apps, connectorNames: names });
    expect(local.data).not.toHaveProperty('connectorApps');
  });

  it('sends one stable random browser id with every app request', async () => {
    const seen: string[] = [];
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({
      local,
      session: new FakeStorageArea(),
      fetch: async (input, init = {}) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        if (new URL(input).pathname !== '/hello') seen.push(headers['x-extension-browser'] ?? '');
        return new URL(input).pathname === '/hello'
          ? response(200, { app: 'chat-on-steroids', paired: true })
          : response(200, { ok: true });
      }
    });
    await worker.fireAlarm();
    await worker.fireAlarm();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(seen).size).toBe(1);
    expect((await local.get(['browserId'])).browserId).toBe(seen[0]);
  });
});

describe('confirmed pre-Send recovery receipts', () => {
  it('durably preserves the exact recovery refusal and detail across a worker restart', async () => {
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const inputId = 'ffffffff-1111-4222-8333-444444444444';
    const documentId = 'recovery-document';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let healthy = false;
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = async (input: string, init: Record<string, unknown> = {}) => {
      const route = new URL(input).pathname;
      if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (route === '/input/fail') {
        bodies.push(JSON.parse(String(init.body)));
        return healthy ? response(200, { ok: true }) : response(503, { error: 'retry' });
      }
      if (route === '/status') return response(200, { ok: true, repairs: [], inputs: [] });
      return response(200, { ok: true });
    };
    const options = { local, session, fetch,
      tabsGet: async () => ({ id: 1, url }) };
    const first = loadWorker(options);
    await first.registerTab(1, documentId);
    const result = await first.send({
      type: 'desktop_input', id: inputId, owner: `1:${documentId}:0`, conversationId,
      fail: true, confirmedUnsent: true,
      error: 'After-turn pickup was withdrawn before Send.', detail: 'app-refused'
    }, 1, documentId);
    expect(result).toMatchObject({ ok: true, queued: true });
    expect(session.data.commandAckOutbox).toMatchObject([{
      kind: 'input-unsent', id: inputId, conversationId,
      error: 'After-turn pickup was withdrawn before Send.', detail: 'app-refused'
    }]);

    healthy = true;
    const restarted = loadWorker(options);
    await restarted.send({ type: 'status' });
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(bodies.at(-1)).toEqual({
      id: inputId, owner: `1:${documentId}:0`, conversationId,
      confirmedUnsent: true,
      error: 'After-turn pickup was withdrawn before Send.', detail: 'app-refused'
    });
    expect(session.data.commandAckOutbox).toEqual([]);
  });
});

describe('model discovery command custody', () => {
  it.each([false, true])('never borrows a command-owned opening (allowOpen=%s)', async (allowOpen) => {
    const commandId = '4e689b755134a55a';
    const nonce = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const rootUrl = `https://chatgpt.com/?clf=${commandId}#clf=${commandId}`;
    const session = new FakeStorageArea({
      chatBackgroundWindow: 7,
      appOwnedOpeningTabs: {
        '77': { createdAt: Date.now(), marker: commandId }
      }
    });
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session,
      windowsGet: async (id) => ({ id, focused: false }),
      fetch: async (input) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/status') return response(200, {
          ok: true,
          repairs: [],
          background: true,
          modelCatalogRequest: { nonce, expiresAt: Date.now() + 60_000, allowOpen }
        });
        return response(200, { ok: true });
      }
    });
    await worker.createTab({ id: 77, url: rootUrl, active: false });
    worker.tabsCreate.mockClear();
    worker.tabsSendMessage.mockClear();

    await worker.fireAlarm();

    expect(worker.tabsSendMessage.mock.calls.filter(([id, message]) => id === 77 &&
      String(message?.type || '').startsWith('clf-model-catalog'))).toHaveLength(0);
    if (allowOpen) {
      expect(worker.tabsCreate).toHaveBeenCalledExactlyOnceWith({
        url: `https://chatgpt.com/?cos-model-catalog=${nonce}`,
        active: false
      });
      expect((session.data.modelCatalogOwner as Record<string, unknown>)?.nonce).toBe(nonce);
    } else {
      expect(worker.tabsCreate).not.toHaveBeenCalled();
      expect(session.data.modelCatalogOwner).toBeUndefined();
    }
  });

  it('never offers a fresh desktop input to an unredeemed command-owned opening', async () => {
    const commandId = '4e689b755134a55a';
    const inputId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const rootUrl = `https://chatgpt.com/?clf=${commandId}#clf=${commandId}`;
    const root = { id: 77, windowId: 7, url: rootUrl, active: false, pinned: false, status: 'complete' };
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: {
        '77': { createdAt: Date.now(), marker: commandId }
      }
    });
    let armed = false;
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session,
      tabsGet: async () => root,
      tabsSendMessage: async (_id, message) => message.type === 'clf-input-reuse-state'
        ? { safe: true, navigationEpoch: 0 }
        : { ok: true },
      fetch: async (input) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/status') return response(200, {
          ok: true,
          repairs: [],
          openConversationRequests: [],
          browserCommandIds: [commandId],
          background: false,
          inputs: armed ? [{ id: inputId, conversationId: null }] : [],
          inputOpeningIds: armed ? [inputId] : [],
          userRequestedInputIds: armed ? [inputId] : [],
          reusableConversations: []
        });
        return response(200, { ok: true });
      }
    });
    await worker.createTab(root);
    await worker.registerTab(77, 'document-77-0');
    worker.tabsCreate.mockClear();
    worker.tabsSendMessage.mockClear();
    armed = true;

    await worker.fireAlarm();

    expect(worker.tabsSendMessage.mock.calls.filter(([, message]) =>
      message?.type === 'clf-input-reuse-state' || message?.type === 'clf-prepare-desktop-input')).toHaveLength(0);
    expect(worker.tabsCreate).toHaveBeenCalledExactlyOnceWith({
      url: `https://chatgpt.com/?cos-input=${inputId}#cos-input=${inputId}`,
      active: true
    });
  });
});

describe('accepted helper tab cleanup', () => {
  it.each([undefined, 1, 2])('forwards only the loaded content fresh-turn capability (%s)', async capability => {
    const chat = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const bodies: Record<string, unknown>[] = [];
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
      tabsQuery: async () => [{ id: 1, windowId: 7, url: `https://chatgpt.com/c/${chat}` }],
      tabsGet: async () => ({ id: 1, windowId: 7, url: `https://chatgpt.com/c/${chat}`, pinned: false }),
      fetch: async (input, init) => {
        if (new URL(input).pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (new URL(input).pathname === '/input/claim') bodies.push(JSON.parse(String(init?.body)));
        return response(200, { input: null });
      }
    });
    await worker.registerTab(1);
    await worker.send({ type: 'desktop_input', id: 'ffffffff-1111-4222-8333-444444444444',
      owner: '1:document-1-0:0', conversationId: chat, requiresAuthorization: true, freshTurnProtocol: capability });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.freshTurnProtocol).toBe(capability === 1 ? 1 : undefined);
  });

  it.each([[true, true], [false, true], [true, false]])('accepts a marker-stripped helper answer only from its elected tab (elected: %s, temporary proof: %s)', async (elected, temporary) => {
    const inputId = 'ffffffff-1111-4222-8333-444444444444';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token', inputOpenings: {
      [inputId]: { tab: elected ? 1 : 9, stage: 'ready', createdAt: Date.now() }
    } });
    const worker = loadWorker({
      local, session: new FakeStorageArea(),
      tabsQuery: async () => [{ id: 1, windowId: 7, url: 'https://chatgpt.com/' },
        { id: 2, windowId: 7, url: 'https://example.com/' }],
      tabsGet: async () => ({ id: 1, windowId: 7, url: 'https://chatgpt.com/', pinned: false }),
      tabsSendMessage: async () => ({ safe: true, temporary, conversationId: null, navigationEpoch: 0 }),
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true } : { ok: true })
    });
    await worker.registerTab(1);
    const result = await worker.send({ type: 'desktop_input', id: inputId,
      owner: '1:document-1-0:0', lifetime: 'temporary-planner',
      response: '{"action":"continue","reply":"Continue the exact task."}' });
    expect(result.ok).toBe(elected);
    if (elected && temporary) expect(worker.tabsRemove).toHaveBeenCalledWith(1);
    else expect(worker.tabsRemove).not.toHaveBeenCalled();
  });

  it('closes an accepted routed Temporary Chat after ChatGPT strips its input marker', async () => {
    const helper = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const inputId = 'ffffffff-1111-4222-8333-444444444444';
    const url = `https://chatgpt.com/c/${helper}?temporary-chat=true`;
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
      tabsQuery: async () => [
        { id: 1, windowId: 7, url },
        { id: 2, windowId: 8, url: 'https://example.com/' }
      ],
      tabsGet: async () => ({ id: 1, windowId: 7, url, pinned: false }),
      tabsSendMessage: async (_id, message) => message.type === 'clf-close-temporary-planner'
        ? { safe: true, conversationId: helper, navigationEpoch: 0 }
        : { ok: true },
      fetch: async (input) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/input/answer' || route === '/input/output') return response(200, { ok: true });
        return response(200, {});
      }
    });
    await worker.registerTab(1);
    const result = await worker.send({ type: 'desktop_input', id: inputId,
      owner: '1:document-1-0:0', lifetime: 'temporary-planner',
      response: '{"action":"continue","reply":"Keep working."}' });
    expect(result.ok).toBe(true);
    expect(worker.tabsRemove).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([true, false])('collects the elected helper result after provider removes all URL markers (elected: %s)', async elected => {
    const helperRoute = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const inputId = 'ffffffff-1111-4222-8333-444444444444';
    const url = `https://chatgpt.com/c/${helperRoute}`;
    const answer = '{"action":"continue","reply":"Retain the native helper answer."}';
    const fetched: string[] = [];
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token', inputOpenings: {
        [inputId]: { tab: elected ? 1 : 9, stage: 'ready', createdAt: Date.now() }
      } }), session: new FakeStorageArea(),
      tabsQuery: async () => [{ id: 1, windowId: 7, url }],
      tabsGet: async () => ({ id: 1, windowId: 7, url, pinned: false }),
      tabsSendMessage: async () => ({ safe: false, conversationId: helperRoute, navigationEpoch: 0 }),
      fetch: async input => {
        const route = new URL(input).pathname;
        fetched.push(route);
        return response(200, route === '/hello' ? { app: 'chat-on-steroids', paired: true } : { ok: true });
      }
    });
    await worker.registerTab(1);
    const result = await worker.send({ type: 'desktop_input', id: inputId,
      owner: '1:document-1-0:0', lifetime: 'temporary-planner', response: answer });
    expect(result.ok).toBe(elected);
    expect(fetched.filter(route => route === '/input/answer')).toHaveLength(elected ? 1 : 0);
    expect(worker.tabsRemove).not.toHaveBeenCalled();
  });

  for (const outcome of ['accepted', 'rejected', 'navigated', 'pinned', 'busy', 'draft', 'pinned-during-proof'] as const) {
    it(`closes only the exact accepted helper document (${outcome})`, async () => {
      const helper = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const other = '11111111-2222-4333-8444-555555555555';
      let url = `https://chatgpt.com/c/${helper}`;
      let pinned = outcome === 'pinned';
      const worker = loadWorker({
        local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
        tabsQuery: async () => [
          { id: 1, windowId: 7, url },
          { id: 2, windowId: 8, url: 'https://example.com/' }
        ],
        tabsGet: async () => ({ id: 1, windowId: 7, url, pinned }),
        tabsSendMessage: async (_id, message) => {
          if (message.type !== 'clf-tab-close-check') return { ok: true };
          if (outcome === 'pinned-during-proof') pinned = true;
          return { safe: outcome !== 'busy' && outcome !== 'draft', conversationId: helper, navigationEpoch: 0 };
        },
        fetch: async (input) => {
          const route = new URL(input).pathname;
          if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
          if (route === '/input/answer') {
            if (outcome === 'navigated') url = `https://chatgpt.com/c/${other}`;
            return response(200, { ok: outcome !== 'rejected' });
          }
          return response(200, {});
        }
      });
      await worker.registerTab(1);
      const result = await worker.send({ type: 'desktop_input', id: 'ffffffff-1111-4222-8333-444444444444',
        owner: '1:document-1-0:0', response: '{"action":"stop","reply":""}' });
      expect(result.ok).toBe(true);
      if (outcome === 'accepted') expect(worker.tabsRemove).toHaveBeenCalledExactlyOnceWith(1);
      else expect(worker.tabsRemove).not.toHaveBeenCalled();
    });
  }

  it('keeps an accepted helper as the final Chrome tab', async () => {
    const helper = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const url = `https://chatgpt.com/c/${helper}`;
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
      tabsQuery: async () => [{ id: 1, windowId: 7, url }],
      tabsGet: async () => ({ id: 1, url }),
      tabsSendMessage: async (_id, message) => message.type === 'clf-tab-close-check'
        ? { safe: true, conversationId: helper, navigationEpoch: 0 }
        : { ok: true },
      fetch: async (input) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/input/answer') return response(200, { ok: true });
        return response(200, {});
      }
    });
    await worker.registerTab(1);
    const result = await worker.send({ type: 'desktop_input', id: 'ffffffff-1111-4222-8333-444444444444',
      owner: '1:document-1-0:0', response: '{"action":"stop","reply":""}' });
    expect(result.ok).toBe(true);
    expect(worker.tabsRemove).not.toHaveBeenCalled();
  });

  it('serializes simultaneous helper retirement and leaves one Chrome tab alive', async () => {
    const chats = [
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      '11111111-2222-4333-8444-555555555555'
    ];
    const urls = new Map(chats.map((chat, index) => [index + 1, `https://chatgpt.com/c/${chat}`]));
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
      tabsGet: async id => ({ id, windowId: 7, url: urls.get(id) }),
      tabsSendMessage: async (id, message) => message.type === 'clf-tab-close-check'
        ? { safe: true, conversationId: chats[id - 1], navigationEpoch: 0 }
        : { ok: true },
      fetch: async (input) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/input/answer') return response(200, { ok: true });
        return response(200, {});
      }
    });
    for (const id of [1, 2]) {
      await worker.createTab({ id, url: urls.get(id) });
      await worker.registerTab(id);
    }
    await Promise.all([1, 2].map(id => worker.send({
      type: 'desktop_input',
      id: `ffffffff-1111-4222-8333-44444444444${id}`,
      owner: `${id}:document-${id}-0:0`,
      response: '{"action":"stop","reply":""}'
    }, id)));
    expect(worker.tabsRemove).toHaveBeenCalledTimes(1);
  });
});

/**
 * Exact chat recovery, from the browser's side.
 *
 * The app can prove one chat's tool calls stopped being attributable to it, and can name that
 * chat — but it cannot reach it. The page it would instruct is the page that stopped listening,
 * and opening the url would make a second tab of a chat that is still on screen, which is the
 * failure this whole path exists to avoid. The tab registry lives here, so the decision does
 * too: this worker asks on the maintenance alarm it already runs, and reloads the exact tab.
 */
describe('exact chat recovery from a fresh Chrome tab scan', () => {
  const paired = { port: 8765, token: 'paired-token' };
  const CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const OTHER = '11111111-2222-4333-8444-555555555555';

  it('reclaims an exact app-owned redirected root before creating another repair tab', () => {
    const owner = backgroundSource.split('async function performBrowserRepairs(', 2)[1]
      ?.split('\nfunction conversationStillOpen(', 1)[0] ?? '';
    expect(owner).toContain('proveEmptyRedirectedConversationRoot(redirected, row, null, !guardedNativeRecovery)');
    expect(owner).toContain('repairDeferred=');
    expect(owner.indexOf('proveEmptyRedirectedConversationRoot(redirected, row, null, !guardedNativeRecovery)')).toBeLessThan(
      owner.indexOf('const created = await createChatTab(')
    );
  });

  it('stages automatic missing-chat repairs instead of opening a Chrome burst', () => {
    const start = backgroundSource.indexOf('const AUTOMATIC_REPAIR_STAGGER_MS');
    const end = backgroundSource.indexOf('\nfunction conversationStillOpen(', start);
    const owner = backgroundSource.slice(start, end);
    expect(owner).toContain('const AUTOMATIC_REPAIR_STAGGER_MS = 5_000');
    expect(owner).toContain("reason === 'automation' || reason === 'no-tab'");
    expect(owner).toContain('nextAutomaticRepairAt = now + AUTOMATIC_REPAIR_STAGGER_MS');
    expect(owner).toContain('scheduleAutomaticRepairWake(nextAutomaticRepairAt - now)');
    expect(owner.indexOf('nextAutomaticRepairAt = now + AUTOMATIC_REPAIR_STAGGER_MS'))
      .toBeLessThan(owner.indexOf('live = await cleanupConversationInventory()'));
  });

  it.each(['maintainTabHygiene', 'maintainBareRootHygiene', 'flushUnreachableConversationNotices'])('offers an admitted helper above the tab ceiling before slow %s without spending a second opening', async (slowOwner) => {
    const start = backgroundSource.indexOf('async function maintainOnce(');
    const end = backgroundSource.indexOf('\n/**', start);
    const helper = { id: 'queued-helper', conversationId: null, lifetime: 'temporary-planner' };
    const offered: unknown[][] = [];
    const budgets: number[] = [];
    let release!: () => void;
    let entered!: () => void;
    const atHygiene = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const context: Record<string, unknown> = {
      token: 'paired', latestBrowserAttentionCommandIds: [], discardProtectedTabs: {},
      MAX_AUTOMATION_CHATGPT_TABS: 48, recoveryMonitoring: false,
      call: async () => ({ ok: true, data: { inputs: [helper] } }),
      openConversationInventory: async () => Array.from({ length: 52 }, (_, id) => ({ id })), browserAuthenticationState: async () => 'signed-in',
      hydrateBrowserControlLeases: async () => true,
      freshTurnInventoryProtocol: async () => undefined,
      reconcileBackgroundWindow: async () => true,
      deliverDesktopInputs: async (inputs: unknown[], _background: boolean, _reusable: unknown, _ids: unknown, budget: number) => {
        offered.push(inputs); budgets.push(budget); return inputs.length && budget > 0 ? 1 : 0;
      },
      maintainTabHygiene: async () => { entered(); await held; return { complete: true, attentionWork: false }; },
      acceptBrowserRevivals: async () => false,
      cleanConversationId: (value: unknown) => value,
      commandMarkerId: (value: unknown) => value,
      conversationForTab: () => null,
      setTimeout: () => 0
    };
    for (const name of ['maintainBareRootHygiene', 'adoptMarkedAppOwnedTabs', 'flushUnreachableConversationNotices',
      'connectWakeSocket', 'pumpBrowserControl', 'fulfillOpenConversationRequests', 'performBrowserRepairs',
      'applyRequestedBrowserPreferences', 'offerStopTurns', 'inspectRequestedModels', 'inspectRequestedPluginRefresh',
      'inspectProjectCreates',
      'clearRetryIfIdle']) context[name] = async () => undefined;
    context[slowOwner] = async () => { entered(); await held; return { complete: true, attentionWork: false }; };
    const maintain = vm.runInNewContext(`${backgroundSource.slice(start, end)}\nmaintainOnce`, context);
    const running = maintain();
    try {
      await atHygiene;
      expect(offered.flat()).toEqual([helper]);
      expect(budgets).toEqual([1]);
    } finally {
      release();
      await running;
    }
    expect(offered.flat()).toEqual([helper]);
    expect(budgets).toEqual([1, 0]);
  });

  it.each(['unrelated', 'same-conversation'] as const)('does not strand an existing authored input behind a held %s repair', async relation => {
    const start = backgroundSource.indexOf('async function maintainOnce(');
    const end = backgroundSource.indexOf('\n/**', start);
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const input = { id: 'existing-manual', conversationId };
    const offered: unknown[] = [];
    const budgets: number[] = [];
    let release!: () => void;
    let entered!: () => void;
    const atRepair = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const context: Record<string, unknown> = {
      token: 'paired', latestBrowserAttentionCommandIds: [], discardProtectedTabs: {},
      MAX_AUTOMATION_CHATGPT_TABS: 48, recoveryMonitoring: false,
      call: async () => ({ ok: true, data: { inputs: [input], userRequestedInputIds: [input.id],
        repairs: [{ conversationId: relation === 'same-conversation' ? conversationId : 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', token: 'exact-repair', requiresClaim: true }] } }),
      openConversationInventory: async () => [{ id: 83, url: 'https://chatgpt.com/c/' + conversationId }],
      browserAuthenticationState: async () => 'signed-in', hydrateBrowserControlLeases: async () => true,
      freshTurnInventoryProtocol: async () => undefined, reconcileBackgroundWindow: async () => true,
      deliverDesktopInputs: async (inputs: unknown[], _background: boolean, _reuse: unknown, _ids: unknown, budget: number) => {
        offered.push(...inputs); budgets.push(budget); return 0; // Existing tab spends no opening.
      },
      maintainTabHygiene: async () => ({ complete: true, attentionWork: false }),
      performBrowserRepairs: async () => { entered(); await held; },
      acceptBrowserRevivals: async () => false, cleanConversationId: (value: unknown) => value,
      commandMarkerId: (value: unknown) => value, conversationForTab: () => null, setTimeout: () => 0
    };
    for (const name of ['maintainBareRootHygiene', 'adoptMarkedAppOwnedTabs', 'flushUnreachableConversationNotices',
      'connectWakeSocket', 'pumpBrowserControl', 'fulfillOpenConversationRequests',
      'applyRequestedBrowserPreferences', 'offerStopTurns', 'inspectRequestedModels', 'inspectRequestedPluginRefresh',
      'inspectProjectCreates', 'clearRetryIfIdle']) context[name] = async () => undefined;
    const maintain = vm.runInNewContext(backgroundSource.slice(start, end) + '\nmaintainOnce', context);
    const running = maintain();
    try {
      await atRepair;
      expect(offered).toEqual(relation === 'unrelated' ? [{ ...input, userRequested: true }] : []);
      expect(budgets.every(budget => budget <= 1)).toBe(true);
    } finally { release(); await running; }
    // A same-document reload retains custody; neither case receives a second input offer.
    expect(offered).toEqual(relation === 'unrelated' ? [{ ...input, userRequested: true }] : []);
  });

  it('prioritizes authored delivery and bounds automatic tab pressure', () => {
    const start = backgroundSource.indexOf('async function maintainOnce(');
    const end = backgroundSource.indexOf('\nasync function performBrowserRepairs(', start);
    const owner = backgroundSource.slice(start, end);
    expect(owner).toContain('userRequestedInputIds');
    expect(owner).toContain('urgentAuthoredInputs');
    expect(owner.indexOf('await deliverDesktopInputs(\n        urgentAuthoredInputs'))
      .toBeLessThan(owner.indexOf('await fulfillOpenConversationRequests('));
    expect(owner).toContain('observedTabs.length >= MAX_AUTOMATION_CHATGPT_TABS');
    expect(backgroundSource).toContain('const MAX_AUTOMATION_CHATGPT_TABS = 48;');
  });

  it('reports one browser-profile auth proof through the existing status heartbeat', async () => {
    const start = backgroundSource.indexOf('async function browserAuthenticationState(');
    const end = backgroundSource.indexOf('\n/**', start);
    const auth = vm.runInNewContext(
      `${backgroundSource.slice(start, end)}\nbrowserAuthenticationState`,
      {
        tabReply: async (id: number) => id === 83
          ? { authState: 'signed-out' }
          : id === 84 ? { authState: 'signed-in' } : null
      }
    ) as (tabs: Array<{ id: number; pendingUrl?: string }>) => Promise<string>;
    expect(await auth([{ id: 83 }])).toBe('signed-out');
    expect(await auth([{ id: 83 }, { id: 84 }])).toBe('signed-out');
    expect(await auth([{ id: 84 }])).toBe('signed-in');
    expect(await auth([{ id: 85 }])).toBe('unknown');

    const maintainStart = backgroundSource.indexOf('async function maintainOnce(');
    const maintainEnd = backgroundSource.indexOf('\nasync function performBrowserRepairs(', maintainStart);
    const maintain = backgroundSource.slice(maintainStart, maintainEnd);
    expect(maintain).toContain('const authState = inventoryComplete ? await browserAuthenticationState(observedTabs)');
    expect(maintain).toContain('JSON.stringify({ openConversations, inventoryComplete, authState, freshTurnProtocol })');
  });

  it('publishes fresh-turn capability through the actual maintenance status transport', async () => {
    const start = backgroundSource.indexOf('async function maintainOnce(');
    const end = backgroundSource.indexOf('\n/**', start);
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const context = {
      token: 'paired', hydrateBrowserControlLeases: async () => true,
      conversationForTab: () => null,
      freshTurnInventoryProtocol: async () => 1,
      openConversationInventory: async () => [], adoptMarkedAppOwnedTabs: async () => undefined,
      browserAuthenticationState: async () => 'signed-in', maintainBareRootHygiene: async () => undefined,
      call: async (path: string, options: { body: string }) => {
        calls.push({ path, body: JSON.parse(options.body) }); return { ok: false };
      }
    };
    const maintain = vm.runInNewContext(`${backgroundSource.slice(start, end)}\nmaintainOnce`, context);
    await maintain();
    expect(calls).toEqual([{ path: '/status', body: {
      openConversations: [], inventoryComplete: true, authState: 'signed-in', freshTurnProtocol: 1 } }]);
  });

  it('publishes status when an exact receiver repair is stuck, retaining that repair and withholding fresh-turn capability', async () => {
    vi.useFakeTimers();
    let releaseRepair!: (value: boolean) => void;
    const pendingRepair = new Promise<boolean>(resolve => { releaseRepair = resolve; });
    const restore = vi.fn(() => pendingRepair);
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const logs = vi.fn();
    const chat = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const tab = { id: 73, url: `https://chatgpt.com/c/${chat}`, status: 'complete' };
    const readinessStart = backgroundSource.indexOf('const desktopInputReceiverRepairs = new Map();');
    const readinessEnd = backgroundSource.indexOf('\nfunction offerDesktopInput(', readinessStart);
    const maintainStart = backgroundSource.indexOf('async function maintainOnce(');
    const maintainEnd = backgroundSource.indexOf('\n/**', maintainStart);
    const context = {
      token: 'paired', PAGE_RECORDER_VERSION: 71, setTimeout, clearTimeout,
      chrome: { tabs: { get: async () => tab } },
      tabDocuments: { '73': 'doc-73' }, tabEpochs: { '73': 0 },
      ownsDocument: () => true, conversationForTab: () => chat,
      tabReply: async () => ({ ok: true, recorderVersion: 67, freshTurnProtocol: 1, requiredFeatures: { promptEnvelope: true, nativeAllowOnce: true } }),
      restoreChatgptTab: restore, hydrateBrowserControlLeases: async () => true,
      openConversationInventory: async () => [tab], adoptMarkedAppOwnedTabs: async () => undefined,
      browserAuthenticationState: async () => 'signed-in', maintainBareRootHygiene: async () => undefined,
      console: { info: logs },
      call: async (route: string, options: { body: string }) => {
        calls.push({ path: route, body: JSON.parse(options.body) }); return { ok: false };
      }
    };
    const owner = vm.runInNewContext(`${backgroundSource.slice(readinessStart, readinessEnd)}\n` +
      `${backgroundSource.slice(maintainStart, maintainEnd)}\n` +
      '({maintain: maintainOnce, repairs: desktopInputReceiverRepairs})', context) as {
        maintain: () => Promise<void>; repairs: Map<number, Promise<boolean>>;
      };
    const runs: Promise<void>[] = [];
    try {
      runs.push(owner.maintain());
      await vi.advanceTimersByTimeAsync(6_000);
      expect(calls).toEqual([{ path: '/status', body: {
        openConversations: [chat], inventoryComplete: true, authState: 'signed-in' } }]);
      expect(owner.repairs.has(73)).toBe(true);
      expect(restore).toHaveBeenCalledExactlyOnceWith(73);
      runs.push(owner.maintain());
      await vi.advanceTimersByTimeAsync(6_000);
      expect(calls).toHaveLength(2);
      expect(calls.every(row => row.body.freshTurnProtocol === undefined)).toBe(true);
      expect(restore).toHaveBeenCalledTimes(1);
      expect(logs).toHaveBeenCalledTimes(1);
      // A late unsuccessful repair is still the original owner. Its settlement does not
      // retrospectively publish capability or create any new claim/Send/closure action.
      releaseRepair(false);
      await Promise.all(runs);
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.repairs.size).toBe(0);
      expect(calls.map(row => row.path)).toEqual(['/status', '/status']);
    } finally {
      releaseRepair(false);
      await Promise.all(runs);
      vi.useRealTimers();
    }
  });

  it.each(['ready', 'refused', 'late-ready', 'late-navigation'] as const)(
    'keeps readiness and late receiver outcomes separate from timed-out inventory (%s)', async mode => {
      vi.useFakeTimers();
      const chat = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const tab = { id: 73, url: `https://chatgpt.com/c/${chat}`, status: 'complete' };
      let liveVersion = mode === 'ready' ? 71 : 70;
      let release!: (value: boolean) => void;
      const pending = new Promise<boolean>(resolve => { release = resolve; });
      const start = backgroundSource.indexOf('const desktopInputReceiverRepairs = new Map();');
      const end = backgroundSource.indexOf('\nfunction offerDesktopInput(', start);
      const owner = vm.runInNewContext(`${backgroundSource.slice(start, end)}\n` +
        '({inventory: freshTurnInventoryProtocol, repairs: desktopInputReceiverRepairs})', {
          PAGE_RECORDER_VERSION: 71, setTimeout, clearTimeout,
          chrome: { tabs: { get: async () => tab } },
          tabDocuments: { '73': 'doc-73' }, tabEpochs: { '73': 0 }, ownsDocument: () => true,
          conversationForTab: (value: typeof tab) => value.url.endsWith(chat) ? chat : 'another-conversation',
          tabReply: async () => ({ ok: true, recorderVersion: liveVersion, freshTurnProtocol: 1, requiredFeatures: { promptEnvelope: true, nativeAllowOnce: true } }),
          restoreChatgptTab: () => mode === 'refused' ? Promise.resolve(false) : pending,
          console: { info: vi.fn() }
        }) as { inventory: (tabs: Array<typeof tab>) => Promise<1 | undefined>; repairs: Map<number, Promise<boolean>> };
      try {
        const result = owner.inventory([tab]);
        if (mode.startsWith('late-')) {
          await vi.advanceTimersByTimeAsync(6_000);
          expect(await result).toBeUndefined();
          expect(owner.repairs.has(73)).toBe(true);
          liveVersion = 71;
          if (mode === 'late-navigation') tab.url = 'https://chatgpt.com/c/changed';
          release(true);
          await vi.advanceTimersByTimeAsync(0);
          expect(await result).toBeUndefined();
          expect(owner.repairs.size).toBe(0);
          if (mode === 'late-ready') expect(await owner.inventory([tab])).toBe(1);
        } else expect(await result).toBe(mode === 'ready' ? 1 : undefined);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        release(false);
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }
    });

  it('opens one known conversation from an exact URL inventory instead of scanning every ChatGPT tab', () => {
    const start = backgroundSource.indexOf('async function fulfillOpenConversationRequests(');
    const end = backgroundSource.indexOf('\n/**\n * Explicit user Open requests', start);
    const owner = backgroundSource.slice(start, end);
    expect(owner).toContain('exactConversationInventory(request.conversationId)');
    expect(owner).toContain('bareRootInventory()');
    expect(owner).not.toContain('cleanupConversationInventory()');
  });

  it('retargets an elected delivery root in place after its short lease instead of opening a duplicate', async () => {
    const now = Date.now();
    const inputId = 'aaaaaaaa-1111-4222-8333-444444444444';
    const root = { id: 74, windowId: 7, url: 'https://chatgpt.com/', status: 'complete', active: false, pinned: false };
    const local = new FakeStorageArea({
      ...paired,
      inputOpenings: {
        [inputId]: { tab: 74, stage: 'ready', conversationId: CHAT, electedAt: now - 16_000 }
      }
    });
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: {
        '74': { createdAt: now - 16_000, conversationId: CHAT, openRequestId: inputId, openState: 'redirected' }
      },
      tabDocuments: { '74': 'doc-74' },
      tabEpochs: { '74': 0 }
    });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/status') return response(200, {
        ok: true,
        repairs: [],
        openConversationRequests: [],
        inputs: [{ id: inputId, conversationId: CHAT }],
        inputOpeningIds: [inputId]
      });
      return response(200, { ok: true });
    });
    const browserMessages: string[] = [];
    const worker = loadWorker({
      local,
      session,
      fetch,
      tabsQuery: async () => [root],
      tabsGet: async () => root,
      tabsSendMessage: async (_tabId, message) => {
        browserMessages.push(String(message.type));
        if (message.type === 'clf-dismiss-access-throttle') {
          return { present: true, dismissed: true, conversationId: null, navigationEpoch: 0 };
        }
        return message.type === 'clf-tab-close-check'
          ? { safe: true, conversationId: null, navigationEpoch: 0 }
          : { ok: true };
      }
    });

    await worker.send({ type: 'status' });
    await worker.fireAlarm();

    // Chrome alarm listeners return void, so the harness cannot await the service worker's
    // maintenance promise directly. Startup recorder restoration can still own the same tab for
    // a few event-loop turns after fireAlarm()'s bounded drain; wait on the exact browser effect
    // rather than assuming a fixed number of zero-delay turns is enough on every suite run.
    await vi.waitFor(() => expect(worker.tabsUpdate).toHaveBeenCalledWith(74, {
      url: `https://chatgpt.com/c/${CHAT}`
    }));
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(browserMessages.indexOf('clf-dismiss-access-throttle')).toBeGreaterThanOrEqual(0);
    expect(browserMessages.indexOf('clf-dismiss-access-throttle'))
      .toBeLessThan(browserMessages.indexOf('clf-tab-close-check'));
    expect((local.data.inputOpenings as Record<string, { tab: number; stage: string }>)[inputId])
      .toMatchObject({ tab: 74, stage: 'opening' });
  });

  it('keeps a fresh redirected Retry message unclaimed until the access-throttle modal has cleared', () => {
    const start = contentSource.indexOf('async function acceptDesktopInput(');
    const end = contentSource.indexOf('\n  async function', start + 1);
    const owner = contentSource.slice(start, end);
    expect(owner).toContain("error.reason === 'access_throttle_notice'");
    expect(owner).toContain('const freshAccessNotice = () => ownsFreshPage() && accessNotice();');
    expect(owner).toContain('if (freshAccessNotice())');
    expect(owner).toContain('if (!cleared || !onTarget()) return false;');
    expect(owner.indexOf('if (freshAccessNotice())')).toBeLessThan(
      owner.indexOf("const reply = await ask({ type: 'desktop_input', id: message.id")
    );
  });

  it('releases a stale pre-create delivery reservation so the durable input can open once', async () => {
    const inputId = 'bbbbbbbb-1111-4222-8333-444444444444';
    const local = new FakeStorageArea({
      ...paired,
      inputOpenings: {
        [inputId]: { tab: null, stage: 'opening', conversationId: CHAT, electedAt: Date.now() - 16_000 }
      }
    });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/status') return response(200, {
        ok: true,
        repairs: [],
        openConversationRequests: [],
        inputs: [{ id: inputId, conversationId: CHAT }],
        inputOpeningIds: [inputId]
      });
      return response(200, { ok: true });
    });
    const worker = loadWorker({
      local,
      session: new FakeStorageArea(),
      fetch,
      tabsQuery: async () => []
    });

    await worker.send({ type: 'status' });
    await worker.fireAlarm();

    expect(worker.tabsCreate).toHaveBeenCalledExactlyOnceWith({
      url: `https://chatgpt.com/c/${CHAT}`,
      active: true
    });
    expect((local.data.inputOpenings as Record<string, { tab: number; stage: string }>)[inputId])
      .toMatchObject({ tab: 99, stage: 'ready' });
  });

  /**
   * The app, as far as this worker can tell: it keeps handing the same repair out until a pass
   * reports having carried it out. That is the contract these tests are written against - a
   * pass that reports nothing must leave the repair outstanding.
   *
   * Each handout is minted with its own token, and only that token closes it, exactly as the
   * app does it. `asked` records what a receipt actually quoted, so a test can tell the
   * difference between a pass that reported the repair and one that reported something else.
   */
  function appWith(repair: string | null, browserOnly = false) {
    const asked: string[] = [];
    const actions: string[] = [];
    const failedActions: string[] = [];
    let outstanding = repair;
    let token = '';
    let minted = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/closed') return response(200, { ok: true });
      if (url.pathname === '/status') {
        const repaired = url.searchParams.get('repaired');
        const repairFailed = url.searchParams.get('repairFailed');
        if (repairFailed) {
          failedActions.push(url.searchParams.get('repairAction') || '');
          asked.push(repairFailed === token ? `failed:${outstanding}` : `stale-failure:${repairFailed}`);
          return response(200, { ok: true, repairs: [] });
        }
        if (repaired) actions.push(url.searchParams.get('repairAction') || '');
        asked.push(repaired ? (repaired === token ? `repaired:${outstanding}` : `stale:${repaired}`) : 'status');
        if (repaired && repaired === token) outstanding = null;
        if (!outstanding) return response(200, { ok: true, repairs: [] });
        token = `tok-${(minted += 1)}`;
        return response(200, { ok: true, browserOnly, repairs: [{ conversationId: outstanding, token }] });
      }
      return response(404, {});
    });
    return { fetch, asked, actions, failedActions, arm: (id: string) => { outstanding = id; } };
  }

  it('browser-only recovery waits for the missing chat and then reloads its exact existing tab', async () => {
    const { fetch, asked } = appWith(OTHER, true);
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(41);
    await worker.send({ type: 'bind', conversationId: CHAT }, 41);
    await worker.fireAlarm(); await worker.fireAlarm();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(asked.every(item => item === 'status')).toBe(true);
    await worker.registerTab(42);
    await worker.send({ type: 'bind', conversationId: OTHER }, 42);
    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledWith(42);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(asked).toContain(`repaired:${OTHER}`);
  });

  it('bounds a hung repair inventory and releases the maintenance flight for the next alarm', async () => {
    vi.useFakeTimers();
    try {
      const tab = { id: 43, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: false };
      let repaired = false;
      let handout = 0;
      const receipts: string[] = [];
      const failures: string[] = [];
      const fetch = vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/status') {
          if (url.searchParams.has('repairFailed')) {
            failures.push(url.searchParams.get('repairAction') || '');
            return response(200, { ok: true, repairs: [] });
          }
          if (url.searchParams.has('repaired')) {
            repaired = true;
            receipts.push(url.searchParams.get('repairAction') || '');
          }
          return response(200, {
            ok: true,
            repairs: repaired ? [] : [{ conversationId: CHAT, token: `bounded-repair-${++handout}` }]
          });
        }
        return response(200, {});
      });
      const inventory = vi.fn(async () => [tab]);
      const worker = loadWorker({
        local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
        tabsQuery: inventory
      });
      // Let the worker's independent startup inventory finish, then make only the repair scan
      // hang twice. Hygiene is allowed to continue from the next complete inventory.
      await Promise.resolve();
      inventory.mockReset();
      inventory
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([tab])
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValue([tab]);

      const firstAlarm = worker.fireAlarm();
      await vi.advanceTimersByTimeAsync(OPEN_CONVERSATION_INVENTORY_TIMEOUT_MS_FOR_TEST + 1);
      await vi.advanceTimersByTimeAsync(CLEANUP_CONVERSATION_INVENTORY_TIMEOUT_MS_FOR_TEST + 1);
      await vi.runAllTimersAsync();
      await firstAlarm;

      expect(worker.tabsReload).not.toHaveBeenCalled();
      expect(worker.tabsCreate).not.toHaveBeenCalled();
      expect(receipts).toEqual([]);
      expect(failures).toEqual(['reloaded']);

      // If the first hung scan retained maintenanceFlight, this second alarm would only set
      // maintenanceAgain and no repair could run. A bounded flight must instead reload now.
      const secondAlarm = worker.fireAlarm();
      await vi.runAllTimersAsync();
      await secondAlarm;
      expect(worker.tabsReload).toHaveBeenCalledExactlyOnceWith(43);
      expect(worker.tabsCreate).not.toHaveBeenCalled();
      expect(receipts).toEqual(['reloaded']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads the exact tab holding the chat the app named, and reports it once', async () => {
    const { fetch, asked, actions } = appWith(CHAT);
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(21);
    await worker.send({ type: 'bind', conversationId: CHAT }, 21);
    await worker.registerTab(22);
    await worker.send({ type: 'bind', conversationId: OTHER }, 22);

    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledTimes(1);
    expect(worker.tabsReload).toHaveBeenCalledWith(21);
    // Document registration also wakes maintenance immediately; the repair itself is once.
    expect(asked.filter((item) => item !== 'status')).toEqual([`repaired:${CHAT}`]);
    expect(asked[0]).toBe('status');
    expect(actions).toEqual(['reloaded']);

    // Reported, so the app has nothing outstanding and nothing here repeats it.
    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledTimes(1);
  });

  it('asks the exact existing chat to use native Retry without reloading or reconstructing a prompt', async () => {
    let armed = false;
    let handed = false;
    const receipts: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/repairs/claim') return response(200, { allowed: true });
      if (url.pathname === '/status') {
        if (url.searchParams.has('repaired')) receipts.push(url.searchParams.get('repairAction') || '');
        if (armed && !handed) {
          handed = true;
          return response(200, { repairs: [{ conversationId: CHAT, token: 'native-retry-token',
            reason: 'assistant-error', action: 'retry', requiresClaim: true }] });
        }
        return response(200, { repairs: [] });
      }
      return response(200, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(23);
    await worker.send({ type: 'bind', conversationId: CHAT }, 23);
    armed = true;
    await worker.fireAlarm();

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(23,
      { type: 'clf-retry-failed-turn', conversationId: CHAT });
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(receipts).toEqual(['retried']);
  });

  it('defers native Retry when the failed answer has resumed streaming instead of reporting a failed Retry', async () => {
    let armed = false;
    let handed = false;
    const deferred: string[] = [];
    const failed: string[] = [];
    const receipts: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/repairs/claim') return response(200, { allowed: true });
      if (url.pathname === '/status') {
        if (url.searchParams.has('repairDeferred')) {
          deferred.push(url.searchParams.get('repairCause') || '');
          return response(200, { repairs: [] });
        }
        if (url.searchParams.has('repairFailed')) failed.push(url.searchParams.get('repairAction') || '');
        if (url.searchParams.has('repaired')) receipts.push(url.searchParams.get('repairAction') || '');
        if (armed && !handed) {
          handed = true;
          return response(200, { repairs: [{ conversationId: CHAT, token: 'resumed-native-retry-token',
            reason: 'assistant-error', action: 'retry', requiresClaim: true }] });
        }
        return response(200, { repairs: [] });
      }
      return response(200, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsSendMessage: async (_id, message) => {
        if (message.type === 'clf-retry-failed-turn') return { ok: false, error: 'page_not_idle' };
        if (message.type === 'clf-page-status') return {
          ok: true, streaming: true, generating: true, pendingTools: 0, resumeStreamUnavailable: false
        };
        return { ok: true };
      }
    });
    await worker.registerTab(230);
    await worker.send({ type: 'bind', conversationId: CHAT }, 230);
    armed = true;
    await worker.fireAlarm();

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(230,
      { type: 'clf-retry-failed-turn', conversationId: CHAT });
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(230, { type: 'clf-page-status' }, undefined);
    expect(deferred).toEqual(['streaming']);
    expect(failed).toEqual([]);
    expect(receipts).toEqual([]);
    expect(worker.tabsReload).not.toHaveBeenCalled();
  });

  it.each(['not-ready', 'discarded', 'redirected', 'missing', 'transport-lost', 'spent'])('checks native Retry readiness without extra tab mutation: %s', async surface => {
    let armed = false;
    let handed = false;
    const deferred: Array<Record<string, string>> = [];
    const failed: string[] = [];
    const receipts: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/repairs/claim') return response(200, { allowed: true });
      if (url.pathname === '/status') {
        if (url.searchParams.has('repairDeferred')) {
          deferred.push(Object.fromEntries(url.searchParams.entries()));
          return response(200, { repairs: [] });
        }
        if (url.searchParams.has('repairFailed')) failed.push(url.searchParams.get('repairAction') || '');
        if (url.searchParams.has('repaired')) receipts.push(url.searchParams.get('repairAction') || '');
        if (armed && !handed) {
          handed = true;
          return response(200, { automationProfile: 'overnight', repairs: [{ conversationId: CHAT,
            token: 'not-ready-native-retry-token', reason: 'assistant-error', action: 'retry',
            retryControlPending: surface !== 'spent', requiresClaim: true, focus: true }] });
        }
        return response(200, { repairs: [] });
      }
      return response(200, {});
    });
    const tabs = [
      { id: 230, windowId: 7, url: surface === 'redirected' ? 'https://chatgpt.com/' : `https://chatgpt.com/c/${CHAT}`, active: false,
        discarded: surface === 'discarded' },
      { id: 231, windowId: 7, url: `https://chatgpt.com/c/${OTHER}`, active: true }
    ].filter(tab => surface !== 'missing' || tab.id !== 230);
    let retryCalls = 0;
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea({ appOwnedOpeningTabs: {
        '230': { createdAt: Date.now(), conversationId: CHAT, openState: 'opened' }
      } }), fetch,
      tabsQuery: async () => tabs,
      tabsSendMessage: async (_id, message) => {
        if (message.type !== 'clf-retry-failed-turn') return { ok: true, empty: true };
        retryCalls += 1;
        if (surface === 'transport-lost') throw new Error('transport lost');
        return { ok: false, error: surface === 'spent' && retryCalls === 1 ? 'retry_unavailable' : 'retry_not_ready' };
      }
    });
    for (const tab of tabs) await worker.createTab(tab);
    if (surface !== 'missing' && surface !== 'redirected') {
      await worker.registerTab(230);
      await worker.send({ type: 'bind', conversationId: CHAT }, 230);
    }
    worker.tabsUpdate.mockClear();
    armed = true;
    await worker.fireAlarm();
    expect(deferred).toEqual(surface === 'not-ready' ? [expect.objectContaining({
      repairDeferred: 'not-ready-native-retry-token', repairCause: 'retry-not-ready'
    })] : []);
    expect(failed).toEqual(surface === 'not-ready' ? [] : ['retried']);
    expect(retryCalls).toBe(['missing', 'redirected', 'discarded'].includes(surface) ? 0 : 1);
    expect(receipts).toEqual([]);
    if (surface !== 'spent') expect(worker.tabsUpdate.mock.calls.some(([, update]) => update.active === true)).toBe(false);
    expect(worker.tabsUpdate.mock.calls.some(([, update]) => typeof update.url === 'string')).toBe(false);
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it.each(['retry_unavailable', 'retry_not_ready', 'throw', 'private draft and token must not be recorded'])('reports bounded native Retry diagnostics: %s', async failure => {
    let armed = false;
    let handed = false;
    const failed: Array<Record<string, string>> = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/repairs/claim') return response(200, { allowed: true });
      if (url.pathname === '/status') {
        if (url.searchParams.has('repairFailed')) failed.push(Object.fromEntries(url.searchParams.entries()));
        if (armed && !handed) {
          handed = true;
          return response(200, { repairs: [{ conversationId: CHAT, token: 'diagnostic-native-retry-token',
            reason: 'assistant-error', action: 'retry', requiresClaim: true }] });
        }
        return response(200, { repairs: [] });
      }
      return response(200, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsSendMessage: async (_id, message) => {
        if (message.type !== 'clf-retry-failed-turn') return { ok: true };
        if (failure === 'throw') throw new Error('lost native action response');
        return { ok: false, error: failure };
      }
    });
    await worker.registerTab(230);
    await worker.send({ type: 'bind', conversationId: CHAT }, 230);
    await worker.createTab({ id: 230, url: `https://chatgpt.com/c/${CHAT}`, active: true });
    armed = true;
    await worker.fireAlarm();
    expect(failed).toEqual([expect.objectContaining({
      repairFailed: 'diagnostic-native-retry-token', repairAction: 'retried',
      repairFailure: failure === 'retry_unavailable' ? 'retry_unavailable' : failure === 'throw' ? 'native_retry_unavailable' : 'action_failed'
    })]);
    expect(JSON.stringify(failed)).not.toContain('private draft and token');
    expect(worker.tabsReload).not.toHaveBeenCalled();
  });

  it('parks a native Retry whose exact model/effort changed instead of falling through to reload', async () => {
    let armed = false;
    let handed = false;
    const deferred: Array<Record<string, string>> = [];
    const receipts: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/repairs/claim') return response(200, { allowed: true });
      if (url.pathname === '/status') {
        if (url.searchParams.has('repairDeferred')) {
          deferred.push(Object.fromEntries(url.searchParams.entries()));
          return response(200, { repairs: [] });
        }
        if (url.searchParams.has('repaired')) receipts.push(url.searchParams.get('repairAction') || '');
        if (armed && !handed) {
          handed = true;
          return response(200, { repairs: [{ conversationId: CHAT, token: 'retry-model-block-token',
            reason: 'assistant-error', action: 'retry', requiresClaim: true }] });
        }
        return response(200, { repairs: [] });
      }
      return response(200, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsSendMessage: async (_id, message) => message.type === 'clf-retry-failed-turn'
        ? { ok: false, error: 'retry_model_changed', modelBlocked: true, retrySpent: true,
            expectedModel: 'gpt-5-6-thinking', expectedEffort: 'high',
            actualModel: 'gpt-5-6-thinking', actualEffort: 'medium' }
        : { ok: true }
    });
    await worker.registerTab(24);
    await worker.send({ type: 'bind', conversationId: CHAT }, 24);
    armed = true;
    await worker.fireAlarm();

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(24,
      { type: 'clf-retry-failed-turn', conversationId: CHAT });
    expect(deferred).toEqual([expect.objectContaining({
      repairDeferred: 'retry-model-block-token', repairCause: 'model-blocked', retrySpent: '1',
      expectedModel: 'gpt-5-6-thinking', expectedEffort: 'high',
      actualModel: 'gpt-5-6-thinking', actualEffort: 'medium'
    })]);
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(receipts).toEqual([]);
  });

  it('temporarily selects an inactive exact chat when Retry has not hydrated, then restores the prior tab', async () => {
    let armed = false;
    let handed = false;
    let retryCalls = 0;
    const receipts: string[] = [];
    const tabs = [
      { id: 31, windowId: 7, url: `https://chatgpt.com/c/${OTHER}`, status: 'complete', active: true },
      { id: 32, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, status: 'complete', active: false }
    ];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/repairs/claim') return response(200, { allowed: true });
      if (url.pathname === '/status') {
        if (url.searchParams.has('repaired')) receipts.push(url.searchParams.get('repairAction') || '');
        if (armed && !handed) {
          handed = true;
          return response(200, { automationProfile: 'overnight', repairs: [{ conversationId: CHAT, token: 'hidden-native-retry-token',
            reason: 'assistant-error', action: 'retry', retryControlPending: false, requiresClaim: true }] });
        }
        return response(200, { repairs: [] });
      }
      return response(200, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsQuery: async () => tabs,
      tabsUpdate: async (id, properties) => {
        const tab = tabs.find(entry => entry.id === id)!;
        if (properties.active === true) {
          for (const entry of tabs) if (entry.windowId === tab.windowId) entry.active = false;
          tab.active = true;
        }
        return { ...tab, ...properties };
      },
      tabsSendMessage: async (id, message) => {
        if (id === 32 && message.type === 'clf-retry-failed-turn') {
          retryCalls += 1;
          return retryCalls === 1
            ? { ok: false, error: 'retry_not_ready' }
            : { ok: true };
        }
        return { ok: true };
      }
    });
    await worker.createTab(tabs[0]!);
    await worker.createTab(tabs[1]!);
    await worker.registerTab(32);
    await worker.send({ type: 'bind', conversationId: CHAT }, 32);
    worker.tabsUpdate.mockClear();
    worker.tabsSendMessage.mockClear();
    armed = true;
    await worker.fireAlarm();
    await new Promise(resolve => setTimeout(resolve, 425));

    expect(retryCalls).toBe(2);
    expect(worker.tabsUpdate.mock.calls.filter(([, update]) => update.active === true))
      .toEqual([[32, { active: true }], [31, { active: true }]]);
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(receipts).toEqual(['retried']);
    expect(tabs).toEqual(expect.arrayContaining([expect.objectContaining({ id: 31, active: true })]));
  });

  it('defers hidden-tab Retry in an attended focused window without moving tabs or spending the repair', async () => {
    let armed = false;
    let handed = false;
    const deferred: string[] = [];
    const tabs = [
      { id: 33, windowId: 7, url: `https://chatgpt.com/c/${OTHER}`, status: 'complete', active: true },
      { id: 34, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, status: 'complete', active: false }
    ];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/repairs/claim') return response(200, { allowed: true });
      if (url.pathname === '/status') {
        if (url.searchParams.has('repairDeferred')) {
          deferred.push(url.searchParams.get('repairCause') || '');
          return response(200, { repairs: [] });
        }
        if (armed && !handed) {
          handed = true;
          return response(200, { automationProfile: 'day', repairs: [{
            conversationId: CHAT,
            token: 'attended-hidden-native-retry-token',
            reason: 'assistant-error',
            action: 'retry',
            requiresClaim: true
          }] });
        }
        return response(200, { automationProfile: 'day', repairs: [] });
      }
      return response(200, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsQuery: async () => tabs,
      windowsGet: async id => ({ id, focused: true, state: 'normal' }),
      tabsSendMessage: async (id, message) => id === 34 && message.type === 'clf-retry-failed-turn'
        ? { ok: false, error: 'retry_not_ready' }
        : { ok: true }
    });
    await worker.createTab(tabs[0]!);
    await worker.createTab(tabs[1]!);
    await worker.registerTab(34);
    await worker.send({ type: 'bind', conversationId: CHAT }, 34);
    worker.tabsUpdate.mockClear();
    worker.tabsSendMessage.mockClear();
    armed = true;
    await worker.fireAlarm();

    expect(worker.tabsSendMessage.mock.calls.filter(([, message]) => message.type === 'clf-retry-failed-turn')).toHaveLength(1);
    expect(worker.tabsUpdate.mock.calls.some(([, update]) => update.active === true)).toBe(false);
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(deferred).toEqual(['foreground']);
  });

  it.each(['unattributed', 'silence'])('keeps a natively streaming chat alive during %s recovery', async (reason) => {
    let armed = false;
    let handed = false;
    const deferred: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/repairs/claim') return response(200, { allowed: true });
      if (url.pathname === '/status') {
        if (url.searchParams.has('repairDeferred')) {
          deferred.push(url.searchParams.get('repairCause') || '');
          return response(200, { ok: true, repairs: [] });
        }
        if (armed && !handed) {
          handed = true;
          return response(200, { repairs: [{ conversationId: CHAT, token: `streaming-${reason}`,
            reason, action: 'reload', requiresClaim: true }] });
        }
        return response(200, { repairs: [] });
      }
      return response(200, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsSendMessage: async (_id, message) => message.type === 'clf-page-status'
        ? { ok: true, streaming: true }
        : { ok: true }
    });
    await worker.registerTab(27);
    await worker.send({ type: 'bind', conversationId: CHAT }, 27);
    worker.tabsReload.mockClear();
    worker.tabsSendMessage.mockClear();
    armed = true;
    await worker.fireAlarm();

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(27, { type: 'clf-page-status' });
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(deferred).toEqual(['streaming']);
  });

  it('wakes a live automation page to collect its exact saved reply before considering reload', async () => {
    let armed = false;
    let handed = false;
    let goalCalls = 0;
    const receipts: string[] = [];
    const tabs = [
      { id: 25, windowId: 7, url: `https://chatgpt.com/c/${OTHER}`, status: 'complete', active: true },
      { id: 26, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, status: 'complete', active: false }
    ];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/repairs/claim') return response(200, { allowed: true });
      if (url.pathname === '/status') {
        if (url.searchParams.has('repaired')) receipts.push(url.searchParams.get('repairAction') || '');
        if (armed && !handed) {
          handed = true;
          return response(200, { automationProfile: 'day', repairs: [{ conversationId: CHAT, token: 'live-goal-wake-token',
            reason: 'automation', action: 'reload', requiresClaim: true }] });
        }
        return response(200, { repairs: [] });
      }
      return response(200, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsQuery: async () => tabs,
      windowsGet: async id => ({ id, focused: false, state: 'normal' }),
      tabsUpdate: async (id, properties) => {
        const tab = tabs.find(entry => entry.id === id)!;
        if (properties.active === true) {
          for (const entry of tabs) if (entry.windowId === tab.windowId) entry.active = false;
          tab.active = true;
        }
        return { ...tab, ...properties };
      },
      tabsSendMessage: async (_id, message) => {
        if (message.type !== 'clf-collect-goal-now') return { ok: true };
        goalCalls += 1;
        return { ok: true, pending: true, claimed: goalCalls > 1, drafting: false };
      }
    });
    await worker.createTab(tabs[0]!);
    await worker.createTab({ id: 26, url: `https://chatgpt.com/c/${CHAT}`, active: false });
    await worker.registerTab(26);
    await worker.send({ type: 'bind', conversationId: CHAT }, 26);
    worker.tabsCreate.mockClear();
    worker.tabsReload.mockClear();
    worker.tabsSendMessage.mockClear();
    armed = true;
    await worker.fireAlarm();
    await new Promise(resolve => setTimeout(resolve, 425));

    expect(goalCalls).toBe(2);
    expect(worker.tabsUpdate.mock.calls.filter(([, update]) => update.active === true))
      .toEqual([[26, { active: true }], [25, { active: true }]]);
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(receipts).toEqual(['nudged']);
  });

  it.each([
    {
      name: 'aggregate live work',
      result: { working: true, providerWorking: false, coreWorking: false, helperWorking: false,
        settledPending: false, composerBlocked: false, claimed: false },
      deferredCause: 'streaming', reloaded: false, receipt: null
    },
    {
      name: 'live provider work',
      result: { working: false, providerWorking: true, coreWorking: false, helperWorking: false,
        settledPending: false, composerBlocked: false, claimed: false },
      deferredCause: 'streaming', reloaded: false, receipt: null
    },
    {
      name: 'live Core work',
      result: { working: false, providerWorking: false, coreWorking: true, helperWorking: false,
        settledPending: false, composerBlocked: false, claimed: false },
      deferredCause: 'streaming', reloaded: false, receipt: null
    },
    {
      name: 'pending helper transport, not a live provider stream',
      result: { working: false, providerWorking: false, coreWorking: false, helperWorking: true,
        settledPending: false, composerBlocked: false, claimed: false },
      deferredCause: 'helper-pending', reloaded: false, receipt: null
    },
    {
      name: 'a blocked user composer beside the saved reply',
      result: { working: false, providerWorking: false, coreWorking: false, helperWorking: false,
        settledPending: true, composerBlocked: true, claimed: true, drafting: true },
      deferredCause: 'composer-blocked', reloaded: false, receipt: null
    },
    {
      name: 'an idle unclaimed settled reply',
      result: { working: false, providerWorking: false, coreWorking: false, helperWorking: false,
        settledPending: true, composerBlocked: false, claimed: false },
      deferredCause: null, reloaded: true, receipt: 'reloaded'
    }
  ])('handles $name without inventing browser progress', async ({ name, result, deferredCause, reloaded, receipt }) => {
    let armed = false;
    let handed = false;
    const deferred: string[] = [];
    const receipts: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/repairs/claim') return response(200, { allowed: true });
      if (url.pathname === '/status') {
        if (url.searchParams.has('repairDeferred')) {
          deferred.push(url.searchParams.get('repairCause') || '');
          return response(200, { repairs: [] });
        }
        if (url.searchParams.has('repaired')) receipts.push(url.searchParams.get('repairAction') || '');
        if (armed && !handed) {
          handed = true;
          return response(200, { repairs: [{ conversationId: CHAT, token: `goal-recovery-${name}`,
            reason: 'automation', action: 'reload', requiresClaim: true }] });
        }
        return response(200, { repairs: [] });
      }
      return response(200, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsSendMessage: async (_id, message) => message.type === 'clf-collect-goal-now'
        ? {
            ok: true,
            pending: true,
            ...result
          }
        : { ok: true }
    });
    await worker.createTab({ id: 46, url: `https://chatgpt.com/c/${CHAT}`, active: true });
    await worker.registerTab(46);
    await worker.send({ type: 'bind', conversationId: CHAT }, 46);
    worker.tabsReload.mockClear();
    worker.tabsCreate.mockClear();
    armed = true;
    await worker.fireAlarm();

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(46,
      { type: 'clf-collect-goal-now', conversationId: CHAT });
    if (reloaded) expect(worker.tabsReload).toHaveBeenCalledWith(46);
    else expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(deferred).toEqual(deferredCause ? [deferredCause] : []);
    expect(receipts).toEqual(receipt ? [receipt] : []);
  });

  it.each(['compact', 'continue'])('dispatches interrupted-response %s in the exact existing chat without opening or reloading a tab', async action => {
    let armed = false;
    let handed = false;
    const receipts: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/repairs/claim') return response(200, { allowed: true });
      if (url.pathname === '/status') {
        if (url.searchParams.has('repaired')) receipts.push(url.searchParams.get('repairAction') || '');
        if (armed && !handed) {
          handed = true;
          return response(200, { repairs: [{ conversationId: CHAT, token: 'compact-interrupted-token',
            reason: 'assistant-error', action, requiresClaim: true }] });
        }
        return response(200, { repairs: [] });
      }
      return response(200, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(25);
    await worker.send({ type: 'bind', conversationId: CHAT }, 25);
    armed = true;
    await worker.fireAlarm();

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(25,
      { type: action === 'compact' ? 'clf-compact-interrupted-turn' : 'clf-stop-interrupted-turn', conversationId: CHAT });
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(receipts).toEqual([action === 'compact' ? 'compacted' : 'stopped']);
  });

  it.each([
    ['unattributed', 'reload'],
    ['assistant-error', 'reload'],
    ['assistant-error', 'retry'],
    ['assistant-error', 'continue'],
    ['compaction', 'compact'],
    ['compaction', 'reload']
  ] as const)('rechecks a claimed %s %s against native Core custody immediately before browser mutation', async (reason, action) => {
    let armed = false, handed = false;
    const phases: string[] = [], deferrals: string[] = [];
    const fetch = vi.fn(async (input: string, init: any = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/repairs/claim') {
        const body = JSON.parse(String(init.body));
        expect(body.token).toBe('native-result-claim-race');
        const phase = body.phase === 'recheck' ? 'recheck' : 'claim';
        phases.push(phase);
        // The original token was valid at claim, but the native tool becomes
        // unresolved before this particular Chrome operation begins.
        return response(200, { allowed: phase !== 'recheck' });
      }
      if (url.pathname === '/status') {
        if (url.searchParams.has('repairDeferred'))
          deferrals.push(url.searchParams.get('repairCause') || '');
        if (armed && !handed) {
          handed = true;
          return response(200, { repairs: [{ conversationId: CHAT,
            token: 'native-result-claim-race', reason, action,
            focus: true, requiresClaim: true }] });
        }
        return response(200, { repairs: [] });
      }
      return response(200, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired),
      session: new FakeStorageArea(), fetch });
    await worker.createTab({ id: 51, url: `https://chatgpt.com/c/${CHAT}`, active: false });
    await worker.registerTab(51);
    await worker.send({ type: 'bind', conversationId: CHAT }, 51);
    worker.tabsReload.mockClear();
    worker.tabsCreate.mockClear();
    worker.tabsSendMessage.mockClear();
    armed = true;
    await worker.fireAlarm();
    expect(phases).toEqual(['claim', 'recheck']);
    expect(deferrals).toEqual(['claim-revoked']);
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsUpdate.mock.calls.some(([, props]) => props?.active === true)).toBe(false);
    expect(worker.tabsSendMessage).not.toHaveBeenCalledWith(51,
      expect.objectContaining({ type: action === 'retry' ? 'clf-retry-failed-turn'
        : action === 'compact' ? 'clf-compact-interrupted-turn'
        : 'clf-stop-interrupted-turn' }));
  });

  it.each(['goal', 'automation'] as const)(
    'refuses a revoked %s recovery before touching an exact discarded browser tab', async reason => {
      let armed = false;
      let handed = false;
      const trace: string[] = [];
      const worker = loadWorker({
        local: new FakeStorageArea(paired), session: new FakeStorageArea(),
        fetch: async (input, init = {}) => {
          const url = new URL(input);
          if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
          if (url.pathname === '/repairs/claim') {
            expect(JSON.parse(String(init.body))).toMatchObject({ token: 'native-hold-discarded' });
            trace.push('claim-denied');
            return response(200, { allowed: false });
          }
          if (url.pathname === '/status') {
            if (url.searchParams.has('repaired')) trace.push('repaired');
            if (url.searchParams.has('repairDeferred')) trace.push('deferred');
            if (armed && !handed) {
              handed = true;
              return response(200, { repairs: [{
                conversationId: CHAT, token: 'native-hold-discarded', reason,
                action: 'reload', requiresClaim: true
              }] });
            }
            return response(200, { repairs: [] });
          }
          return response(200, {});
        }
      });
      await worker.createTab({ id: 48, url: `https://chatgpt.com/c/${CHAT}`, discarded: true });
      await worker.registerTab(48);
      await worker.send({ type: 'bind', conversationId: CHAT }, 48);
      for (let tick = 0; tick < 6; tick += 1) await new Promise(resolve => setTimeout(resolve, 0));
      worker.tabsReload.mockClear();
      worker.tabsUpdate.mockClear();
      armed = true;
      await worker.fireAlarm();
      expect(trace).toEqual(['claim-denied']);
      expect(worker.tabsReload).not.toHaveBeenCalled();
      expect(worker.tabsUpdate).not.toHaveBeenCalledWith(48, { autoDiscardable: false });
      expect(trace).not.toContain('repaired');
    }
  );

  it.each(['initial-revoked', 'after-claim-revoked'] as const)(
    'retains the exact redirected Goal root and its original local custody when %s', async phase => {
      let armed = false;
      let handed = false;
      const trace: string[] = [];
      const rootTab = { id: 50, windowId: 7, url: 'https://chatgpt.com/',
        status: 'complete', active: false, pinned: false };
      const session = new FakeStorageArea({
        appOwnedOpeningTabs: { '50': { createdAt: Date.now(), conversationId: CHAT,
          openRequestId: 'goal-redirected-root', openState: 'redirected', retargetCount: 0 } },
        tabDocuments: { '50': 'doc-50' }, tabEpochs: { '50': 0 }
      });
      const worker = loadWorker({
        local: new FakeStorageArea(paired), session,
        fetch: async (input, init = {}) => {
          const url = new URL(input);
          if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
          if (url.pathname === '/repairs/claim') {
            const body = JSON.parse(String(init.body));
            trace.push(body.phase === 'recheck' ? 'recheck' : 'claim');
            return response(200, { allowed: phase === 'after-claim-revoked' && body.phase !== 'recheck' });
          }
          if (url.pathname === '/status') {
            if (url.searchParams.has('repairDeferred')) {
              trace.push('deferred');
              return response(200, { repairs: [] });
            }
            if (url.searchParams.has('repaired')) trace.push('repaired');
            if (armed && !handed) {
              handed = true;
              return response(200, { repairs: [{ conversationId: CHAT,
                token: 'redirected-claim-custody', reason: 'goal', action: 'reload', requiresClaim: true }] });
            }
            return response(200, { repairs: [] });
          }
          return response(200, {});
        },
        tabsQuery: async () => [rootTab],
        tabsGet: async () => rootTab,
        tabsSendMessage: async (_id, message) => {
          if (message.type === 'clf-tab-close-check') {
            trace.push('proved-empty-root');
            return { safe: true, conversationId: null, navigationEpoch: 0 };
          }
          return { ok: true };
        }
      });
      await worker.registerTab(50, 'doc-50');
      await worker.fireAlarm();
      worker.tabsUpdate.mockClear();
      worker.tabsCreate.mockClear();
      worker.tabsSendMessage.mockClear();
      armed = true;
      await worker.fireAlarm();
      expect(trace).toContain('proved-empty-root');
      expect(trace).toContain('claim');
      if (phase === 'after-claim-revoked') expect(trace).toContain('recheck');
      expect(trace).not.toContain('repaired');
      expect(worker.tabsCreate).not.toHaveBeenCalled();
      expect(worker.tabsUpdate.mock.calls.some(([, props]) => typeof props.url === 'string')).toBe(false);
      expect(worker.tabsSendMessage.mock.calls.some(([, msg]) => msg.type === 'clf-dismiss-access-throttle')).toBe(false);
      expect(session.data.appOwnedOpeningTabs).toMatchObject({
        '50': { conversationId: CHAT, openState: 'redirected', retargetCount: 0 }
      });
    }
  );

  it.each([
    ['wrong_conversation', 'conversation_changed'],
    ['recorder_inactive', 'recorder_inactive']
  ])('refuses a stale %s Goal collector without reloading the old or foreign tab', async (error, failure) => {
    let armed = false;
    let handed = false;
    const failures: string[] = [];
    const trace: string[] = [];
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(),
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/repairs/claim') {
          trace.push(JSON.parse(String(init.body)).phase === 'recheck' ? 'recheck' : 'claim');
          return response(200, { allowed: true });
        }
        if (url.pathname === '/status') {
          if (url.searchParams.has('repairFailed')) failures.push(url.searchParams.get('repairFailure') || '');
          if (url.searchParams.has('repaired')) trace.push('repaired');
          if (armed && !handed) {
            handed = true;
            return response(200, { repairs: [{
              conversationId: CHAT, token: 'stale-goal-document', reason: 'goal',
              action: 'reload', requiresClaim: true
            }] });
          }
          return response(200, { repairs: [] });
        }
        return response(200, {});
      },
      tabsSendMessage: async (_id, message) => message.type === 'clf-collect-goal-now'
        ? { ok: false, pending: false, error } : { ok: true }
    });
    await worker.createTab({ id: 50, url: `https://chatgpt.com/c/${CHAT}`, active: true });
    await worker.registerTab(50);
    await worker.send({ type: 'bind', conversationId: CHAT }, 50);
    worker.tabsReload.mockClear();
    armed = true;
    await worker.fireAlarm();
    expect(trace).toContain('claim');
    expect(failures).toEqual([failure]);
    expect(trace).not.toContain('repaired');
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('never reloads a foreign tab that navigated after its exact Goal collector response', async () => {
    let armed = false;
    let handed = false;
    let currentUrl = `https://chatgpt.com/c/${CHAT}`;
    const trace: string[] = [];
    const failures: string[] = [];
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(),
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/repairs/claim') {
          const body = JSON.parse(String(init.body));
          expect(body.token).toBe('navigated-after-goal-collection');
          trace.push(body.phase === 'recheck' ? 'recheck' : 'claim');
          return response(200, { allowed: true });
        }
        if (url.pathname === '/status') {
          if (url.searchParams.has('repairFailed')) failures.push(url.searchParams.get('repairFailure') || '');
          if (url.searchParams.has('repaired')) trace.push('repaired');
          if (armed && !handed) {
            handed = true;
            return response(200, { repairs: [{
              conversationId: CHAT, token: 'navigated-after-goal-collection',
              reason: 'goal', action: 'reload', requiresClaim: true
            }] });
          }
          return response(200, { repairs: [] });
        }
        return response(200, {});
      },
      tabsQuery: async () => [{ id: 51, windowId: 7, active: true, url: currentUrl, status: 'complete' }],
      tabsGet: async () => ({ id: 51, url: currentUrl, status: 'complete' }),
      tabsSendMessage: async (_id, message) => {
        if (message.type !== 'clf-collect-goal-now') return { ok: true };
        // The content reply was valid for CHAT, but the user immediately
        // navigated the tab to OTHER before the fallback could reload it.
        currentUrl = `https://chatgpt.com/c/${OTHER}`;
        return { ok: true, conversationId: CHAT, epoch: 0, pending: true,
          claimed: false, settledPending: true, working: false,
          providerWorking: false, coreWorking: false, helperWorking: false,
          composerBlocked: false };
      }
    });
    await worker.registerTab(51);
    await worker.send({ type: 'bind', conversationId: CHAT }, 51);
    worker.tabsReload.mockClear();
    armed = true;
    await worker.fireAlarm();
    expect(trace).toContain('claim');
    expect(trace).toContain('recheck');
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(failures).toEqual(['conversation_changed']);
    expect(trace).not.toContain('repaired');
  });

  it('does not reload a responsive Goal page after native uncertainty appears between claim and live collector response', async () => {
    let armed = false;
    let handed = false;
    const trace: string[] = [];
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(),
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/repairs/claim') {
          const body = JSON.parse(String(init.body));
          expect(body.token).toBe('native-hold-after-claim');
          trace.push(body.phase === 'recheck' ? 'recheck-denied' : 'claim');
          return response(200, { allowed: body.phase !== 'recheck' });
        }
        if (url.pathname === '/status') {
          if (url.searchParams.has('repaired')) trace.push('repaired');
          if (url.searchParams.has('repairDeferred')) trace.push('deferred');
          if (armed && !handed) {
            handed = true;
            return response(200, { repairs: [{
              conversationId: CHAT, token: 'native-hold-after-claim', reason: 'goal',
              action: 'reload', requiresClaim: true
            }] });
          }
          return response(200, { repairs: [] });
        }
        return response(200, {});
      },
      tabsSendMessage: async (_id, message) => message.type === 'clf-collect-goal-now'
        ? { ok: true, pending: true, claimed: false, settledPending: true,
            working: false, providerWorking: false, coreWorking: false,
            helperWorking: false, composerBlocked: false }
        : { ok: true }
    });
    await worker.createTab({ id: 49, url: `https://chatgpt.com/c/${CHAT}`, active: true });
    await worker.registerTab(49);
    await worker.send({ type: 'bind', conversationId: CHAT }, 49);
    worker.tabsReload.mockClear();
    armed = true;
    await worker.fireAlarm();
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(49,
      { type: 'clf-collect-goal-now', conversationId: CHAT });
    expect(trace).toContain('claim');
    expect(trace).toContain('recheck-denied');
    expect(trace).not.toContain('repaired');
    expect(worker.tabsReload).not.toHaveBeenCalled();
  });

  it('restores a discarded owed tab only after Core claim/recheck, without clicking native Retry prematurely', async () => {
    let armed = false;
    let due = false;
    let minted = 0;
    const trace: string[] = [];
    const fetch = vi.fn(async (input: string, init: any = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/repairs/claim') {
        trace.push(JSON.parse(String(init.body)).phase === 'recheck' ? 'recheck' : 'claim');
        return response(200, { allowed: true });
      }
      if (url.pathname === '/status') {
        if (url.searchParams.has('repairDeferred')) {
          trace.push('deferred');
          due = true;
          return response(200, { ok: true, repairs: [], nonDiscardableConversations: [CHAT] });
        }
        if (url.searchParams.has('repaired')) {
          trace.push(`repaired:${url.searchParams.get('repairAction')}`);
          due = false;
          return response(200, { ok: true, repairs: [], nonDiscardableConversations: [CHAT] });
        }
        if (armed && due) {
          due = false;
          return response(200, { ok: true, nonDiscardableConversations: [CHAT], repairs: [{
            conversationId: CHAT, token: `discarded-${++minted}`, reason: 'assistant-error',
            action: 'retry', requiresClaim: true
          }] });
        }
        return response(200, { ok: true, repairs: [], nonDiscardableConversations: [CHAT] });
      }
      return response(200, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsSendMessage: async (_id, message) => {
        if (message.type === 'clf-retry-failed-turn') trace.push('retry');
        return { ok: true };
      }
    });
    await worker.createTab({ id: 24, url: `https://chatgpt.com/c/${CHAT}`, discarded: true });
    await worker.registerTab(24);
    await worker.send({ type: 'bind', conversationId: CHAT }, 24);
    // Document registration wakes its own maintenance pass. Let that pass observe the idle app
    // before arming the synthetic repair; the exact-root preflight adds another bounded await.
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
    armed = true;
    due = true;

    await worker.fireAlarm();
    expect(worker.tabsUpdate).toHaveBeenCalledWith(24, { autoDiscardable: false });
    expect(worker.tabsReload).toHaveBeenCalledExactlyOnceWith(24);
    expect(worker.tabsSendMessage).not.toHaveBeenCalledWith(24,
      { type: 'clf-retry-failed-turn', conversationId: CHAT });
    expect(trace).toEqual(['claim', 'recheck', 'deferred']);
    expect(worker.tabsUpdate.mock.calls.some(([, properties]) => properties?.active === true)).toBe(false);

    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledTimes(1);
    expect(trace).toEqual(['claim', 'recheck', 'deferred', 'claim', 'recheck', 'retry', 'repaired:retried']);
  });

  it.each(['unattributed', 'assistant-error', 'no-tab', 'goal', 'compaction', 'automation', 'silence'].flatMap(reason =>
    ['unresolved', 'resolved-during-scan', 'claim-unavailable'].map(mode => ({ reason, mode }))))(
    'claims $reason recovery after the tab scan: $mode', async ({ reason, mode }) => {
      let armed = false;
      let handed = false;
      let resolved = false;
      const trace: string[] = [];
      const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/repairs/claim') {
          const body = JSON.parse(String(init.body));
          trace.push(body.phase === 'recheck' ? 'recheck' : 'claim');
          expect(init.method).toBe('POST');
          expect(body).toEqual({ token: 'attribution-attempt',
            ...(body.phase === 'recheck' ? { phase: 'recheck' } : {}) });
          return mode === 'claim-unavailable' ? response(503, {}) : response(200, { allowed: !resolved });
        }
        if (url.pathname === '/status') {
          if (url.searchParams.has('repaired')) trace.push('repaired');
          if (armed && !handed) {
            handed = true;
            trace.push('handout');
            return response(200, { repairs: [{ conversationId: CHAT, token: 'attribution-attempt', reason, requiresClaim: true }] });
          }
          return response(200, { repairs: [] });
        }
        return response(200, {});
      });
      const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
        tabsSendMessage: async () => ({ ok: true, conversationId: CHAT, epoch: 0 }),
        tabsGet: async () => ({ id: 21, url: `https://chatgpt.com/c/${CHAT}`, status: 'complete' }),
        tabsQuery: async () => {
          if (handed) {
            trace.push('scan');
            if (mode === 'resolved-during-scan') resolved = true;
          }
          return [{ id: 21, url: `https://chatgpt.com/c/${CHAT}` }];
        } });
      await worker.registerTab(21);
      await worker.send({ type: 'bind', conversationId: CHAT }, 21);
      await worker.fireAlarm();
      armed = true;
      await worker.fireAlarm();
      expect(trace.indexOf('scan')).toBeGreaterThan(trace.indexOf('handout'));
      expect(trace.indexOf('claim')).toBeGreaterThan(trace.indexOf('scan'));
      if (mode === 'unresolved') {
        if (reason === 'no-tab') expect(worker.tabsReload).not.toHaveBeenCalled();
        else expect(worker.tabsReload).toHaveBeenCalledExactlyOnceWith(21);
        expect(trace).toContain('repaired');
      } else {
        expect(worker.tabsReload).not.toHaveBeenCalled();
        expect(trace).not.toContain('repaired');
      }
      expect(worker.tabsCreate).not.toHaveBeenCalled();
    }
  );

  /**
   * Two tabs of one chat used to end the repair: neither was reloaded and the duplicate stayed
   * open, so the chat was left broken *and* the tab spam was left standing. One chat is one tab,
   * so the ambiguity is resolved rather than deferred - the registry-bound copy is the one
   * reloaded, deterministically, and no third tab is ever created to settle it.
   */
  it.each([
    { page: 'loading', loading: true, answers: false, reload: false },
    { page: 'answering', loading: false, answers: true, reload: false },
    { page: 'silent', loading: false, answers: false, reload: true }
  ])('preserves a $page worker tab when a stale no-tab repair arrives', async ({ loading, answers, reload }) => {
    let armed = false;
    let handed = false;
    const receipts: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/repairs/claim') return response(200, { allowed: true });
      if (url.pathname === '/status') {
        if (url.searchParams.has('repaired')) receipts.push(url.searchParams.get('repairAction') || '');
        if (armed && !handed) {
          handed = true;
          return response(200, { repairs: [{ conversationId: CHAT, token: 'wake-tab', reason: 'no-tab', requiresClaim: true }] });
        }
        return response(200, { repairs: [] });
      }
      return response(200, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsGet: async () => ({ id: 21, url: `https://chatgpt.com/c/${CHAT}`, status: loading ? 'loading' : 'complete' }),
      tabsQuery: async () => [{ id: 21, url: `https://chatgpt.com/c/${CHAT}` }],
      tabsSendMessage: async (_id, message) => message.type === 'clf-page-status' && answers
        ? { ok: true, conversationId: CHAT, epoch: 0, streaming: false } : undefined
    });
    await worker.registerTab(21);
    await worker.send({ type: 'bind', conversationId: CHAT }, 21);
    await worker.fireAlarm();
    armed = true;
    await worker.fireAlarm();
    if (reload) expect(worker.tabsReload).toHaveBeenCalledExactlyOnceWith(21);
    else expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(receipts).toEqual([reload ? 'reloaded' : 'present']);
  });

  it.each(['foreign-before', 'foreign-during', 'document-replaced', 'wrong-page'])(
    'does not reload or acknowledge no-tab presence after %s', async mode => {
      let armed = false;
      let handed = false;
      let pendingUrl: string | undefined;
      let changed = false;
      const receipts: string[] = [];
      const failures: string[] = [];
      const fetch = vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/repairs/claim') {
          if (mode === 'foreign-before') pendingUrl = `https://chatgpt.com/c/${OTHER}`;
          return response(200, { allowed: true });
        }
        if (url.pathname === '/status') {
          if (url.searchParams.has('repaired')) receipts.push(url.searchParams.get('repairAction') || '');
          if (url.searchParams.has('repairFailed')) failures.push(url.searchParams.get('repairFailed') || '');
          if (armed && !handed) {
            handed = true;
            return response(200, { repairs: [{ conversationId: CHAT, token: 'stale-wake-tab', reason: 'no-tab', requiresClaim: true }] });
          }
          return response(200, { repairs: [] });
        }
        return response(200, {});
      });
      const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
        tabsGet: async () => ({ id: 21, url: `https://chatgpt.com/c/${CHAT}`, pendingUrl, status: 'complete' }),
        tabsQuery: async () => [{ id: 21, url: `https://chatgpt.com/c/${CHAT}` }],
        tabsSendMessage: async (_id, message) => {
          if (message.type !== 'clf-page-status' || !handed || changed) return undefined;
          changed = true;
          if (mode === 'foreign-during') pendingUrl = `https://chatgpt.com/c/${OTHER}`;
          if (mode === 'document-replaced') {
            await worker.startTabNavigation(21);
            await worker.registerTab(21, 'replacement-document');
          }
          return { ok: true, conversationId: mode === 'wrong-page' ? OTHER : CHAT, epoch: 0 };
        }
      });
      await worker.registerTab(21);
      await worker.send({ type: 'bind', conversationId: CHAT }, 21);
      await worker.fireAlarm();
      armed = true;
      await worker.fireAlarm();
      expect(worker.tabsReload).not.toHaveBeenCalled();
      expect(worker.tabsCreate).not.toHaveBeenCalled();
      expect(receipts).toEqual([]);
      expect(failures).toEqual(['stale-wake-tab']);
    }
  );

  it('reloads the registry-bound copy when one chat has two tabs', async () => {
    const { fetch, asked } = appWith(CHAT);
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(31);
    await worker.send({ type: 'bind', conversationId: CHAT }, 31);
    await worker.registerTab(32);
    await worker.send({ type: 'bind', conversationId: CHAT }, 32);

    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledTimes(1);
    expect(worker.tabsReload).toHaveBeenCalledWith(31);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(asked).toContain(`repaired:${CHAT}`);

    // Reported, so nothing outstanding remains and the duplicate is never reloaded after it.
    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledTimes(1);
  });

  /** A reload that throws reports that attempt as failed, then the next pass retries it. */
  it('retries a repair whose reload failed', async () => {
    const { fetch, asked, failedActions, arm } = appWith(null);
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(51);
    await worker.send({ type: 'bind', conversationId: CHAT }, 51);
    await worker.fireAlarm();
    asked.length = 0;
    worker.tabsReload.mockRejectedValueOnce(new Error('tab is gone'));
    arm(CHAT);

    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledTimes(1);
    expect(asked).toEqual(['status', `failed:${CHAT}`]);
    expect(failedActions).toEqual(['reloaded']);

    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledTimes(2);
    expect(asked).toEqual(['status', `failed:${CHAT}`, 'status', `repaired:${CHAT}`]);
  });

  /** A missing exact chat is opened once after the same fresh scan that prevents duplicates. */
  it('opens the exact chat when the scan proves this browser is not holding it', async () => {
    const { fetch, asked, actions } = appWith(OTHER);
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(41);
    await worker.send({ type: 'bind', conversationId: CHAT }, 41);

    await worker.fireAlarm();
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).toHaveBeenCalledWith({ url: `https://chatgpt.com/c/${OTHER}`, active: false });
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
    expect(asked[0]).toBe('status');
    expect(asked.filter(entry => entry !== 'status')).toEqual([`repaired:${OTHER}`]);
    expect(actions).toEqual(['reopened']);
  });

  it('protects a missing background repair tab until the app releases its repair policy', async () => {
    let repairDue = true;
    let protect = true;
    const session = new FakeStorageArea({ chatBackgroundWindow: 7 });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/status') {
        if (url.searchParams.get('repaired') === 'background-repair') repairDue = false;
        return response(200, {
          ok: true,
          background: true,
          repairs: repairDue ? [{ conversationId: OTHER, token: 'background-repair' }] : [],
          nonDiscardableConversations: protect ? [OTHER] : []
        });
      }
      return response(200, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session, fetch,
      windowsGet: async () => ({ id: 7, focused: false })
    });

    await worker.fireAlarm();
    expect(worker.tabsCreate).toHaveBeenCalledWith({
      url: `https://chatgpt.com/c/${OTHER}`,
      active: false
    });
    expect(worker.tabsUpdate).toHaveBeenCalledWith(99, { autoDiscardable: false });
    expect(session.data.discardProtectedTabs).toEqual({ '99': true });

    // A later pass during the app's done-awaiting-activity window must keep the protection.
    worker.tabsUpdate.mockClear();
    await worker.fireAlarm();
    expect(worker.tabsUpdate).not.toHaveBeenCalledWith(99, { autoDiscardable: true });
    expect(session.data.discardProtectedTabs).toEqual({ '99': true });

    // Once main removes the repair from policy, ordinary hygiene restores the setting it owns.
    protect = false;
    await worker.fireAlarm();
    expect(worker.tabsUpdate).toHaveBeenCalledWith(99, { autoDiscardable: true });
    expect(session.data.discardProtectedTabs).toEqual({});
  });

  it('places a background Resume beside its exact Prime without creating or using a dedicated window', async () => {
    const commandId = 'de01c492cdde4054';
    const source = 'abababab-1111-4222-8333-555555555555';
    const project = 'g-p-0123456789abcdef0123456789abcdef';
    const home = { id: 45, windowId: 9, index: 2, active: true, status: 'complete',
      url: `https://chatgpt.com/c/${source}` };
    const session = new FakeStorageArea({ chatBackgroundWindow: 7 });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : {
            ok: true,
            repairs: [],
            background: true,
            placement: {
              id: commandId,
              background: true,
              active: false,
              homeConversationId: source,
              project
            }
          }),
      tabsQuery: async () => [home],
      tabsGet: async id => id === home.id ? home : { id, windowId: 9, status: 'loading' },
      windowsGet: async id => ({ id, focused: id === 9 })
    });

    await worker.fireAlarm();

    expect(worker.tabsCreate).toHaveBeenCalledWith(expect.objectContaining({
      windowId: 9,
      active: false,
      url: expect.stringContaining(`https://chatgpt.com/c/${source}?clf=${commandId}&clf_project=1`)
    }));
  });

  it('places a non-background worker inactive in its Prime window', async () => {
    const commandId = '4e689b755134a55a';
    const source = 'abababab-1111-4222-8333-555555555555';
    const home = { id: 45, windowId: 9, index: 2, active: true, status: 'complete',
      url: `https://chatgpt.com/c/${source}` };
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : {
            ok: true,
            repairs: [],
            background: false,
            placement: {
              id: commandId,
              worker: true,
              active: false,
              homeConversationId: source,
              project: null
            }
          }),
      tabsQuery: async () => [home],
      tabsGet: async id => id === home.id ? home : { id, windowId: 9, status: 'loading' },
      tabsCreate: async properties => ({ id: 99, windowId: Number(properties.windowId),
        active: properties.active, status: 'loading', url: String(properties.url) })
    });

    await worker.fireAlarm();

    expect(worker.tabsCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      windowId: 9,
      active: false,
      url: expect.stringContaining(`https://chatgpt.com/?clf=${commandId}`)
    }));
    expect(worker.tabsUpdate).toHaveBeenCalledWith(99, { autoDiscardable: false });
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
  });

  /**
   * Automatic compaction selects its exact tab before reload while preserving
   * OS focus on the user's current app, even when Chrome is minimized.
   */
  it('selects the repair tab before reload without activating the Chrome window', async () => {
    let outstanding: string | null = CHAT;
    let token = '';
    let minted = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/closed') return response(200, { ok: true });
      if (url.pathname === '/status') {
        const repaired = url.searchParams.get('repaired');
        if (repaired && repaired === token) outstanding = outstanding === CHAT ? OTHER : null;
        if (!outstanding) return response(200, { ok: true, repairs: [] });
        token = `tok-${(minted += 1)}`;
        return response(200, { ok: true, repairs: [{ conversationId: outstanding, token, focus: true }] });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(51);
    await worker.send({ type: 'bind', conversationId: CHAT }, 51);

    await worker.fireAlarm();
    expect(worker.tabsUpdate).toHaveBeenCalledWith(51, { active: true });
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
    expect(worker.tabsReload).toHaveBeenCalledWith(51);
    const raised = worker.tabsUpdate.mock.invocationCallOrder.find(
      (_order, index) => worker.tabsUpdate.mock.calls[index]?.[1]?.active === true
    );
    expect(raised).toBeLessThan(worker.tabsReload.mock.invocationCallOrder[0]!);

    await worker.fireAlarm();
    expect(worker.tabsCreate).toHaveBeenCalledWith({ url: `https://chatgpt.com/c/${OTHER}`, active: true });
  });

  it('opens an active agent chat in the same close transaction instead of losing its retry alarm', async () => {
    const asked: string[] = [];
    let repaired = false;
    let closed = false;
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/closed' && init.method === 'POST') {
        closed = true;
        return response(200, { ok: true });
      }
      if (url.pathname === '/status') {
        const receipt = url.searchParams.get('repaired');
        asked.push(receipt ? `repaired:${receipt}` : 'status');
        if (receipt === 'close-repair') repaired = true;
        return response(200, {
          ok: true,
          recoveryMonitoring: closed && !repaired,
          repairs: !closed || repaired ? [] : [{ conversationId: CHAT, token: 'close-repair' }]
        });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(71);
    await worker.send({ type: 'bind', conversationId: CHAT }, 71);

    await worker.closeTab(71);
    for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
    expect(worker.tabsCreate).toHaveBeenCalledWith({ url: `https://chatgpt.com/c/${CHAT}`, active: false });
    expect(asked.filter((item) => item !== 'status')).toEqual(['repaired:close-repair']);
    expect(asked[0]).toBe('status');
    expect(worker.alarmClear).not.toHaveBeenCalled();
  });

  /**
   * The alarm is the only thing that wakes a stopped service worker, and a dead reporter is
   * precisely the case where no page will wake it. So holding a chat is itself a reason to
   * keep the alarm running - without that, the repair waits for traffic that never comes.
   */
  /**
   * Paired is reason enough to ask. The app hands out reopen work only when this worker asks,
   * and after a browser restart the worker holds no tabs — which is exactly when a Loop chat
   * the user closed is waiting to be opened again (2026-09-02: a Loop prime never came back
   * because the worker, holding nothing, never asked).
   */
  it('keeps its maintenance alarm running and asks the app on every pass while it is paired, tabs or none', async () => {
    const { fetch, asked } = appWith(null);
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.fireAlarm();
    expect(asked).toEqual(['status']);
    expect(worker.alarmCreate).toHaveBeenCalledWith('clf-bridge-drain', { delayInMinutes: 0.5 });

    await worker.registerTab(51);
    await worker.send({ type: 'bind', conversationId: CHAT }, 51);
    await worker.fireAlarm();
    // Fresh content readiness wakes a pass without waiting for the maintenance alarm.
    expect(asked).toEqual(['status', 'status', 'status']);
  });

  it('asks nobody while it is not paired', async () => {
    const { fetch, asked } = appWith(null);
    const worker = loadWorker({ local: new FakeStorageArea({}), session: new FakeStorageArea(), fetch });
    await worker.fireAlarm();
    expect(asked).toEqual([]);
  });

  /**
   * How long a repair can sit in the app before this browser sees it.
   *
   * The app arms a repair fifteen to sixty seconds into an unattributed incident. A collector
   * that came round once a minute would make that deadline meaningless: an alarm created at
   * T+0 with `periodInMinutes: 1` ticks at T+15, too early for the app to have decided, and
   * then not again until T+75.
   *
   * Every pass re-arms the next one at Chrome's floor instead. Thirty seconds is that floor -
   * alarms fire at most twice a minute, and a packed extension has anything shorter clamped up
   * to it whatever this asks for - so the honest guarantee is that a repair armed at T+20 is
   * collected by T+50 at the latest, not that it is collected at T+20. One alarm, one owner,
   * one cadence, and it still stops dead when there is nothing left to hold.
   */
  it('comes round at Chrome’s alarm floor while it holds a chat, so a repair waits at most one pass', async () => {
    const { fetch, asked, arm } = appWith(null);
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(61);
    await worker.send({ type: 'bind', conversationId: CHAT }, 61);

    const armings = () => worker.alarmCreate.mock.calls.filter((call) => call[0] === 'clf-bridge-drain');
    expect(armings()).toHaveLength(1);

    // Every pass leaves the next one armed, and never asks for a delay Chrome would clamp -
    // asking for less is not an error, it is a number that quietly means something else in a
    // packed extension than it does in the unpacked copy a developer is looking at.
    for (let pass = 1; pass <= 3; pass++) {
      await worker.fireAlarm();
      expect(armings()).toHaveLength(pass + 1);
      expect(armings().at(-1)![1]).toEqual({ delayInMinutes: 0.5 });
      expect(armings().at(-1)![1].delayInMinutes).toBeGreaterThanOrEqual(0.5);
    }

    // A repair armed by the app between two passes is carried out on the very next one.
    arm(CHAT);
    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledWith(61);
    expect(asked.slice(-2)).toEqual(['status', `repaired:${CHAT}`]);

    // The cadence outlives the tab: a paired worker with nothing open is the one that has to
    // open the chat the app is owed.
    await worker.closeTab(61);
    expect(worker.alarmClear).not.toHaveBeenCalledWith('clf-bridge-drain');
  });
});

describe('safe Chrome tab ownership', () => {
  const paired = { port: 8765, token: 'paired-token' };
  const CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const OTHER_BROWSER_TAB = { id: 999, windowId: 8, url: 'https://example.com/' };

  it('adopts the current 16-hex app command marker after a companion or browser restart', async () => {
    const commandId = '34d2e1c08bd217ac';
    const url = `https://chatgpt.com/?clf=${commandId}&reasoning_effort=xhigh#clf=${commandId}`;
    const tab = { id: 50, windowId: 7, url, active: false };
    const session = new FakeStorageArea();
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: [commandId] }),
      tabsQuery: async () => [tab, OTHER_BROWSER_TAB],
      tabsGet: async () => tab
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(session.data.appOwnedOpeningTabs).toMatchObject({
      '50': { createdAt: expect.any(Number), marker: commandId }
    });
  });

  it.each([true, false])('closes an old empty marked command tab only after command removal: active=%s', async active => {
    const commandId = 'de01c492cdde4054';
    const url = `https://chatgpt.com/?clf=${commandId}&reasoning_effort=xhigh#clf=${commandId}`;
    const tab = { id: 54, windowId: 7, url, active: false };
    const row = { createdAt: Date.now() - 150_000, marker: commandId };
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: { '54': row },
      tabDocuments: { '54': 'doc-54' },
      tabEpochs: { '54': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: active ? [commandId] : [] }),
      tabsQuery: async () => [tab, OTHER_BROWSER_TAB],
      tabsGet: async () => tab,
      tabsSendMessage: async (_id, message) => message.type === 'clf-tab-close-check'
        ? { safe: true, conversationId: null, navigationEpoch: 0 }
        : { ok: true }
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).toHaveBeenCalledTimes(active ? 0 : 1);
    if (!active) expect(worker.tabsRemove).toHaveBeenCalledWith(54);
  });

  it.each([
    ['pending-home', 'page composer pending hydration'],
    ['missing', 'page composer unavailable or ambiguous'],
    ['PRIVATE provider text', 'page reported draft, attachment, generation, queue, or helper work']
  ])('logs only an allowlisted close-retention explanation for composer %s', async (host, reason) => {
    const commandId = 'de01c492cdde4054';
    const tab = { id: 54, windowId: 7, url: `https://chatgpt.com/?clf=${commandId}`, active: false };
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({ appOwnedOpeningTabs: { '54': { createdAt: Date.now() - 150_000, marker: commandId } },
        tabDocuments: { '54': 'doc-54' }, tabEpochs: { '54': 0 } }),
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true } : { ok: true, repairs: [], browserCommandIds: [] }),
      tabsQuery: async () => [tab, OTHER_BROWSER_TAB], tabsGet: async () => tab,
      tabsSendMessage: async () => ({ safe: false, conversationId: null, navigationEpoch: 0, composer: { host } })
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await worker.fireAlarm();
      await worker.fireAlarm();
      expect(worker.tabsRemove).not.toHaveBeenCalled();
      const retained = info.mock.calls.filter(call => call[0] === '[Chat On Steroids] retained app-created ChatGPT root tab');
      expect(retained).toEqual([['[Chat On Steroids] retained app-created ChatGPT root tab', 54, reason]]);
      expect(JSON.stringify(info.mock.calls)).not.toContain('PRIVATE');
    } finally { info.mockRestore(); }
  });

  it.each([
    { state: 'active', active: true, closes: false },
    { state: 'stale', active: false, closes: true }
  ])('$state: closes an app command root only after status removes its exact id', async ({ active, closes }) => {
    const commandId = 'de01c492cdde4054';
    const url = `https://chatgpt.com/?clf=${commandId}&reasoning_effort=xhigh#clf=${commandId}`;
    const tab = { id: 58, windowId: 7, url, active: false, pinned: false };
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: { '58': { createdAt: Date.now() - 4 * 60_000, marker: commandId } },
      tabDocuments: { '58': 'doc-58' },
      tabEpochs: { '58': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: active ? [commandId] : [],
            browserAttentionCommandIds: [] }),
      tabsQuery: async () => [tab, OTHER_BROWSER_TAB],
      tabsGet: async () => tab,
      tabsSendMessage: async () => ({ safe: true, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).toHaveBeenCalledTimes(closes ? 1 : 0);
    if (closes) {
      expect(worker.tabsRemove).toHaveBeenCalledWith(58);
      expect(session.data.appOwnedOpeningTabs).toEqual({});
    } else {
      expect(session.data.appOwnedOpeningTabs).toHaveProperty('58');
    }
  });

  it.each(['draft', 'selected', 'pinned'])('keeps an aged unredeemed root when %s prevents exact empty cleanup', async state => {
    const commandId = 'de01c492cdde4054';
    const url = `https://chatgpt.com/?clf=${commandId}&reasoning_effort=xhigh#clf=${commandId}`;
    const tab = { id: 59, windowId: 7, url, active: state === 'selected', pinned: state === 'pinned' };
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: { '59': { createdAt: Date.now() - 6 * 60_000, marker: commandId } },
      tabDocuments: { '59': 'doc-59' },
      tabEpochs: { '59': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: [commandId], browserAttentionCommandIds: [] }),
      tabsQuery: async () => [tab], tabsGet: async () => tab,
      tabsSendMessage: async () => ({ safe: state !== 'draft', conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(session.data.appOwnedOpeningTabs).toHaveProperty('59');
  });

  it.each([false, true])('closes a proven-empty stale app root in any unfocused window: focused=%s', async focused => {
    const commandId = 'de01c492cdde4054';
    const tab = { id: 69, windowId: 7,
      url: `https://chatgpt.com/?clf=${commandId}&reasoning_effort=xhigh#clf=${commandId}`,
      active: true, pinned: false };
    const session = new FakeStorageArea({
      // Deliberately point the current dedicated-window record somewhere else. Old app-owned
      // worker windows must still be cleaned after a restart or settings change.
      chatBackgroundWindow: 99,
      appOwnedOpeningTabs: { '69': { createdAt: Date.now() - 4 * 60_000, marker: commandId } },
      tabDocuments: { '69': 'doc-69' },
      tabEpochs: { '69': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: [], browserAttentionCommandIds: [] }),
      tabsQuery: async () => [tab, OTHER_BROWSER_TAB], tabsGet: async () => tab,
      windowsGet: async () => ({ id: 7, focused }),
      tabsSendMessage: async () => ({ safe: true, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).toHaveBeenCalledTimes(focused ? 0 : 1);
    if (!focused) expect(worker.tabsRemove).toHaveBeenCalledWith(69);
  });

  it('keeps an aged exact-attention root even when it is mechanically active in the unfocused background window', async () => {
    const commandId = 'de01c492cdde4054';
    const tab = { id: 70, windowId: 7,
      url: `https://chatgpt.com/?clf=${commandId}&reasoning_effort=xhigh#clf=${commandId}`,
      active: true, pinned: false };
    const session = new FakeStorageArea({
      chatBackgroundWindow: 7,
      appOwnedOpeningTabs: { '70': { createdAt: Date.now() - 4 * 60_000, marker: commandId } },
      tabDocuments: { '70': 'doc-70' },
      tabEpochs: { '70': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: [commandId], browserAttentionCommandIds: [commandId] }),
      tabsQuery: async () => [tab, OTHER_BROWSER_TAB], tabsGet: async () => tab,
      windowsGet: async () => ({ id: 7, focused: false }),
      tabsSendMessage: async () => ({ safe: true, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(worker.tabsSendMessage).not.toHaveBeenCalledWith(
      70,
      expect.objectContaining({ type: 'clf-tab-close-check' }),
      expect.anything()
    );
    expect(session.data.appOwnedOpeningTabs).toHaveProperty('70');
  });

  it('never retires active command roots merely because their burst is old or large', async () => {
    const now = Date.now();
    const tabs = Array.from({ length: 14 }, (_, index) => {
      const marker = (index + 1).toString(16).padStart(16, '0');
      return { id: 100 + index, windowId: 7, active: false, pinned: false,
        url: `https://chatgpt.com/?clf=${marker}#clf=${marker}`, marker };
    });
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: Object.fromEntries(tabs.map((tab, index) => [String(tab.id), {
        createdAt: now - (14 - index) * 1_000 - 2 * 60_000, marker: tab.marker
      }])),
      tabDocuments: Object.fromEntries(tabs.map(tab => [String(tab.id), `doc-${tab.id}`])),
      tabEpochs: Object.fromEntries(tabs.map(tab => [String(tab.id), 0]))
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: tabs.map(tab => tab.marker) }),
      tabsQuery: async () => tabs,
      tabsGet: async id => tabs.find(tab => tab.id === id)!,
      tabsSendMessage: async () => ({ safe: true, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(worker.tabsSendMessage.mock.calls.some(([, message]) => message.type === 'clf-tab-close-check')).toBe(false);
  });

  it('never spends the hard-cap path on fresh worker bootstraps', async () => {
    const now = Date.now();
    const tabs = Array.from({ length: 26 }, (_, index) => {
      const marker = (index + 101).toString(16).padStart(16, '0');
      return { id: 200 + index, windowId: 7, active: false, pinned: false,
        url: `https://chatgpt.com/?clf=${marker}#clf=${marker}`, marker };
    });
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: Object.fromEntries(tabs.map((tab, index) => [String(tab.id), {
        createdAt: now - index * 1000, marker: tab.marker
      }])),
      tabDocuments: Object.fromEntries(tabs.map(tab => [String(tab.id), `doc-${tab.id}`])),
      tabEpochs: Object.fromEntries(tabs.map(tab => [String(tab.id), 0]))
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: tabs.map(tab => tab.marker) }),
      tabsQuery: async () => tabs,
      tabsGet: async id => tabs.find(tab => tab.id === id)!,
      tabsSendMessage: async () => ({ safe: true, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(worker.tabsSendMessage.mock.calls.some(([, message]) => message.type === 'clf-tab-close-check')).toBe(false);
  });

  it.each([
    { activeCommand: true, selected: false, safe: true, closes: false },
    { activeCommand: false, selected: false, safe: true, closes: true },
    { activeCommand: false, selected: true, safe: true, closes: false },
    { activeCommand: false, selected: false, safe: false, closes: false }
  ])('keeps tab-id ownership when ChatGPT strips clf from a decorated command root: %o', async scenario => {
    const commandId = '4e689b755134a55a';
    const url = 'https://chatgpt.com/?reasoning_effort=pro';
    const tab = { id: 60, windowId: 7, url, active: scenario.selected, pinned: false };
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: { '60': { createdAt: Date.now() - 150_000, marker: commandId } },
      tabDocuments: { '60': 'doc-60' },
      tabEpochs: { '60': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: scenario.activeCommand ? [commandId] : [] }),
      tabsQuery: async () => [tab, OTHER_BROWSER_TAB],
      tabsGet: async () => tab,
      tabsSendMessage: async () => scenario.safe
        ? { safe: true, conversationId: null, navigationEpoch: 0 }
        : null
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).toHaveBeenCalledTimes(scenario.closes ? 1 : 0);
    if (!scenario.closes) expect(session.data.appOwnedOpeningTabs).toHaveProperty('60');
  });

  it('never adopts an unowned reasoning-only root for cleanup after browser restart', async () => {
    const url = 'https://chatgpt.com/?reasoning_effort=pro';
    const tab = { id: 61, windowId: 7, url, active: false, pinned: false,
      lastAccessed: Date.now() - 60 * 60_000 };
    const session = new FakeStorageArea({ tabDocuments: { '61': 'doc-61' }, tabEpochs: { '61': 0 } });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: [] }),
      tabsQuery: async () => [tab],
      tabsGet: async () => tab,
      tabsSendMessage: async () => ({ safe: true, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(session.data.appOwnedOpeningTabs ?? {}).toEqual({});
    expect(session.data.idleRootTabs ?? {}).toEqual({});
  });

  it('never closes a provenance-free reasoning-only root even when an old row says it was idle', async () => {
    const now = Date.now();
    const url = 'https://chatgpt.com/?reasoning_effort=pro';
    const tab = { id: 62, windowId: 7, url, active: false, pinned: false,
      lastAccessed: now - 20 * 60_000 };
    const session = new FakeStorageArea({
      idleRootTabs: { '62': { seenAt: now - 61_000, lastAccessedAt: tab.lastAccessed,
        documentId: 'doc-62', navigationEpoch: 0, url } },
      tabDocuments: { '62': 'doc-62' },
      tabEpochs: { '62': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: [] }),
      tabsQuery: async () => [tab, OTHER_BROWSER_TAB],
      tabsGet: async () => tab,
      tabsSendMessage: async () => ({ safe: true, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(session.data.idleRootTabs).toEqual({});
  });

  it('sweeps an aged app-owned exact bare root even when status and the broad ChatGPT inventory fail', async () => {
    const now = Date.now();
    const root = { id: 68, windowId: 7, url: 'https://chatgpt.com/', active: false, pinned: false,
      lastAccessed: now - 20 * 60_000 };
    const named = { id: 69, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: false };
    const session = new FakeStorageArea({
      idleRootTabs: { '68': { appOwned: true, seenAt: now - 6 * 60_000, lastAccessedAt: root.lastAccessed,
        documentId: 'doc-68', navigationEpoch: 0, url: root.url } },
      tabDocuments: { '68': 'doc-68' },
      tabEpochs: { '68': 0 }
    });
    const queries: Array<Record<string, unknown> | undefined> = [];
    let ready = false;
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(new URL(input).pathname === '/hello' ? 200 : 503,
        new URL(input).pathname === '/hello' ? { app: 'chat-on-steroids', paired: true } : {}),
      tabsQuery: async query => {
        queries.push(query);
        if (!ready) return [];
        const urls = Array.isArray(query?.url) ? query.url : [];
        if (urls.includes('https://chatgpt.com/')) return [root];
        if (!query || Object.keys(query).length === 0) return [root, named, OTHER_BROWSER_TAB];
        throw new Error('synthetic broad inventory failure');
      },
      tabsGet: async () => root,
      tabsSendMessage: async (_id, message) => message.type === 'clf-tab-close-check'
        ? { safe: true, conversationId: null, navigationEpoch: 0 }
        : { ok: true }
    });
    await Promise.resolve();
    ready = true;

    await worker.fireAlarm();

    expect(worker.tabsRemove).toHaveBeenCalledExactlyOnceWith(68);
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(69);
    expect(worker.tabsSendMessage).not.toHaveBeenCalledWith(69,
      expect.objectContaining({ type: 'clf-tab-close-check' }), expect.anything());
    expect(queries.some(query => Array.isArray(query?.url) &&
      query.url.includes('https://chatgpt.com/') && !query.url.includes('https://chatgpt.com/*'))).toBe(true);
  });

  it('retires an abandoned explicit-Open root locally when status and broad inventory are unavailable', async () => {
    const now = Date.now();
    const root = { id: 168, windowId: 7, url: 'https://chatgpt.com/', active: false, pinned: false,
      lastAccessed: now - 20 * 60_000 };
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: { '168': { createdAt: now - 20_000, conversationId: CHAT,
        openRequestId: 'abandoned-open-168', openState: 'opening' } },
      tabDocuments: { '168': 'doc-168' },
      tabEpochs: { '168': 0 }
    });
    let ready = false;
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(new URL(input).pathname === '/hello' ? 200 : 503,
        new URL(input).pathname === '/hello' ? { app: 'chat-on-steroids', paired: true } : {}),
      tabsQuery: async query => {
        if (!ready) return [];
        const urls = Array.isArray(query?.url) ? query.url : [];
        if (urls.includes('https://chatgpt.com/')) return [root];
        if (!query || Object.keys(query).length === 0) return [root, OTHER_BROWSER_TAB];
        throw new Error('synthetic broad inventory failure');
      },
      tabsGet: async () => root,
      tabsSendMessage: async (_id, message) => message.type === 'clf-tab-close-check'
        ? { safe: true, conversationId: null, navigationEpoch: 0 }
        : { ok: true }
    });
    await Promise.resolve();
    ready = true;

    await worker.fireAlarm();

    expect(worker.tabsRemove).toHaveBeenCalledExactlyOnceWith(168);
    expect(session.data.appOwnedOpeningTabs).not.toHaveProperty('168');
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(168,
      { type: 'clf-tab-close-check', conversationId: null }, { documentId: 'doc-168' });
  });

  it.each([
    { focused: false, closes: true },
    { focused: true, closes: false }
  ])('closes an active exact root only when its window is provably unfocused: $focused', async ({ focused, closes }) => {
    const now = Date.now();
    const root = { id: 70, windowId: 11, url: 'https://chatgpt.com/', active: true, pinned: false,
      lastAccessed: now - 20 * 60_000 };
    const session = new FakeStorageArea({
      idleRootTabs: { '70': { appOwned: true, seenAt: now - 6 * 60_000, lastAccessedAt: root.lastAccessed,
        documentId: 'doc-70', navigationEpoch: 0, url: root.url } },
      tabDocuments: { '70': 'doc-70' }, tabEpochs: { '70': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(new URL(input).pathname === '/hello' ? 200 : 503,
        new URL(input).pathname === '/hello' ? { app: 'chat-on-steroids', paired: true } : {}),
      tabsQuery: async () => [root, OTHER_BROWSER_TAB], tabsGet: async () => root,
      windowsGet: async () => ({ id: 11, focused }),
      tabsSendMessage: async () => ({ safe: true, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).toHaveBeenCalledTimes(closes ? 1 : 0);
    if (closes) expect(worker.tabsRemove).toHaveBeenCalledWith(70);
  });

  it('reinjects one unreadable exact root, then closes only after its registered document proves empty', async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const root = { id: 71, windowId: 7, url: 'https://chatgpt.com/', active: false, pinned: false,
      lastAccessed: now - 20 * 60_000 };
    const session = new FakeStorageArea({
      idleRootTabs: { '71': { appOwned: true, seenAt: now - 6 * 60_000, lastAccessedAt: root.lastAccessed,
        documentId: '', navigationEpoch: -1, url: root.url } }
    });
    let ready = false;
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(new URL(input).pathname === '/hello' ? 200 : 503,
        new URL(input).pathname === '/hello' ? { app: 'chat-on-steroids', paired: true } : {}),
      tabsQuery: async () => ready ? [root, OTHER_BROWSER_TAB] : [], tabsGet: async () => root,
      tabsSendMessage: async (_id, message) => {
        if (message.type === 'clf-recorder-ping') throw new Error('Receiving end does not exist');
        return message.type === 'clf-tab-close-check'
          ? { safe: true, conversationId: null, navigationEpoch: 0 } : null;
      }
    });
    await Promise.resolve();
    ready = true;

    try {
      await worker.fireAlarm();
      expect(worker.tabsRemove).not.toHaveBeenCalled();
      expect(worker.scriptingExecuteScript).toHaveBeenCalled();
      const injections = worker.scriptingExecuteScript.mock.calls.length;

      await worker.registerTab(71, 'doc-71');
      await worker.fireAlarm();
      expect(worker.tabsRemove).not.toHaveBeenCalled();
      expect((session.data.idleRootTabs as Record<string, { seenAt: number }>)['71']?.seenAt).toBe(now);

      now += 60_001;
      await worker.fireAlarm();

      expect(worker.tabsRemove).toHaveBeenCalledExactlyOnceWith(71);
      expect(worker.scriptingExecuteScript).toHaveBeenCalledTimes(injections);
      expect(worker.tabsSendMessage).toHaveBeenCalledWith(71,
        { type: 'clf-tab-close-check', conversationId: null }, { documentId: 'doc-71' });
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['owned-opening', 'pending-input', 'draft'])('keeps an aged exact root protected by $case', async protection => {
    const now = Date.now();
    const root = { id: 72, windowId: 7, url: 'https://chatgpt.com/', active: false, pinned: false,
      lastAccessed: now - 20 * 60_000 };
    const inputId = 'ffffffff-1111-4222-8333-444444444444';
    const session = new FakeStorageArea({
      idleRootTabs: { '72': { appOwned: true, seenAt: now - 6 * 60_000, lastAccessedAt: root.lastAccessed,
        documentId: 'doc-72', navigationEpoch: 0, url: root.url } },
      tabDocuments: { '72': 'doc-72' }, tabEpochs: { '72': 0 },
      ...(protection === 'owned-opening'
        ? { appOwnedOpeningTabs: { '72': { createdAt: now - 4 * 60_000, marker: inputId } } }
        : {})
    });
    const local = new FakeStorageArea({
      ...paired,
      ...(protection === 'pending-input'
        ? { inputOpenings: { [inputId]: { tab: 72, stage: 'preparing', conversationId: null } } }
        : {})
    });
    const worker = loadWorker({
      local, session,
      fetch: async input => response(new URL(input).pathname === '/hello' ? 200 : 503,
        new URL(input).pathname === '/hello' ? { app: 'chat-on-steroids', paired: true } : {}),
      tabsQuery: async () => [root, OTHER_BROWSER_TAB], tabsGet: async () => root,
      tabsSendMessage: async (_id, message) => message.type === 'clf-tab-close-check'
        ? { safe: protection !== 'draft', conversationId: null, navigationEpoch: 0 }
        : { ok: true }
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).not.toHaveBeenCalled();
    if (protection !== 'draft') {
      expect(worker.tabsSendMessage).not.toHaveBeenCalledWith(72,
        expect.objectContaining({ type: 'clf-tab-close-check' }), expect.anything());
    }
  });

  it.each([
    { ageSeconds: 10, closes: false },
    { ageSeconds: 20, closes: true }
  ])('retires a redirected app-owned root after the short handoff grace: $ageSeconds seconds', async ({ ageSeconds, closes }) => {
    const now = Date.now();
    const root = { id: 73, windowId: 7, url: 'https://chatgpt.com/', active: false, pinned: false };
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: { '73': { createdAt: now - ageSeconds * 1000,
        conversationId: CHAT, openRequestId: 'redirect-73', openState: 'redirected' } },
      tabDocuments: { '73': 'doc-73' }, tabEpochs: { '73': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: [] }),
      tabsQuery: async () => [root, OTHER_BROWSER_TAB], tabsGet: async () => root,
      tabsSendMessage: async () => ({ safe: true, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).toHaveBeenCalledTimes(closes ? 1 : 0);
    if (closes) expect(worker.tabsRemove).toHaveBeenCalledWith(73);
  });

  it('retires an aged app-owned conversation root even when Chrome missed its redirected transition', async () => {
    const now = Date.now();
    const root = { id: 173, windowId: 7, url: 'https://chatgpt.com/', active: false, pinned: false };
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: { '173': { createdAt: now - 20_000,
        conversationId: CHAT, openRequestId: 'open-missed-transition', openState: 'opening' } },
      tabDocuments: { '173': 'doc-173' }, tabEpochs: { '173': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: [] }),
      tabsQuery: async () => [root, OTHER_BROWSER_TAB], tabsGet: async () => root,
      tabsSendMessage: async () => ({ safe: true, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).toHaveBeenCalledWith(173);
    expect(session.data.appOwnedOpeningTabs).not.toHaveProperty('173');
  });

  it('retries Chrome inventory exactly once for a hygiene pass', async () => {
    const start = backgroundSource.indexOf('const OPEN_CONVERSATION_INVENTORY_TIMEOUT_MS');
    const end = backgroundSource.indexOf('/** Reuses an exact Chrome conversation', start);
    const tabs = [{ id: 67, url: 'https://chatgpt.com/' }];
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic transient inventory failure'))
      .mockResolvedValueOnce(tabs);
    const cleanup = vm.runInNewContext(
      `${backgroundSource.slice(start, end)}\ncleanupConversationInventory`,
      { chrome: { tabs: { query } }, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], setTimeout, clearTimeout }
    ) as () => Promise<Array<{ id: number; url: string }>>;

    await expect(cleanup()).resolves.toEqual(tabs);
    expect(query).toHaveBeenCalledTimes(2);

    query.mockReset();
    query.mockRejectedValue(new Error('synthetic persistent inventory failure'));
    await expect(cleanup()).rejects.toThrow('synthetic persistent inventory failure');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('clears a stale routing fallback from an exact idle root only after safe page proof: safe=%s', async safe => {
    const now = Date.now();
    const url = 'https://chatgpt.com/';
    const tab = { id: 64, windowId: 7, url, active: false, pinned: false,
      lastAccessed: now - 20 * 60_000 };
    const session = new FakeStorageArea({
      idleRootTabs: { '64': { appOwned: true, seenAt: now - 6 * 60_000, lastAccessedAt: tab.lastAccessed,
        documentId: 'doc-64', navigationEpoch: 0, url } },
      tabDocuments: { '64': 'doc-64' },
      tabEpochs: { '64': 0 },
      // Routing keeps this fallback during reloads; concrete root cleanup must not mistake it
      // for a currently named /c page, nor discard it before the content document proves empty.
      tabConversations: { '64': CHAT }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: [] }),
      tabsQuery: async () => [tab, OTHER_BROWSER_TAB], tabsGet: async () => tab,
      tabsSendMessage: async () => ({ safe, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).toHaveBeenCalledTimes(safe ? 1 : 0);
    expect(session.data.tabConversations).toEqual(safe ? {} : { '64': CHAT });
  });

  it('retires an unowned app-created root after the short app-owned cleanup grace', async () => {
    const helperMarker = 'ffffffff-1111-4222-8333-444444444444';
    const tab = { id: 63, windowId: 7, url: 'https://chatgpt.com/', active: false, pinned: false };
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: { '63': { createdAt: Date.now() - 20_000, marker: helperMarker } },
      tabDocuments: { '63': 'doc-63' },
      tabEpochs: { '63': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: [] }),
      tabsQuery: async () => [tab, OTHER_BROWSER_TAB],
      tabsGet: async () => tab,
      tabsSendMessage: async () => ({ safe: true, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).toHaveBeenCalledExactlyOnceWith(63);
    expect(session.data.appOwnedOpeningTabs).toEqual({});
  });

  it('repairs an unreadable app-created root once while retaining an unreadable personal root', async () => {
    const helperMarker = 'ffffffff-1111-4222-8333-444444444444';
    const now = Date.now();
    const appTab = { id: 65, windowId: 7, url: 'https://chatgpt.com/', active: false, pinned: false };
    const personalTab = { id: 66, windowId: 7, url: 'https://chatgpt.com/', active: false, pinned: false,
      lastAccessed: now - 20 * 60_000 };
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: { '65': { createdAt: now - 180_000, marker: helperMarker } },
      idleRootTabs: { '66': { seenAt: now - 6 * 60_000, lastAccessedAt: personalTab.lastAccessed,
        documentId: 'doc-66', navigationEpoch: 0, url: personalTab.url } },
      tabDocuments: { '65': 'doc-65', '66': 'doc-66' },
      tabEpochs: { '65': 0, '66': 0 }
    });
    const tabs = [appTab, personalTab, OTHER_BROWSER_TAB];
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: [] }),
      tabsQuery: async () => tabs,
      tabsGet: async id => tabs.find(tab => tab.id === id)!,
      tabsSendMessage: async (_id, message) => {
        if (message.type === 'clf-recorder-ping') throw new Error('Receiving end does not exist');
        return null;
      }
    });

    await worker.fireAlarm();
    expect(worker.scriptingExecuteScript).not.toHaveBeenCalledTimes(0);
    expect(session.data.appOwnedOpeningTabs).toMatchObject({
      '65': { repairDocumentId: 'doc-65', repairNavigationEpoch: 0, repairAttemptedAt: expect.any(Number) }
    });
    const attemptedAt = (session.data.appOwnedOpeningTabs as Record<string, { repairAttemptedAt: number }>)['65']!.repairAttemptedAt;
    expect(worker.tabsRemove).not.toHaveBeenCalled();

    await worker.fireAlarm();
    expect((session.data.appOwnedOpeningTabs as Record<string, { repairAttemptedAt: number }>)['65']!.repairAttemptedAt)
      .toBe(attemptedAt);
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(66);
    expect(session.data.idleRootTabs).not.toHaveProperty('66');
  });

  it('rehydrates discarded app-created empty-root candidates in bounded batches before proof-based closing', async () => {
    const now = Date.now();
    const roots = [65, 66, 67].map(id => ({ id, windowId: 7, url: 'https://chatgpt.com/',
      active: false, pinned: false, discarded: true }));
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: Object.fromEntries(roots.map(tab => [String(tab.id),
        { createdAt: now - 180_000, marker: 'ffffffff-1111-4222-8333-444444444444' }])),
      tabDocuments: Object.fromEntries(roots.map(tab => [String(tab.id), `doc-${tab.id}`])),
      tabEpochs: Object.fromEntries(roots.map(tab => [String(tab.id), 0]))
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: [] }),
      tabsQuery: async () => [...roots, OTHER_BROWSER_TAB],
      tabsGet: async id => roots.find(tab => tab.id === id)!,
      tabsSendMessage: async () => null
    });

    await worker.fireAlarm();
    expect(worker.tabsReload.mock.calls.map(([id]) => id)).toEqual([65, 66]);
    expect(worker.tabsRemove).not.toHaveBeenCalled();

    await worker.fireAlarm();
    expect(worker.tabsReload.mock.calls.map(([id]) => id)).toEqual([65, 66, 67]);
    expect(worker.tabsRemove).not.toHaveBeenCalled();
  });

  it('retries unreadable root recorder repair after ten minutes without treating age as close proof', async () => {
    const now = Date.now();
    const lastAttempt = now - 11 * 60_000;
    const tabs = [
      { id: 165, windowId: 7, url: 'https://chatgpt.com/', active: false, pinned: false,
        lastAccessed: now - 20 * 60_000 },
      { id: 166, windowId: 7, url: 'https://chatgpt.com/', active: false, pinned: false,
        lastAccessed: now - 20 * 60_000 },
      OTHER_BROWSER_TAB
    ];
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: { '165': { createdAt: now - 20 * 60_000,
        marker: 'ffffffff-1111-4222-8333-444444444444',
        repairDocumentId: 'doc-165', repairNavigationEpoch: 0, repairAttemptedAt: lastAttempt } },
      idleRootTabs: { '166': { appOwned: true, seenAt: now - 20 * 60_000, lastAccessedAt: now - 20 * 60_000,
        documentId: 'doc-166', navigationEpoch: 0, url: 'https://chatgpt.com/',
        repairDocumentId: 'doc-166', repairNavigationEpoch: 0, repairAttemptedAt: lastAttempt } },
      tabDocuments: { '165': 'doc-165', '166': 'doc-166' },
      tabEpochs: { '165': 0, '166': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], browserCommandIds: [] }),
      tabsQuery: async () => tabs,
      tabsGet: async id => tabs.find(tab => tab.id === id)!,
      tabsSendMessage: async () => null
    });

    await worker.fireAlarm();

    const appRow = (session.data.appOwnedOpeningTabs as Record<string, { repairAttemptedAt: number }>)['165']!;
    const idleRow = (session.data.idleRootTabs as Record<string, { repairAttemptedAt: number }>)['166']!;
    expect(appRow.repairAttemptedAt).toBeGreaterThan(lastAttempt);
    expect(idleRow.repairAttemptedAt).toBeGreaterThan(lastAttempt);
    expect(worker.tabsRemove).not.toHaveBeenCalled();
  });

  it('closes only an old app-created plain home tab, never an unowned home or named chat', async () => {
    const tabs = [
      { id: 51, windowId: 7, url: 'https://chatgpt.com/' },
      { id: 52, windowId: 7, url: 'https://chatgpt.com/' },
      { id: 53, windowId: 7, url: `https://chatgpt.com/c/${CHAT}` }
    ];
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: {
        '51': { createdAt: Date.now() - 180_000 },
        '53': { createdAt: Date.now() - 180_000 }
      },
      tabDocuments: { '51': 'doc-51', '53': 'doc-53' },
      tabEpochs: { '51': 0, '53': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [] }),
      tabsQuery: async () => tabs,
      tabsGet: async id => tabs.find(tab => tab.id === id)!,
      tabsSendMessage: async (_id, message) => message.type === 'clf-tab-close-check'
        ? { safe: true, conversationId: null, navigationEpoch: 0 }
        : { ok: true }
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).toHaveBeenCalledExactlyOnceWith(51);
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(52);
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(53);
    expect(session.data.appOwnedOpeningTabs).toEqual({});
  });

  it('never adopts an unmarked personal New Chat root into cleanup custody', async () => {
    const now = Date.now();
    const tab = { id: 55, windowId: 7, url: 'https://chatgpt.com/', active: false,
      lastAccessed: now - 60 * 60_000 };
    const session = new FakeStorageArea({
      idleRootTabs: { '55': { seenAt: now - 4 * 60_000, lastAccessedAt: tab.lastAccessed,
        documentId: 'doc-55', navigationEpoch: 0, url: tab.url } },
      tabDocuments: { '55': 'doc-55' }, tabEpochs: { '55': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [] }),
      tabsQuery: async () => [tab],
      tabsGet: async () => tab,
      tabsSendMessage: async () => ({ safe: true, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(session.data.idleRootTabs).toEqual({});
  });

  it('does not close provenance-free idle homes even when they are old and freshly proved empty', async () => {
    const now = Date.now();
    const tabs = [
      { id: 56, windowId: 7, url: 'https://chatgpt.com/', active: false, lastAccessed: now - 12 * 60_000 },
      { id: 57, windowId: 7, url: 'https://chatgpt.com/', active: false, lastAccessed: now - 11 * 60_000 },
      { id: 58, windowId: 7, url: 'https://chatgpt.com/', active: true, lastAccessed: now - 20 * 60_000 },
      { id: 59, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: false, lastAccessed: now - 30 * 60_000 }
    ];
    const idleRootTabs = Object.fromEntries(tabs.slice(0, 3).map(tab => [String(tab.id), {
      seenAt: now - 20 * 60_000,
      lastAccessedAt: tab.lastAccessed,
      documentId: `doc-${tab.id}`,
      navigationEpoch: 0,
      url: tab.url
    }]));
    const session = new FakeStorageArea({
      idleRootTabs,
      tabDocuments: Object.fromEntries(tabs.map(tab => [String(tab.id), `doc-${tab.id}`])),
      tabEpochs: Object.fromEntries(tabs.map(tab => [String(tab.id), 0]))
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session,
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [] }),
      tabsQuery: async () => tabs,
      tabsGet: async id => tabs.find(tab => tab.id === id)!,
      tabsSendMessage: async (_id, message) => message.type === 'clf-tab-close-check'
        ? { safe: true, conversationId: null, navigationEpoch: 0 }
        : { ok: true }
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(59);
    expect(session.data.idleRootTabs).toEqual({});
  });

  it('focuses the existing conversation and removes only its proven-safe inactive duplicate', async () => {
    const tabs = [
      { id: 61, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: true, lastAccessed: 200 },
      { id: 62, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: false, lastAccessed: 100 }
    ];
    const requestId = 'open-chat-request-1';
    const nonce = '1234567890abcdef1234567890abcdef';
    const acknowledgements: Record<string, unknown>[] = [];
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({
        tabDocuments: { '61': 'doc-61', '62': 'doc-62' },
        tabEpochs: { '61': 0, '62': 0 }
      }),
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/browser/open-chat') {
          acknowledgements.push(JSON.parse(String(init.body)));
          return response(200, { ok: true });
        }
        return response(200, { ok: true, repairs: [], openConversationRequests: [
          { conversationId: CHAT, requestId, nonce, requestedAt: Date.now() }
        ] });
      },
      tabsQuery: async () => tabs,
      tabsGet: async id => tabs.find(tab => tab.id === id)!,
      tabsSendMessage: async id => ({ safe: true, conversationId: CHAT, navigationEpoch: 0, id })
    });

    await worker.fireAlarm();

    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
    expect(worker.tabsRemove).toHaveBeenCalledExactlyOnceWith(62);
    expect(acknowledgements).toEqual([
      expect.objectContaining({
        conversationId: CHAT,
        requestId,
        nonce,
        outcome: 'focused',
        timing: expect.objectContaining({
          deliveredAt: expect.any(Number),
          inventoryStartedAt: expect.any(Number),
          inventoryCompletedAt: expect.any(Number),
          exactMatchAt: expect.any(Number),
          actionStartedAt: expect.any(Number),
          actionCompletedAt: expect.any(Number),
          acknowledgementStartedAt: expect.any(Number)
        })
      })
    ]);
  });

  it('restores a minimized exact conversation window before reporting Open success', async () => {
    const tab = { id: 64, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: false };
    const requestId = 'open-chat-request-minimized';
    const nonce = '1134567890abcdef1234567890abcdef';
    const acknowledgements: Record<string, unknown>[] = [];
    let active = false;
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(),
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/browser/open-chat') {
          acknowledgements.push(JSON.parse(String(init.body)));
          return response(200, { ok: true });
        }
        return response(200, { ok: true, repairs: [], openConversationRequests: [
          { conversationId: CHAT, requestId, nonce, requestedAt: Date.now() }
        ] });
      },
      tabsQuery: async () => [tab],
      tabsGet: async () => ({ ...tab, active }),
      tabsUpdate: async (_id, properties) => {
        active = true;
        return { ...tab, ...properties };
      },
      windowsGet: async () => ({ id: 7, focused: false, state: 'minimized' })
    });

    await worker.fireAlarm();

    expect(worker.windowsUpdate).toHaveBeenCalledExactlyOnceWith(7,
      { state: 'normal', focused: true });
    expect(acknowledgements).toEqual([
      expect.objectContaining({ requestId, outcome: 'focused' })
    ]);
  });

  it('focuses the tab current returned window after it moved from the inventory window', async () => {
    const stale = { id: 65, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: false };
    const current = { ...stale, windowId: 8 };
    const requestId = 'open-chat-request-moved-window';
    const nonce = '1234567890abcdef1234567890abcdee';
    const acknowledgements: Record<string, unknown>[] = [];
    let active = false;
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(),
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/browser/open-chat') {
          acknowledgements.push(JSON.parse(String(init.body)));
          return response(200, { ok: true });
        }
        return response(200, { ok: true, repairs: [], openConversationRequests: [
          { conversationId: CHAT, requestId, nonce, requestedAt: Date.now() }
        ] });
      },
      tabsQuery: async () => [stale],
      tabsGet: async () => ({ ...current, active }),
      tabsUpdate: async (_id, properties) => {
        active = true;
        return { ...current, ...properties };
      },
      windowsGet: async id => ({ id, focused: false, state: 'normal' })
    });

    await worker.fireAlarm();

    expect(worker.windowsUpdate).toHaveBeenCalledExactlyOnceWith(8, { focused: true });
    expect(worker.windowsUpdate).not.toHaveBeenCalledWith(7, expect.anything());
    expect(acknowledgements).toEqual([
      expect.objectContaining({ requestId, outcome: 'focused' })
    ]);
  });

  it('retries only the exact conversation through a bounded transient activation race', async () => {
    const tab = { id: 66, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: false };
    const requestId = 'open-chat-request-activation-race';
    const nonce = '1434567890abcdef1234567890abcdef';
    const acknowledgements: Record<string, unknown>[] = [];
    let attempts = 0;
    let active = false;
    vi.useFakeTimers();
    try {
      const worker = loadWorker({
        local: new FakeStorageArea(paired), session: new FakeStorageArea(),
        fetch: async (input, init = {}) => {
          const route = new URL(input).pathname;
          if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
          if (route === '/browser/open-chat') {
            acknowledgements.push(JSON.parse(String(init.body)));
            return response(200, { ok: true });
          }
          return response(200, { ok: true, repairs: [], openConversationRequests: [
            { conversationId: CHAT, requestId, nonce, requestedAt: Date.now() }
          ] });
        },
        tabsQuery: async () => [tab],
        tabsGet: async () => ({ ...tab, active }),
        tabsUpdate: async (_id, properties) => {
          attempts += 1;
          if (attempts < 4) throw new Error('synthetic activation race');
          active = true;
          return { ...tab, ...properties };
        }
      });
      const alarm = worker.fireAlarm();
      await vi.runAllTimersAsync();
      await alarm;

      expect(attempts).toBe(4);
      expect(worker.tabsUpdate.mock.calls.map(([tabId]) => tabId)).toEqual([66, 66, 66, 66]);
      expect(worker.tabsCreate).not.toHaveBeenCalled();
      expect(acknowledgements).toEqual([
        expect.objectContaining({ requestId, outcome: 'focused' })
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts an exact tab when Chrome rejects activation after applying it', async () => {
    const tab = { id: 166, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: false };
    const requestId = 'open-chat-request-applied-activation';
    const nonce = '1a34567890abcdef1234567890abcdef';
    const acknowledgements: Record<string, unknown>[] = [];
    let active = false;
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(),
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/browser/open-chat') {
          acknowledgements.push(JSON.parse(String(init.body)));
          return response(200, { ok: true });
        }
        return response(200, { ok: true, repairs: [], openConversationRequests: [
          { conversationId: CHAT, requestId, nonce, requestedAt: Date.now() }
        ] });
      },
      tabsQuery: async () => [tab],
      tabsGet: async () => ({ ...tab, active }),
      tabsUpdate: async () => {
        active = true;
        throw new Error('synthetic callback rejection after activation');
      },
      windowsGet: async id => ({ id, focused: true, state: 'normal' })
    });

    await worker.fireAlarm();

    expect(worker.tabsUpdate).toHaveBeenCalledTimes(1);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(acknowledgements).toEqual([
      expect.objectContaining({ requestId, outcome: 'focused' })
    ]);
  });

  it('accepts an exact window when Chrome rejects focus after applying it', async () => {
    const tab = { id: 169, windowId: 17, url: `https://chatgpt.com/c/${CHAT}`, active: true };
    const requestId = 'open-chat-request-applied-window-focus';
    const nonce = '1b34567890abcdef1234567890abcdef';
    const acknowledgements: Record<string, unknown>[] = [];
    let focused = false;
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea(),
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/browser/open-chat') {
          acknowledgements.push(JSON.parse(String(init.body)));
          return response(200, { ok: true });
        }
        return response(200, { ok: true, repairs: [], openConversationRequests: [
          { conversationId: CHAT, requestId, nonce, requestedAt: Date.now() }
        ] });
      },
      tabsQuery: async () => [tab],
      tabsGet: async () => ({ ...tab }),
      windowsGet: async id => ({ id, focused, state: 'normal' }),
      windowsUpdate: async () => {
        focused = true;
        throw new Error('synthetic callback rejection after window focus');
      }
    });

    await worker.fireAlarm();

    expect(worker.windowsUpdate).toHaveBeenCalledExactlyOnceWith(17, { focused: true });
    expect(acknowledgements).toEqual([
      expect.objectContaining({ requestId, outcome: 'focused' })
    ]);
  });

  it('reports a persistent focus failure after bounded exact-target retries without opening a duplicate', async () => {
    const tab = { id: 67, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: false };
    const requestId = 'open-chat-request-persistent-focus';
    const nonce = '1534567890abcdef1234567890abcdef';
    const acknowledgements: Record<string, unknown>[] = [];
    vi.useFakeTimers();
    try {
      const worker = loadWorker({
        local: new FakeStorageArea(paired), session: new FakeStorageArea(),
        fetch: async (input, init = {}) => {
          const route = new URL(input).pathname;
          if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
          if (route === '/browser/open-chat') {
            acknowledgements.push(JSON.parse(String(init.body)));
            return response(200, { ok: true });
          }
          return response(200, { ok: true, repairs: [], openConversationRequests: [
            { conversationId: CHAT, requestId, nonce, requestedAt: Date.now() }
          ] });
        },
        tabsQuery: async () => [tab],
        tabsGet: async () => ({ ...tab }),
        tabsUpdate: async () => { throw new Error('synthetic persistent focus failure'); }
      });
      const alarm = worker.fireAlarm();
      await vi.runAllTimersAsync();
      await alarm;

      expect(worker.tabsUpdate).toHaveBeenCalledTimes(4);
      expect(worker.tabsUpdate.mock.calls.map(([tabId]) => tabId)).toEqual([67, 67, 67, 67]);
      expect(worker.tabsCreate).not.toHaveBeenCalled();
      expect(acknowledgements).toEqual([
        expect.objectContaining({ requestId, failure: 'focus_failure' })
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one exact focus failure scoped while an unrelated conversation request still progresses', async () => {
    const otherConversation = 'b9191919-1111-4111-8111-919191919191';
    const failedTab = { id: 167, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: false };
    const healthyTab = { id: 168, windowId: 8, url: `https://chatgpt.com/c/${otherConversation}`, active: true };
    const failedRequest = { conversationId: CHAT, requestId: 'open-chat-failed-a', nonce: '1834567890abcdef1234567890abcdef', requestedAt: Date.now() };
    const healthyRequest = { conversationId: otherConversation, requestId: 'open-chat-healthy-b', nonce: '1934567890abcdef1234567890abcdef', requestedAt: Date.now() };
    const acknowledgements: Record<string, unknown>[] = [];
    vi.useFakeTimers();
    try {
      const worker = loadWorker({
        local: new FakeStorageArea(paired), session: new FakeStorageArea(),
        fetch: async (input, init = {}) => {
          const route = new URL(input).pathname;
          if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
          if (route === '/browser/open-chat') {
            acknowledgements.push(JSON.parse(String(init.body)));
            return response(200, { ok: true });
          }
          return response(200, { ok: true, repairs: [], openConversationRequests: [failedRequest, healthyRequest] });
        },
        tabsQuery: async () => [failedTab, healthyTab],
        tabsGet: async id => ({ ...(id === failedTab.id ? failedTab : healthyTab) }),
        tabsUpdate: async id => {
          if (id !== failedTab.id) throw new Error('healthy exact tab must not be retargeted');
          throw new Error('synthetic persistent focus failure for conversation A');
        },
        windowsGet: async id => ({ id, focused: true, state: 'normal' })
      });
      const alarm = worker.fireAlarm();
      await vi.runAllTimersAsync();
      await alarm;

      expect(worker.tabsUpdate).toHaveBeenCalledTimes(4);
      expect(worker.tabsUpdate.mock.calls.every(([tabId]) => tabId === failedTab.id)).toBe(true);
      expect(worker.tabsCreate).not.toHaveBeenCalled();
      expect(acknowledgements).toEqual(expect.arrayContaining([
        expect.objectContaining({ conversationId: CHAT, requestId: failedRequest.requestId, failure: 'focus_failure' }),
        expect.objectContaining({ conversationId: otherConversation, requestId: healthyRequest.requestId, outcome: 'focused' })
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows one uniquely re-elected exact conversation after Chrome replaces its tab id', async () => {
    const original = { id: 68, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: false };
    const other = { id: 69, windowId: 8, url: `https://chatgpt.com/c/${CHAT}`, active: false };
    const requestId = 'open-chat-request-target-replaced';
    const nonce = '1634567890abcdef1234567890abcdef';
    const acknowledgements: Record<string, unknown>[] = [];
    const updatedIds: number[] = [];
    let firstFocusFailed = false;
    let replacementActive = false;
    vi.useFakeTimers();
    try {
      const worker = loadWorker({
        local: new FakeStorageArea(paired), session: new FakeStorageArea(),
        fetch: async (input, init = {}) => {
          const route = new URL(input).pathname;
          if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
          if (route === '/browser/open-chat') {
            acknowledgements.push(JSON.parse(String(init.body)));
            return response(200, { ok: true });
          }
          return response(200, { ok: true, repairs: [], openConversationRequests: [
            { conversationId: CHAT, requestId, nonce, requestedAt: Date.now() }
          ] });
        },
        tabsQuery: async () => firstFocusFailed ? [other] : [original],
        tabsGet: async id => ({ ...(id === original.id ? original : other),
          active: id === other.id ? replacementActive : false }),
        tabsUpdate: async (id, properties) => {
          updatedIds.push(id);
          if (id === original.id) {
            firstFocusFailed = true;
            throw new Error('synthetic elected target loss');
          }
          replacementActive = true;
          return { ...other, ...properties };
        }
      });
      const alarm = worker.fireAlarm();
      await vi.runAllTimersAsync();
      await alarm;

      expect(updatedIds).toEqual([original.id, other.id]);
      expect(worker.tabsCreate).not.toHaveBeenCalled();
      expect(acknowledgements).toEqual([
        expect.objectContaining({ requestId, outcome: 'focused' })
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when replacement focus inventory has exact candidates selected in two windows', async () => {
    const original = { id: 70, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: false };
    const replacements = [
      { id: 71, windowId: 8, url: `https://chatgpt.com/c/${CHAT}`, active: true },
      { id: 72, windowId: 9, url: `https://chatgpt.com/c/${CHAT}`, active: true }
    ];
    const requestId = 'open-chat-request-target-replaced-ambiguous';
    const nonce = '1734567890abcdef1234567890abcdef';
    const acknowledgements: Record<string, unknown>[] = [];
    let firstFocusFailed = false;
    vi.useFakeTimers();
    try {
      const worker = loadWorker({
        local: new FakeStorageArea(paired), session: new FakeStorageArea(),
        fetch: async (input, init = {}) => {
          const route = new URL(input).pathname;
          if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
          if (route === '/browser/open-chat') {
            acknowledgements.push(JSON.parse(String(init.body)));
            return response(200, { ok: true });
          }
          return response(200, { ok: true, repairs: [], openConversationRequests: [
            { conversationId: CHAT, requestId, nonce, requestedAt: Date.now() }
          ] });
        },
        tabsQuery: async () => firstFocusFailed ? replacements : [original],
        tabsGet: async () => ({ ...original }),
        tabsUpdate: async () => {
          firstFocusFailed = true;
          throw new Error('synthetic elected target loss');
        }
      });
      const alarm = worker.fireAlarm();
      await vi.runAllTimersAsync();
      await alarm;

      expect(worker.tabsUpdate).toHaveBeenCalledTimes(1);
      expect(worker.tabsCreate).not.toHaveBeenCalled();
      expect(acknowledgements).toEqual([
        expect.objectContaining({ requestId, failure: 'ambiguous_duplicate' })
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a transient Chrome inventory failure before deciding whether Open needs a new tab', async () => {
    const tab = { id: 63, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: false, lastAccessed: 100 };
    const requestId = 'open-chat-request-transient-inventory';
    const nonce = '1334567890abcdef1234567890abcdef';
    const acknowledgements: Record<string, unknown>[] = [];
    const inventory = vi.fn(async () => [] as Array<typeof tab>);
    let active = false;
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/browser/open-chat') {
          acknowledgements.push(JSON.parse(String(init.body)));
          return response(200, { ok: true });
        }
        return response(200, { ok: true, repairs: [], openConversationRequests: [
          { conversationId: CHAT, requestId, nonce, requestedAt: Date.now() }
        ] });
      },
      tabsQuery: inventory,
      tabsGet: async () => ({ ...tab, active }),
      tabsUpdate: async (_id, properties) => {
        active = true;
        return { ...tab, ...properties };
      }
    });
    // The worker's startup inventory is intentionally outside this request. Make the alarm's
    // status scan succeed, fail only the Open scan's first attempt, then reveal the existing tab.
    await Promise.resolve();
    inventory.mockReset();
    inventory
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('synthetic transient inventory failure'))
      .mockResolvedValue([tab]);

    await worker.fireAlarm();

    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).toHaveBeenCalledWith(63, { active: true });
    expect(acknowledgements).toEqual([
      expect.objectContaining({ conversationId: CHAT, requestId, nonce, outcome: 'focused' })
    ]);
    expect(inventory.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('opens exactly one new tab when the exact conversation is absent and reports the confirmed result', async () => {
    const requestId = 'open-chat-request-2';
    const nonce = '2234567890abcdef1234567890abcdef';
    const acknowledgements: Record<string, unknown>[] = [];
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/browser/open-chat') {
          acknowledgements.push(JSON.parse(String(init.body)));
          return response(200, { ok: true });
        }
        return response(200, { ok: true, repairs: [], openConversationRequests: [
          { conversationId: CHAT, requestId, nonce, requestedAt: Date.now() }
        ] });
      },
      tabsQuery: async () => [],
      tabsGet: async id => ({ id, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: true })
    });

    await worker.fireAlarm();

    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
    expect(worker.tabsCreate).toHaveBeenCalledWith({ url: `https://chatgpt.com/c/${CHAT}`, active: true });
    expect(acknowledgements).toEqual([
      expect.objectContaining({ conversationId: CHAT, requestId, nonce, outcome: 'opened' })
    ]);
  });

  it('reuses one app-opened tab when ChatGPT redirects its conversation load to the bare root', async () => {
    const first = { conversationId: CHAT, requestId: 'open-chat-throttled-1',
      nonce: '5234567890abcdef1234567890abcdef', requestedAt: Date.now() };
    const second = { conversationId: CHAT, requestId: 'open-chat-throttled-2',
      nonce: '6234567890abcdef1234567890abcdef', requestedAt: Date.now() };
    let publication: typeof first | null = first;
    let tabUrl = `https://chatgpt.com/c/${CHAT}`;
    const acknowledgements: Record<string, unknown>[] = [];
    const session = new FakeStorageArea();
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/browser/open-chat') {
          const body = JSON.parse(String(init.body));
          acknowledgements.push(body);
          if (publication?.requestId === body.requestId) publication = null;
          return response(200, { ok: true });
        }
        return response(200, { ok: true, repairs: [],
          openConversationRequests: publication ? [publication] : [] });
      },
      tabsGet: async id => ({ id, windowId: 7, url: tabUrl, status: 'complete' }),
      tabsUpdate: async (id, properties) => {
        if (typeof properties.url === 'string') tabUrl = properties.url;
        return { id, windowId: 7, url: tabUrl, status: 'complete', ...properties };
      },
      tabsSendMessage: async (_id, message) => message.type === 'clf-tab-close-check'
        ? { safe: true, conversationId: null,
            navigationEpoch: Number((session.data.tabEpochs as Record<string, number> | undefined)?.['99']) }
        : { ok: true }
    });

    await worker.fireAlarm();
    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);

    tabUrl = 'https://chatgpt.com/';
    await worker.navigateTab(99, tabUrl);
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.data.appOwnedOpeningTabs).toMatchObject({
      '99': { conversationId: CHAT, openState: 'redirected' }
    });
    publication = second;
    await worker.fireAlarm();

    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
    expect(worker.tabsUpdate).toHaveBeenCalledWith(99,
      { url: `https://chatgpt.com/c/${CHAT}`, active: true });
    expect(acknowledgements).toEqual([
      expect.objectContaining({ requestId: first.requestId, outcome: 'opened' }),
      expect.objectContaining({ requestId: second.requestId, outcome: 'focused' })
    ]);
  });

  it('retargets a safely empty root during the same Open request instead of reporting a focus failure', async () => {
    const request = { conversationId: CHAT, requestId: 'open-chat-same-request-redirect',
      nonce: '6a34567890abcdef1234567890abcdef', requestedAt: Date.now() };
    let tab = { id: 199, windowId: 7, url: 'https://chatgpt.com/', status: 'complete', active: false };
    const acknowledgements: Record<string, unknown>[] = [];
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: { '199': { createdAt: Date.now(), conversationId: CHAT,
        openRequestId: request.requestId, openState: 'redirected', retargetCount: 0,
        replacementCreated: false } },
      tabDocuments: { '199': 'doc-199' }, tabEpochs: { '199': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/browser/open-chat') {
          acknowledgements.push(JSON.parse(String(init.body)));
          return response(200, { ok: true });
        }
        return response(200, { ok: true, repairs: [], openConversationRequests: [request] });
      },
      tabsQuery: async () => [tab, OTHER_BROWSER_TAB],
      tabsGet: async () => ({ ...tab }),
      tabsUpdate: async (_id, properties) => {
        tab = { ...tab, ...properties };
        return { ...tab };
      },
      tabsSendMessage: async (_id, message) => message.type === 'clf-tab-close-check'
        ? { safe: true, conversationId: null, navigationEpoch: 0 }
        : { ok: true }
    });

    await worker.fireAlarm();

    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).toHaveBeenCalledWith(199,
      { url: `https://chatgpt.com/c/${CHAT}`, active: true });
    expect(acknowledgements).toEqual([
      expect.objectContaining({ requestId: request.requestId, outcome: 'focused' })
    ]);
  });

  it('retains a known main conversation redirected to the bare root for the next owed Open request', async () => {
    const request = { conversationId: CHAT, requestId: 'open-known-throttled-1',
      nonce: '7234567890abcdef1234567890abcdef', requestedAt: Date.now() };
    let publication: typeof request | null = null;
    const session = new FakeStorageArea();
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/closed') return response(200, { ok: true });
        if (route === '/browser/open-chat') {
          publication = null;
          return response(200, { ok: true, body: init.body });
        }
        return response(200, { ok: true, repairs: [],
          openConversationRequests: publication ? [publication] : [] });
      },
      tabsGet: async id => ({ id, windowId: 7, url: 'https://chatgpt.com/', status: 'complete' }),
      tabsSendMessage: async (_id, message) => message.type === 'clf-tab-close-check'
        ? { safe: true, conversationId: null,
            navigationEpoch: Number((session.data.tabEpochs as Record<string, number> | undefined)?.['84']) }
        : { ok: true }
    });
    await worker.createTab({ id: 84, url: `https://chatgpt.com/c/${CHAT}` });
    await worker.registerTab(84);
    await worker.send({ type: 'bind', conversationId: CHAT }, 84);

    await worker.navigateTab(84, 'https://chatgpt.com/');
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.data.appOwnedOpeningTabs).toMatchObject({
      '84': { conversationId: CHAT, openState: 'redirected' }
    });

    publication = request;
    await worker.fireAlarm();

    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).toHaveBeenCalledWith(84,
      { url: `https://chatgpt.com/c/${CHAT}`, active: true });
  });

  it('leaves a redirected draft root untouched and opens one exact tab for an explicit request', async () => {
    const request = { conversationId: CHAT, requestId: 'open-draft-root-2',
      nonce: '9234567890abcdef1234567890abcdef', requestedAt: Date.now() };
    const root = { id: 86, windowId: 7, url: 'https://chatgpt.com/', status: 'complete', active: false };
    let created: typeof root | null = null;
    const acknowledgements: Record<string, unknown>[] = [];
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: { '86': { createdAt: Date.now(), conversationId: CHAT,
        openRequestId: 'open-draft-root-1', openState: 'redirected' } },
      tabDocuments: { '86': 'doc-86' }, tabEpochs: { '86': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/browser/open-chat') {
          acknowledgements.push(JSON.parse(String(init.body)));
          return response(200, { ok: true });
        }
        return response(200, { ok: true, repairs: [], openConversationRequests: [request] });
      },
      tabsQuery: async () => [root, OTHER_BROWSER_TAB, ...(created ? [created] : [])],
      tabsCreate: async properties => {
        created = { id: 186, windowId: 7, url: String(properties.url), status: 'complete', active: true };
        return created;
      },
      tabsGet: async id => id === 186 ? created! : root,
      tabsSendMessage: async () => ({ safe: false, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
    expect(worker.tabsCreate).toHaveBeenCalledWith(expect.objectContaining({
      url: `https://chatgpt.com/c/${CHAT}`,
      active: true
    }));
    expect(worker.tabsUpdate.mock.calls.some(([, update]) => typeof update.url === 'string')).toBe(false);
    expect(acknowledgements).toContainEqual(expect.objectContaining({
      requestId: request.requestId, outcome: 'opened'
    }));
    expect(session.data.appOwnedOpeningTabs).not.toHaveProperty('86');
  });

  it('starts redirected cleanup age once and does not refresh it on repeated root observations', async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: { '87': { createdAt: now - 10 * 60_000, conversationId: CHAT,
        openRequestId: 'open-age-transition', openState: 'opening' } },
      tabConversations: { '87': CHAT }, tabDocuments: { '87': 'doc-87' }, tabEpochs: { '87': 0 }
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session });
    try {
      await worker.createTab({ id: 87, url: `https://chatgpt.com/c/${CHAT}` });
      await worker.navigateTab(87, 'https://chatgpt.com/');
      const transitionedAt = (session.data.appOwnedOpeningTabs as Record<string, { createdAt: number }>)['87']!.createdAt;
      expect(transitionedAt).toBe(now);

      now += 60_000;
      await worker.navigateTab(87, 'https://chatgpt.com/');
      expect((session.data.appOwnedOpeningTabs as Record<string, { createdAt: number }>)['87']!.createdAt)
        .toBe(transitionedAt);
    } finally {
      clock.mockRestore();
    }
  });

  it('escalates one safely empty failed replacement once and never opens again across alarms or restart', async () => {
    const old = { id: 88, windowId: 7, url: 'https://chatgpt.com/', status: 'complete', active: false };
    const other = { ...OTHER_BROWSER_TAB };
    let replacement: typeof old | null = null;
    let publication: { conversationId: string; requestId: string; nonce: string; requestedAt: number } | null = null;
    const acknowledgements: Record<string, unknown>[] = [];
    const escalations: Record<string, unknown>[] = [];
    let safeEmpty = true;
    let acceptEscalation = false;
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: { '88': { createdAt: Date.now(), conversationId: CHAT,
        openRequestId: 'open-episode-0', openState: 'redirected', retargetCount: 0 } },
      tabDocuments: { '88': 'doc-88' }, tabEpochs: { '88': 0 }
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/browser/open-chat') {
          const body = JSON.parse(String(init.body));
          acknowledgements.push(body);
          if (publication?.requestId === body.requestId) publication = null;
          return response(200, { ok: true });
        }
        if (route === '/browser/unreachable-conversation') {
          const body = JSON.parse(String(init.body));
          escalations.push(body);
          const accepted = acceptEscalation && body.requestId === publication?.requestId &&
            body.requestNonce === publication?.nonce;
          return response(accepted ? 200 : 409,
            { accepted, ...body, token: 'continuation-token' });
        }
        return response(200, { ok: true, repairs: [],
          openConversationRequests: publication ? [publication] : [] });
      },
      tabsQuery: async () => [old, ...(replacement ? [replacement] : []), other],
      tabsGet: async id => id === old.id ? { ...old } : { ...replacement! },
      tabsCreate: async ({ url }) => {
        replacement = { id: 89, windowId: 7, url: String(url), status: 'loading', active: true };
        return { ...replacement };
      },
      tabsUpdate: async (id, properties) => {
        const tab = id === old.id ? old : replacement!;
        Object.assign(tab, properties);
        if (typeof properties.url === 'string') tab.status = 'loading';
        return { ...tab };
      },
      tabsSendMessage: async (id, message) => message.type === 'clf-tab-close-check'
        ? { safe: safeEmpty, conversationId: null,
            navigationEpoch: Number((session.data.tabEpochs as Record<string, number>)[String(id)]) }
        : { ok: true }
    });
    const request = (number: number) => ({ conversationId: CHAT,
      requestId: `open-episode-${number}`, nonce: `${number}234567890abcdef1234567890abcdef`,
      requestedAt: Date.now() });

    for (const number of [1, 2]) {
      publication = request(number);
      await worker.fireAlarm();
      expect(worker.tabsCreate).not.toHaveBeenCalled();
      old.url = 'https://chatgpt.com/';
      old.status = 'complete';
      await worker.navigateTab(old.id, old.url);
    }

    publication = request(3);
    await worker.fireAlarm();
    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
    expect((replacement as unknown as { url: string } | null)?.url)
      .toBe(`https://chatgpt.com/c/${CHAT}`);
    expect(session.data.appOwnedOpeningTabs).not.toHaveProperty(String(old.id));
    expect(session.data.appOwnedOpeningTabs).toMatchObject({
      '89': { conversationId: CHAT, replacementCreated: true, retargetCount: 2 }
    });

    replacement!.url = 'https://chatgpt.com/';
    replacement!.status = 'complete';
    await worker.navigateTab(89, replacement!.url);
    for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));

    // A draft/generation/attachment-safe proof is mandatory even after the bounded tab work
    // has been exhausted. The unsafe observation neither escalates nor spends another tab.
    safeEmpty = false;
    publication = request(4);
    await worker.fireAlarm();
    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
    expect(worker.tabsUpdate.mock.calls.filter(([id, update]) => id === 89 &&
      typeof update.url === 'string')).toHaveLength(0);
    expect(worker.tabsUpdate.mock.calls.filter(([id, update]) => id === old.id &&
      update.url === `https://chatgpt.com/c/${CHAT}`)).toHaveLength(2);
    expect(worker.tabsSendMessage.mock.calls.some(([, message]) => message.type === 'clf-retry-failed-turn')).toBe(false);
    expect(escalations).toEqual([]);
    expect(session.data.appOwnedOpeningTabs).toMatchObject({
      '89': { conversationId: CHAT, openState: 'redirected', replacementCreated: true, retargetCount: 2 }
    });

    safeEmpty = true;
    publication = request(5);
    await worker.fireAlarm();
    expect(escalations).toEqual([expect.objectContaining({
      conversationId: CHAT, requestId: 'open-episode-5', nonce: request(5).nonce,
      requestNonce: request(5).nonce
    })]);
    expect(acknowledgements).toContainEqual(expect.objectContaining({
      requestId: 'open-episode-5', failure: 'conversation_unreachable'
    }));
    expect(session.data.appOwnedOpeningTabs).toMatchObject({
      '89': { conversationId: CHAT, openState: 'escalated', escalationNonce: request(5).nonce,
        replacementCreated: true, retargetCount: 2 }
    });
    expect((session.data.appOwnedOpeningTabs as Record<string, { escalationReported?: boolean }>)['89']
      ?.escalationReported).not.toBe(true);

    // A transient bridge refusal retains the episode nonce but a later explicit Open carries its
    // own authority nonce. It retries the notice only; it still cannot retarget or create a tab.
    acceptEscalation = true;
    publication = request(6);
    await worker.fireAlarm();
    expect(escalations).toEqual([
      expect.objectContaining({ requestId: 'open-episode-5', nonce: request(5).nonce,
        requestNonce: request(5).nonce }),
      // The restart/alarm-safe retry carries no explicit-Open authority and is rejected. The
      // publication read later in this same pass then supplies the current request nonce.
      expect.objectContaining({ requestId: 'open-episode-5', nonce: request(5).nonce }),
      expect.objectContaining({ requestId: 'open-episode-6', nonce: request(5).nonce,
        requestNonce: request(6).nonce })
    ]);
    expect(escalations[1]).not.toHaveProperty('requestNonce');
    expect(acknowledgements).toContainEqual(expect.objectContaining({
      requestId: 'open-episode-6', failure: 'managed_continuation'
    }));
    expect(session.data.appOwnedOpeningTabs).toMatchObject({
      '89': { conversationId: CHAT, openState: 'escalated', escalationNonce: request(5).nonce,
        escalationReported: true, replacementCreated: true, retargetCount: 2 }
    });

    // The terminal tombstone is durable: ordinary alarms and a service-worker restart may
    // observe it, but cannot navigate/create/post again for this episode.
    await worker.fireAlarm();
    const restarted = loadWorker({
      local: new FakeStorageArea(paired), session,
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/browser/unreachable-conversation') {
          escalations.push(JSON.parse(String(init.body)));
          return response(200, { accepted: true });
        }
        return response(200, { ok: true, repairs: [], openConversationRequests: [] });
      },
      tabsQuery: async () => [old, replacement!, other],
      tabsGet: async id => id === old.id ? { ...old } : { ...replacement! },
      tabsSendMessage: async (_id, message) => message.type === 'clf-tab-close-check'
        ? { safe: true, conversationId: null,
            navigationEpoch: Number((session.data.tabEpochs as Record<string, number>)['89']) }
        : { ok: true }
    });
    await restarted.fireAlarm();
    expect(escalations).toHaveLength(3);
    expect(restarted.tabsCreate).not.toHaveBeenCalled();
    expect(restarted.tabsUpdate.mock.calls.some(([, update]) => typeof update.url === 'string')).toBe(false);

    replacement!.url = `https://chatgpt.com/c/${CHAT}`;
    await worker.registerTab(89, 'doc-89');
    await worker.send({ type: 'bind', conversationId: CHAT }, 89, 'doc-89');
    expect(session.data.appOwnedOpeningTabs).not.toHaveProperty('89');
    expect(acknowledgements.filter(row => row.outcome === 'opened')).toHaveLength(1);
  });

  it('rearms one retained loading conversation once per new Open request without another tab', async () => {
    const request = { conversationId: CHAT, requestId: 'open-loading-request-2',
      nonce: '8234567890abcdef1234567890abcdef', requestedAt: Date.now() };
    const tab = { id: 85, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`,
      status: 'loading', active: false };
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({
        appOwnedOpeningTabs: { '85': { createdAt: Date.now(), conversationId: CHAT,
          openRequestId: 'open-loading-request-1', openState: 'opening' } }
      }),
      fetch: async input => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/browser/open-chat') return response(503, {});
        return response(200, { ok: true, repairs: [], openConversationRequests: [request] });
      },
      tabsQuery: async () => [tab, OTHER_BROWSER_TAB]
    });

    await worker.fireAlarm();
    await worker.fireAlarm();

    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsUpdate.mock.calls.filter(([, properties]) =>
      properties.url === `https://chatgpt.com/c/${CHAT}`)).toHaveLength(1);
  });

  it.each([
    ['chrome_unavailable', async () => { throw new Error('browser snapshot unavailable'); }, undefined, undefined],
    ['focus_failure', async () => [{ id: 71, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: false }], async () => { throw new Error('focus failed'); }, undefined],
    ['tab_creation_failure', async () => [], undefined, async () => { throw new Error('create failed'); }],
    ['ambiguous_duplicate', async () => [
      { id: 72, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: true },
      { id: 73, windowId: 8, url: `https://chatgpt.com/c/${CHAT}`, active: true }
    ], undefined, undefined]
  ])('reports %s without claiming success or creating a duplicate', async (failure, tabsQuery, tabsUpdate, tabsCreate) => {
    const requestId = `request-${failure}`;
    const nonce = '3234567890abcdef1234567890abcdef';
    const acknowledgements: Record<string, unknown>[] = [];
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      fetch: async (input, init = {}) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/browser/open-chat') {
          acknowledgements.push(JSON.parse(String(init.body)));
          return response(200, { ok: true });
        }
        return response(200, { ok: true, repairs: [], openConversationRequests: [
          { conversationId: CHAT, requestId, nonce, requestedAt: Date.now() }
        ] });
      },
      tabsQuery,
      ...(tabsUpdate ? { tabsUpdate } : {}),
      ...(tabsCreate ? { tabsCreate } : {})
    });

    await worker.fireAlarm();
    if (failure === 'focus_failure') {
      await vi.waitFor(() => expect(acknowledgements).toHaveLength(1), { timeout: 4_000 });
    }

    expect(acknowledgements).toEqual([
      expect.objectContaining({ conversationId: CHAT, requestId, nonce, failure })
    ]);
    if (failure !== 'tab_creation_failure') expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('bounds a hung Chrome inventory and reports inventory_timeout instead of leaving Open pending', async () => {
    vi.useFakeTimers();
    try {
      const requestId = 'request-inventory-timeout';
      const nonce = '4234567890abcdef1234567890abcdef';
      const acknowledgements: Record<string, unknown>[] = [];
      const worker = loadWorker({
        local: new FakeStorageArea(paired),
        session: new FakeStorageArea(),
        fetch: async (input, init = {}) => {
          const route = new URL(input).pathname;
          if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
          if (route === '/browser/open-chat') {
            acknowledgements.push(JSON.parse(String(init.body)));
            return response(200, { ok: true });
          }
          return response(200, { ok: true, repairs: [], openConversationRequests: [
            { conversationId: CHAT, requestId, nonce, requestedAt: Date.now() }
          ] });
        },
        tabsQuery: () => new Promise(() => undefined)
      });

      const alarm = worker.fireAlarm();
      await vi.advanceTimersByTimeAsync(1_501);
      await vi.advanceTimersByTimeAsync(1_501);
      await vi.runAllTimersAsync();
      await alarm;

      expect(acknowledgements).toEqual([
        expect.objectContaining({ conversationId: CHAT, requestId, nonce, failure: 'inventory_timeout' })
      ]);
      expect(worker.tabsCreate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('active agent tab discard protection', () => {
  const paired = { port: 8765, token: 'paired-token' };
  const CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('protects the exact live chat and restores only the tab policy it changed', async () => {
    let live = true;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/status') {
        return response(200, {
          ok: true,
          repairs: [],
          recoveryMonitoring: live,
          nonDiscardableConversations: live ? [CHAT] : []
        });
      }
      return response(404, {});
    });
    const session = new FakeStorageArea();
    const worker = loadWorker({ local: new FakeStorageArea(paired), session, fetch });
    await worker.registerTab(81);
    await worker.send({ type: 'bind', conversationId: CHAT }, 81);

    await worker.fireAlarm();
    expect(worker.tabsUpdate).toHaveBeenCalledWith(81, { autoDiscardable: false });
    expect(session.data.discardProtectedTabs).toEqual({ '81': true });

    live = false;
    const restarted = loadWorker({
      local: new FakeStorageArea(paired),
      session,
      fetch,
      tabsQuery: async () => [
        { id: 81, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, autoDiscardable: false }
      ]
    });
    await restarted.fireAlarm();
    expect(restarted.tabsUpdate).toHaveBeenLastCalledWith(81, { autoDiscardable: true });
    expect(session.data.discardProtectedTabs).toEqual({});
  });

  it('closes finished managed chats but preserves the selected tab', async () => {
    const OLD_WORKER = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const COMPACTED = 'cccccccc-dddd-4eee-8fff-000000000000';
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/browser/managed-tab-close') return response(200, { ok: true, allowed: true });
      if (url.pathname === '/status') {
        return response(200, {
          ok: true,
          repairs: [],
          recoveryMonitoring: true,
          nonDiscardableConversations: [CHAT],
          managedConversations: [CHAT, OLD_WORKER, COMPACTED],
          workerConversations: [OLD_WORKER],
          workerTabCloseClaims: { [OLD_WORKER]: '1234567890abcdef1234567890abcdef' },
          retiredConversations: [COMPACTED],
          tabsToKeepOpen: 1,
          closableConversations: [OLD_WORKER, COMPACTED]
        });
      }
      return response(404, {});
    });
    const tabs = [
      { id: 91, windowId: 7, url: `https://chatgpt.com/c/${CHAT}` },
      { id: 92, windowId: 7, url: `https://chatgpt.com/c/${OLD_WORKER}` },
      { id: 93, windowId: 7, url: `https://chatgpt.com/c/${COMPACTED}`, active: true },
      { id: 94, windowId: 8, url: `https://chatgpt.com/c/${COMPACTED}` }
    ];
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({ tabDocuments: Object.fromEntries(tabs.map(tab => [tab.id, `doc-${tab.id}`])), tabEpochs: Object.fromEntries(tabs.map(tab => [tab.id, 0])) }),
      fetch,
      tabsQuery: async () => tabs,
      tabsGet: async id => tabs.find(tab => tab.id === id)!,
      tabsSendMessage: async id => ({ safe: true, navigationEpoch: 0, conversationId: tabs.find(tab => tab.id === id)!.url.split('/c/')[1] })
    });

    await worker.fireAlarm();
    expect(worker.tabsRemove.mock.calls.map((call) => call[0]).sort()).toEqual([92, 94]);
    // The live prime chat is still protected, never closed.
    expect(worker.tabsUpdate).toHaveBeenCalledWith(91, { autoDiscardable: false });
  });

  it('closes one confirmed superseded handoff source without weakening ordinary main-tab safety', async () => {
    const SUPERSEDED = 'cccccccc-dddd-4eee-8fff-000000000001';
    const retirementReceipts: string[] = [];
    const closed: Array<{ conversationId: string; manual: boolean }> = [];
    let appDown = true;
    let closeSpent = false;
    const fetch = vi.fn(async (input: string, init?: Record<string, unknown>) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/browser/superseded-source-retired') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { conversationId: string; receiptId: string };
        retirementReceipts.push(body.receiptId);
        if (appDown) return response(503, {});
        expect(body.conversationId).toBe(SUPERSEDED);
        closeSpent = true;
        return response(200, { ok: true, acknowledged: true, spent: true, status: 'spent' });
      }
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init?.body ?? '{}')));
        return response(200, { ok: true });
      }
      if (url.pathname === '/status') {
        return response(200, {
          ok: true, repairs: [], recoveryMonitoring: true,
          managedConversations: closeSpent ? [CHAT] : [CHAT, SUPERSEDED], workerConversations: [],
          retiredConversations: closeSpent ? [] : [SUPERSEDED],
          supersededConversations: closeSpent ? [] : [SUPERSEDED],
          closableConversations: closeSpent ? [] : [SUPERSEDED], nonDiscardableConversations: []
        });
      }
      return response(404, {});
    });
    const tabs = [
      { id: 95, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, active: true },
      { id: 96, windowId: 7, url: `https://chatgpt.com/c/${SUPERSEDED}`, active: false }
    ];
    const local = new FakeStorageArea(paired);
    const worker = loadWorker({
      local,
      session: new FakeStorageArea({
        tabConversations: { '95': CHAT, '96': SUPERSEDED },
        tabDocuments: { '95': 'doc-95', '96': 'doc-96' }, tabEpochs: { '95': 0, '96': 0 }
      }),
      fetch,
      tabsQuery: async () => tabs,
      tabsGet: async id => tabs.find(tab => tab.id === id)!,
      tabsSendMessage: async id => ({ safe: true, navigationEpoch: 0,
        conversationId: tabs.find(tab => tab.id === id)!.url.split('/c/')[1] })
    });

    await worker.fireAlarm();
    expect(worker.tabsRemove).toHaveBeenCalledWith(96);
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(95);
    // tabs.remove success itself durably publishes the exact receipt. Do not fire onRemoved here:
    // this models Chrome exiting after remove resolves but before that lifecycle event is delivered.
    const queuedAfterRemove = local.data.closeOutbox as Array<{
      retirement?: { receiptId?: string }
    }>;
    expect(queuedAfterRemove).toHaveLength(1);
    const queuedReceipt = queuedAfterRemove[0]?.retirement?.receiptId;
    expect(queuedReceipt).toMatch(/^[a-f0-9]{32}$/);
    tabs.splice(tabs.findIndex(tab => tab.id === 96), 1);

    // A fresh worker with an empty storage.session models a browser restart during the Main
    // outage. The lifecycle outbox's local copy remains the close authority fence.
    const restarted = loadWorker({
      local,
      session: new FakeStorageArea(),
      fetch,
      tabsQuery: async () => tabs,
      tabsGet: async id => tabs.find(tab => tab.id === id)!,
      tabsSendMessage: async id => ({ safe: true, navigationEpoch: 0,
        conversationId: tabs.find(tab => tab.id === id)!.url.split('/c/')[1] })
    });

    // Main is still down and its cached policy continues to advertise A. The exact local receipt
    // nevertheless fences the immediate user reopen, and retries the same receipt rather than
    // issuing a second close.
    tabs.push({ id: 99, windowId: 7, url: `https://chatgpt.com/c/${SUPERSEDED}`, active: false });
    await restarted.registerTab(99);
    await restarted.send({ type: 'bind', conversationId: SUPERSEDED }, 99);
    await restarted.fireAlarm();
    expect(restarted.tabsRemove).not.toHaveBeenCalledWith(99);
    expect(new Set(retirementReceipts)).toEqual(new Set([queuedReceipt]));

    // The outbox survives until Main durably ACKs the exact receipt. Because A is open again,
    // this was not a last-view closure and /closed must remain untouched.
    appDown = false;
    await restarted.fireAlarm();
    await restarted.fireAlarm();
    expect(closeSpent).toBe(true);
    expect(restarted.tabsRemove).not.toHaveBeenCalledWith(99);
    expect(local.data.closeOutbox).toEqual([]);
    expect(closed).toEqual([]);
  });

  it('moves selection to a confirmed handoff successor before retiring the selected source', async () => {
    const SOURCE = 'cccccccc-dddd-4eee-8fff-000000000011';
    const DESTINATION = 'cccccccc-dddd-4eee-8fff-000000000012';
    const tabs = [
      { id: 97, windowId: 7, url: `https://chatgpt.com/c/${SOURCE}`, active: true },
      { id: 98, windowId: 7, url: `https://chatgpt.com/c/${DESTINATION}`, active: false }
    ];
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({
        tabDocuments: { '97': 'doc-97', '98': 'doc-98' }, tabEpochs: { '97': 0, '98': 0 }
      }),
      fetch: async input => {
        if (new URL(input).pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        return response(200, {
          ok: true, repairs: [], recoveryMonitoring: true,
          managedConversations: [SOURCE, DESTINATION], mainConversations: [SOURCE, DESTINATION],
          workerConversations: [], nonDiscardableConversations: [],
          retiredConversations: [SOURCE], supersededConversations: [SOURCE],
          supersededSuccessors: { [SOURCE]: DESTINATION }, closableConversations: [SOURCE]
        });
      },
      tabsQuery: async () => tabs,
      tabsGet: async id => tabs.find(tab => tab.id === id)!,
      tabsUpdate: async (id, properties) => {
        if (properties.active === true) {
          for (const tab of tabs) if (tab.windowId === 7) tab.active = tab.id === id;
        }
        return { id, windowId: 7, ...properties };
      },
      tabsSendMessage: async id => ({ safe: true, navigationEpoch: 0,
        conversationId: tabs.find(tab => tab.id === id)!.url.split('/c/')[1] })
    });

    await worker.fireAlarm();
    expect(worker.tabsUpdate).toHaveBeenCalledWith(98, { active: true });
    expect(worker.tabsRemove).toHaveBeenCalledWith(97);
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(98);
  });

  it('keeps a selected superseded source when its successor is not available in the same window', async () => {
    const SOURCE = 'cccccccc-dddd-4eee-8fff-000000000013';
    const DESTINATION = 'cccccccc-dddd-4eee-8fff-000000000014';
    const tabs = [
      { id: 101, windowId: 7, url: `https://chatgpt.com/c/${SOURCE}`, active: true },
      { id: 102, windowId: 8, url: `https://chatgpt.com/c/${DESTINATION}`, active: true }
    ];
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({
        tabDocuments: { '101': 'doc-101' }, tabEpochs: { '101': 0 }
      }),
      fetch: async input => {
        if (new URL(input).pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        return response(200, {
          ok: true, repairs: [], recoveryMonitoring: true,
          managedConversations: [SOURCE, DESTINATION], mainConversations: [SOURCE, DESTINATION],
          workerConversations: [], nonDiscardableConversations: [],
          retiredConversations: [SOURCE], supersededConversations: [SOURCE],
          supersededSuccessors: { [SOURCE]: DESTINATION }, closableConversations: [SOURCE]
        });
      },
      tabsQuery: async () => tabs,
      tabsGet: async id => tabs.find(tab => tab.id === id)!
    });

    await worker.fireAlarm();
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(101);
    expect(worker.tabsUpdate).not.toHaveBeenCalledWith(102, { active: true });
  });

  it('closes an exact locally deleted main-chat tab after its page proves safe', async () => {
    const DELETED = 'dddddddd-eeee-4fff-8aaa-111111111111';
    const tab = { id: 95, windowId: 7, url: `https://chatgpt.com/c/${DELETED}`,
      active: true, pinned: false };
    const unrelated = { id: 96, windowId: 8, url: 'https://example.com/', active: true, pinned: false };
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({ tabDocuments: { '95': 'doc-95' }, tabEpochs: { '95': 0 } }),
      fetch: async input => {
        const pathname = new URL(input).pathname;
        if (pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (pathname === '/browser/managed-tab-close') return response(200, { allowed: true });
        return response(200, {
          ok: true,
          repairs: [],
          managedConversations: [DELETED],
          deletedConversations: [DELETED],
          retiredConversations: [DELETED],
          closableConversations: [DELETED],
          managedTabCloseClaims: { [DELETED]: '1234567890abcdef1234567890abcdef' },
          nonDiscardableConversations: []
        });
      },
      tabsQuery: async () => [tab, unrelated],
      tabsGet: async () => tab,
      tabsSendMessage: async () => ({ safe: true, navigationEpoch: 0, conversationId: DELETED })
    });

    await worker.fireAlarm();
    expect(worker.tabsRemove).toHaveBeenCalledExactlyOnceWith(95);
  });

  it('parks an inactive Rotation main-chat tab without treating every main chat as disposable', async () => {
    const PARKED = 'eeeeeeee-ffff-4aaa-8bbb-222222222222';
    const ACTIVE_BATCH = 'ffffffff-aaaa-4bbb-8ccc-333333333333';
    const tabs = [
      { id: 97, windowId: 7, url: `https://chatgpt.com/c/${PARKED}`, active: false, pinned: false },
      { id: 98, windowId: 7, url: `https://chatgpt.com/c/${ACTIVE_BATCH}`, active: false, pinned: false }
    ];
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({
        tabDocuments: { '97': 'doc-97', '98': 'doc-98' },
        tabEpochs: { '97': 0, '98': 0 }
      }),
      fetch: async input => {
        const pathname = new URL(input).pathname;
        if (pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        return response(200, {
          ok: true,
          repairs: [],
          managedConversations: [PARKED, ACTIVE_BATCH],
          retiredConversations: [PARKED],
          parkedRotationConversations: [PARKED],
          closableConversations: [PARKED],
          nonDiscardableConversations: [ACTIVE_BATCH]
        });
      },
      tabsQuery: async () => tabs,
      tabsGet: async id => tabs.find(tab => tab.id === id)!,
      tabsSendMessage: async id => ({
        safe: true,
        navigationEpoch: 0,
        conversationId: tabs.find(tab => tab.id === id)!.url.split('/c/')[1]
      })
    });

    await worker.fireAlarm();
    expect(worker.tabsRemove).toHaveBeenCalledExactlyOnceWith(97);
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(98);
  });

  it('does not claim or restore a tab Chrome was already told not to discard', async () => {
    let live = true;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/status') {
        return response(200, {
          ok: true,
          repairs: [],
          recoveryMonitoring: live,
          nonDiscardableConversations: live ? [CHAT] : []
        });
      }
      return response(404, {});
    });
    const session = new FakeStorageArea();
    const worker = loadWorker({ local: new FakeStorageArea(paired), session, fetch });
    await worker.createTab({ id: 82, url: `https://chatgpt.com/c/${CHAT}`, autoDiscardable: false });
    await worker.registerTab(82);
    await worker.send({ type: 'bind', conversationId: CHAT }, 82);

    await worker.fireAlarm();
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
    expect(session.data.discardProtectedTabs).toEqual({});

    live = false;
    await worker.fireAlarm();
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
  });
});

describe('app-owned retained tab pool', () => {
  it('keeps a later manual close queued when an older automatic close response arrives', async () => {
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000071';
    let release!: () => void;
    const first = new Promise<void>(resolve => { release = resolve; });
    const bodies: Array<{ conversationId: string; manual: boolean }> = [];
    const code = backgroundSource.slice(backgroundSource.indexOf('async function enqueueClose('),
      backgroundSource.indexOf('\n/**\n * Removes one tab'));
    const outbox = vm.runInNewContext(`${code}\n({enqueueClose, drainCloses})`, {
      cleanConversationId: (id: string) => id,
      instanceId: 'profile-test', port: 8765, unassignedHistoryUncertain: false, unassignedHistoryConversation: () => false,
      recoveryMonitoring: false,
      closeOutbox: [],
      closing: false,
      token: 'paired',
      load: async () => undefined,
      persistLive: async () => undefined,
      scheduleRetry: () => undefined,
      clearRetryIfIdle: () => undefined,
      conversationProvenAbsent: async () => true,
      call: async (_route: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        if (bodies.length === 1) await first;
        return { ok: true };
      }
    });

    await outbox.enqueueClose(conversationId, true);
    const draining = outbox.drainCloses();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    await outbox.enqueueClose(conversationId, false);
    release();
    expect(await draining).toMatchObject({ pending: 1 });
    expect(await outbox.drainCloses()).toMatchObject({ pending: 0 });
    expect(bodies).toEqual([
      { conversationId, manual: false },
      { conversationId, manual: true }
    ]);
  });

  it('classifies /closed by the newest close while preserving an exact retirement ACK', async () => {
    const first = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000072';
    const second = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000073';
    const receipt = {
      kind: 'superseded-source',
      receiptId: '44444444444444444444444444444444',
      tab: 72,
      documentId: 'doc-72',
      navigationEpoch: 0
    };
    const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
    const code = backgroundSource.slice(backgroundSource.indexOf('async function enqueueClose('),
      backgroundSource.indexOf('\n/**\n * Removes one tab'));
    const outbox = vm.runInNewContext(`${code}\n({enqueueClose, drainCloses})`, {
      cleanConversationId: (id: string) => id,
      instanceId: 'profile-test', port: 8765, unassignedHistoryUncertain: false, unassignedHistoryConversation: () => false,
      recoveryMonitoring: false,
      closeOutbox: [],
      closing: false,
      token: 'paired',
      load: async () => undefined,
      persistLive: async () => undefined,
      scheduleRetry: () => undefined,
      clearRetryIfIdle: () => undefined,
      conversationProvenAbsent: async () => true,
      call: async (route: string, init: { body: string }) => {
        calls.push({ route, body: JSON.parse(init.body) });
        return { ok: true };
      }
    });

    // A later automatic retirement supersedes an older undelivered manual classification.
    await outbox.enqueueClose(first, false);
    await outbox.enqueueClose(first, true, receipt);
    await outbox.drainCloses();
    expect(calls.slice(0, 2)).toEqual([
      { route: '/browser/superseded-source-retired', body: { conversationId: first, receiptId: receipt.receiptId } },
      { route: '/closed', body: { conversationId: first, manual: false } }
    ]);

    // A still-later real user close wins only /closed classification; the exact ACK is retained.
    calls.length = 0;
    await outbox.enqueueClose(second, true, { ...receipt, tab: 73 });
    await outbox.enqueueClose(second, false);
    await outbox.drainCloses();
    expect(calls).toEqual([
      { route: '/browser/superseded-source-retired', body: { conversationId: second, receiptId: receipt.receiptId } },
      { route: '/closed', body: { conversationId: second, manual: true } }
    ]);
  });

  const id = (n: number) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`;
  async function budget(options: { safe?: (tab: number) => boolean; changed?: number; keep?: number; recent?: number; protectDuplicate?: boolean; reverseActivity?: boolean; retired?: boolean; idle?: boolean; ordinary?: number; pinned?: number } = {}) {
    const tabs = [1, 2, 3, 4, 5, 6].map(n => ({ id: n, windowId: n === 5 ? 9 : 7, url: `https://chatgpt.com/c/${id(n === 4 ? 3 : n)}`, active: n === 5, pinned: n === options.pinned, lastAccessed: n === options.recent ? Date.now() : 0 }));
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea({ tabDocuments: Object.fromEntries(tabs.map(tab => [tab.id, `doc-${tab.id}`])), tabEpochs: Object.fromEntries(tabs.map(tab => [tab.id, 0])) }),
      fetch: async input => {
        const pathname = new URL(input).pathname;
        if (pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (pathname === '/browser/managed-tab-close') return response(200, { ok: true, allowed: true });
        return response(200, {
          ok: true, repairs: [], tabsToKeepOpen: options.keep ?? 2, retiredConversations: options.retired ? [id(2), id(5)] : [],
          workerConversations: [1, 2, 3, 5].filter(n => n !== options.ordinary).map(id), sleepingWorkerConversations: [2, 3, 5].map(id),
          workerTabCloseClaims: options.idle ? Object.fromEntries([2, 3, 5].map(n => [id(n), `${String(n).repeat(32)}`])) : {},
          conversationActivityAt: Object.fromEntries([1, 2, 3, 5].map(n => [id(n), (options.reverseActivity ? 10 - n : n) * 1000])),
          managedConversations: [1, 2, 3, 5].map(id), nonDiscardableConversations: [id(1), ...(options.protectDuplicate ? [id(3)] : [])], closableConversations: options.idle ? [2, 3, 5].map(id) : []
        });
      },
      tabsQuery: async () => tabs,
      windowsGet: async () => ({ focused: true }),
      tabsGet: async n => ({ ...tabs.find(tab => tab.id === n)!, ...(n === options.changed ? { url: `https://chatgpt.com/c/${id(99)}` } : {}) }),
      tabsSendMessage: async n => ({ safe: options.safe?.(n) ?? true, navigationEpoch: 0, conversationId: tabs.find(tab => tab.id === n)!.url.split('/c/')[1] })
    });
    await worker.fireAlarm();
    return worker;
  }
  it('retains sleeping chats regardless of broker capacity and removes only an exact idle duplicate', async () => {
    const worker = await budget();
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([4]);
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(1); // live app work
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(6); // unrelated manual chat
  });
  it('preserves a user-pinned duplicate while still retiring an unpinned terminal worker', async () => {
    const worker = await budget({ pinned: 4, retired: true });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([2]);
  });
  it('retires explicitly terminal workers while preserving drafts and live work', async () => {
    const worker = await budget({ keep: 20, retired: true, safe: n => n !== 5 });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([4, 2]);
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(5);
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(1);
  });
  it('keeps idle conversations below the pool limit while removing an idle duplicate', async () => {
    const worker = await budget({ keep: 20 });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([4]);
  });
  it('keeps waiting prime and helper tabs as well as reusable worker tabs', async () => {
    const worker = await budget({ ordinary: 1 });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([4]);
  });
  it('releases idle pages independently of worker capacity while keeping the selected page', async () => {
    const worker = await budget({ keep: 20, idle: true });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([4, 2, 3]);
  });
  it('does not use tab selection as model activity', async () => {
    const worker = await budget({ recent: 5 });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([4]);
  });
  it('removes a proven-safe inactive duplicate but never the selected protected conversation', async () => {
    const worker = await budget({ protectDuplicate: true, retired: true });
    expect(worker.tabsRemove.mock.calls.map(call => call[0]).sort()).toEqual([2, 4]);
  });
  it('keeps the last exact conversation tab when its duplicate keeper closes during proof', async () => {
    const conversationId = id(1);
    const keeper = { id: 81, windowId: 7, url: `https://chatgpt.com/c/${conversationId}`,
      active: true, lastAccessed: 200 };
    const duplicate = { id: 82, windowId: 7, url: `https://chatgpt.com/c/${conversationId}`,
      active: false, lastAccessed: 100 };
    let keeperLive = true;
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea({
        tabDocuments: { '81': 'doc-81', '82': 'doc-82' }, tabEpochs: { '81': 0, '82': 0 }
      }),
      fetch: async input => response(200, new URL(input).pathname === '/hello'
        ? { app: 'chat-on-steroids', paired: true }
        : { ok: true, repairs: [], managedConversations: [conversationId],
            nonDiscardableConversations: [conversationId] }),
      tabsQuery: async () => [ ...(keeperLive ? [keeper] : []), duplicate,
        { id: 999, windowId: 8, url: 'https://example.com/' } ],
      tabsGet: async id => id === duplicate.id ? duplicate : keeper,
      tabsSendMessage: async id => {
        if (id === duplicate.id) keeperLive = false;
        return { safe: true, conversationId, navigationEpoch: 0 };
      }
    });

    await worker.fireAlarm();

    expect(worker.tabsRemove).not.toHaveBeenCalledWith(duplicate.id);
  });
  it('orders terminal retirement by work time without evicting other waiting chats', async () => {
    const worker = await budget({ reverseActivity: true, recent: 5, retired: true });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([4, 2]);
  });
  it('retains drafts/unreadable pages and refuses a navigated candidate', async () => {
    const worker = await budget({ safe: n => n !== 3 && n !== 4, changed: 5, retired: true });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([2]);
  });
});

describe('worker settings authority', () => {
  const paired = { port: 8765, token: 'paired-token' };
  const CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('forwards positive deletion only from the current owned document and exact route', async () => {
    const posted: Record<string, unknown>[] = [];
    let url = `https://chatgpt.com/c/${CHAT}`;
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(),
      tabsGet: async () => ({ id: 42, url }),
      fetch: async (input, init) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/conversation/deleted') posted.push(JSON.parse(String(init?.body ?? '{}')));
        return response(200, { ok: true });
      }
    });
    await worker.registerTab(42);
    expect(await worker.send({ type: 'conversation_deleted', conversationId: CHAT }, 42)).toMatchObject({ ok: true });
    expect(posted).toEqual([{ conversationId: CHAT }]);
    url = 'https://chatgpt.com/c/bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    expect(await worker.send({ type: 'conversation_deleted', conversationId: CHAT }, 42)).toMatchObject({ ok: false });
    url = `https://chatgpt.com/c/${CHAT}`;
    await worker.registerTab(42, 'replacement-document');
    expect(await worker.send({ type: 'conversation_deleted', conversationId: CHAT }, 42, 'document-42-0')).toMatchObject({ ok: false });
    expect(posted).toHaveLength(1);
  });

  it.each(['foreign', 'pending', 'invalid'])('refuses %s deletion claims before the app boundary', async fault => {
    const posted: string[] = [];
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(),
      tabsGet: async () => ({ id: 42, url: fault === 'foreign' ? `https://example.com/c/${CHAT}` : `https://chatgpt.com/c/${CHAT}`,
        ...(fault === 'pending' ? { pendingUrl: 'https://chatgpt.com/' } : {}) }),
      fetch: async input => { const route = new URL(input).pathname; posted.push(route);
        return response(200, route === '/hello' ? { app: 'chat-on-steroids', paired: true } : { ok: true }); }
    });
    await worker.registerTab(42);
    expect(await worker.send({ type: 'conversation_deleted', conversationId: fault === 'invalid' ? 'a'.repeat(36) : CHAT }, 42))
      .toMatchObject({ ok: false });
    expect(posted).not.toContain('/conversation/deleted');
  });

  it('reports a fresh command document browser route while excluding its source chat', async () => {
    const source = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const replacement = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      tabsGet: async () => ({
        id: 42,
        url: `https://chatgpt.com/c/${source}`,
        pendingUrl: `https://chatgpt.com/c/${replacement}`
      })
    });
    await worker.registerTab(42, 'resume-document');
    expect(await worker.send({ type: 'tab_conversation', sourceConversationId: source }, 42, 'resume-document')).toEqual({
      ok: true,
      conversationId: replacement
    });
    await worker.registerTab(42, 'new-document');
    expect(await worker.send({ type: 'tab_conversation', sourceConversationId: source }, 42, 'resume-document')).toMatchObject({
      ok: false,
      error: 'stale_document'
    });
  });

  it('authorizes Stop through the real runtime dispatcher and rejects a retired document', async () => {
    const posted: string[] = [];
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(),
      tabsGet: async () => ({ id: 42, url: `https://chatgpt.com/c/${CHAT}` }),
      fetch: async input => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        posted.push(route);
        return response(200, { ok: true, command: { type: 'stop', conversationId: CHAT, turnId: 'live-turn' } });
      }
    });
    await worker.registerTab(42);
    const command = { id: '1111111111111111', client: 'page-owner', conversationId: CHAT, turnId: 'live-turn' };
    expect(await worker.send({ type: 'stop_redeem', ...command }, 42)).toMatchObject({ ok: true, command: { type: 'stop' } });
    expect(await worker.send({ type: 'stop_ack', status: 'sent', ...command }, 42)).toMatchObject({ ok: true });
    expect(posted).toContain('/commands/redeem');
    await worker.registerTab(42, 'replacement-document');
    const before = posted.filter(route => route === '/commands/redeem').length;
    expect(await worker.send({ type: 'stop_redeem', ...command }, 42, 'document-42-0')).toMatchObject({ ok: false, error: 'stale_document' });
    expect(posted.filter(route => route === '/commands/redeem')).toHaveLength(before);
  });

  it('forwards auto-compaction writes with the source tab conversation so the app can reject worker authority', async () => {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/settings' && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body || '{}')));
        return response(409, { error: 'worker_compaction_disabled' });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(42);
    await worker.send({ type: 'bind', conversationId: CHAT }, 42);

    const reply = await worker.send({ type: 'settings_set', conversationId: CHAT, autoCompact: false }, 42);
    expect(reply).toMatchObject({ ok: false, status: 409, data: { error: 'worker_compaction_disabled' } });
    expect(posted).toEqual([{ autoCompact: false, conversationId: CHAT }]);
  });

  it('forwards compaction ticket, safe source loss, and both irreversible dispatch checkpoints', async () => {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/compact' && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body || '{}')));
        return response(200, { ok: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsGet: async () => ({ id: 44, url: `https://chatgpt.com/c/${CHAT}` }) });
    await worker.registerTab(44);
    await worker.send({ type: 'bind', conversationId: CHAT }, 44);
    const token = '0123456789abcdef0123456789abcdef';

    await worker.send({ type: 'compact', conversationId: CHAT, ticket: true, automatic: true }, 44);
    await worker.send({ type: 'compact', conversationId: CHAT, token, sourceLost: true }, 44);
    await worker.send({ type: 'compact', conversationId: CHAT, token, sourceDispatch: true }, 44);
    await worker.send({ type: 'compact', conversationId: CHAT, token, destinationDispatch: true }, 44);

    expect(posted).toEqual([
      expect.objectContaining({ conversationId: CHAT, ticket: true, automatic: true }),
      expect.objectContaining({ conversationId: CHAT, token, sourceLost: true }),
      expect.objectContaining({ conversationId: CHAT, token, sourceDispatch: true }),
      expect.objectContaining({ conversationId: CHAT, token, destinationDispatch: true })
    ]);
  });

  it('forwards the displayed token for public Cancel without accepting an unbounded cancel token', async () => {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/compact' && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body || '{}'))); return response(200, {});
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsGet: async () => ({ id: 44, url: `https://chatgpt.com/c/${CHAT}` }) });
    await worker.registerTab(44); await worker.send({ type: 'bind', conversationId: CHAT }, 44);
    await worker.send({ type: 'compact', conversationId: CHAT, cancel: true, token: 'cancel-shown-a' }, 44);
    expect(posted[0]).toMatchObject({ conversationId: CHAT, cancel: true, token: 'cancel-shown-a' });
    await worker.send({ type: 'compact', conversationId: CHAT, cancel: true, token: 'x'.repeat(129) }, 44);
    expect(posted[1]).not.toHaveProperty('token');
  });

  it('carries destinationLost, and still refuses anything not on the checkpoint list', async () => {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/compact' && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body || '{}')));
        return response(200, { ok: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsGet: async () => ({ id: 44, url: `https://chatgpt.com/c/${CHAT}` }) });
    await worker.registerTab(44);
    await worker.send({ type: 'bind', conversationId: CHAT }, 44);
    const token = '0123456789abcdef0123456789abcdef';

    // The page sends this and the app acts on it — it retires the lease and re-offers the brief
    // to a fresh chat at once instead of waiting the lease out. The relay used to drop it.
    await worker.send({ type: 'compact', conversationId: CHAT, token, destinationLost: true }, 44);
    // A field nobody named must not ride along on a valid token.
    await worker.send({ type: 'compact', conversationId: CHAT, token, sourceLost: true, invented: true }, 44);
    // And a checkpoint without its token says nothing about any transaction.
    await worker.send({ type: 'compact', conversationId: CHAT, destinationLost: true }, 44);

    expect(posted).toHaveLength(3);
    expect(posted[0]).toMatchObject({ conversationId: CHAT, token, destinationLost: true });
    expect(posted[1]).toMatchObject({ conversationId: CHAT, token, sourceLost: true });
    expect(posted[1]).not.toHaveProperty('invented');
    expect(posted[2]).not.toHaveProperty('destinationLost');
    expect(posted[2]).not.toHaveProperty('token');
  });

  it.each(['new-chat', 'other-chat', 'pending-navigation'])('checks the current Chrome route for compaction after %s', async scenario => {
    const currentUrl = scenario === 'other-chat' ? 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      : `https://chatgpt.com/g/g-p-abcdef1234567890abcdef1234567890/c/${CHAT}`;
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      if (new URL(input).pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (new URL(input).pathname === '/compact') posted.push(JSON.parse(String(init.body)));
      return response(200, { ok: true });
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsGet: async () => ({ id: 44, url: currentUrl, ...(scenario === 'pending-navigation' ? { pendingUrl: 'https://chatgpt.com/' } : {}) }) });
    await worker.registerTab(44);
    const reply = await worker.send({ type: 'compact', conversationId: CHAT, ticket: true }, 44, undefined, 'https://chatgpt.com/');
    if (scenario === 'new-chat') {
      expect(reply).toMatchObject({ ok: true });
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ conversationId: CHAT, project: expect.any(String) });
    } else {
      expect(reply).toMatchObject({ ok: false, error: 'stale_document' });
      expect(posted).toEqual([]);
    }
  });

  /**
   * Which Chrome instance the replacement chat is created in.
   *
   * The user had two Chrome instances open. A chat finished in the background one, Compact &
   * Resume captured its summary, and the app asked the operating system to open chat B — which
   * resolved to the foreground instance, because that is what `chrome.exe <url>` does. The
   * summary was typed into a chat in a browser this extension was not loaded in, nothing ever
   * redeemed the command, and the handoff was left connected to nothing.
   *
   * No argument names a window and no extension can report which instance it is, so the app
   * cannot decide this from outside. It answers the capture request with the successor instead,
   * and the browser that holds chat A creates the tab in chat A's own window.
   */
  it('opens the replacement chat in the window of the chat it continues', async () => {
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/compact' && init.method === 'POST') {
        return response(200, { stored: true, commandId: 'cmd-handoff', placement: { id: 'cmd-handoff' } });
      }
      return response(404, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      fetch,
      // Chat A's tab, in the background instance's window, third from the left.
      tabsGet: async () => ({ id: 45, windowId: 9, index: 2, url: `https://chatgpt.com/c/${CHAT}` }) as never
    });
    await worker.registerTab(45);
    await worker.send({ type: 'bind', conversationId: CHAT }, 45);

    await worker.send(
      { type: 'compact', conversationId: CHAT, token: '0123456789abcdef0123456789abcdef', summary: 'the brief' },
      45
    );

    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
    const created = worker.tabsCreate.mock.calls[0]![0] as Record<string, unknown>;
    // The window is the whole point. The marker is the app's command id and nothing else —
    // redeeming it still requires the pairing token this worker holds.
    expect(created.windowId).toBe(9);
    expect(created.index).toBe(3);
    expect(String(created.url)).toBe('https://chatgpt.com/?clf=cmd-handoff#clf=cmd-handoff');
    // Active in its own window, and its own window only: nothing here focuses that window, so
    // a handoff in the background instance does not yank the user out of the one they are in.
    expect(created.active).toBe(true);
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
  });

  it('reuses and rearms the exact empty 16-hex command root instead of opening a duplicate', async () => {
    const commandId = '4e689b755134a55a';
    const source = { id: 45, windowId: 9, index: 2, url: `https://chatgpt.com/c/${CHAT}` };
    const root = { id: 49, windowId: 9, index: 3, status: 'complete', active: false,
      url: `https://chatgpt.com/?clf=${commandId}&reasoning_effort=pro#clf=${commandId}` };
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/compact' && init.method === 'POST') {
        return response(200, { stored: true, commandId, placement: { id: commandId } });
      }
      return response(404, {});
    });
    const proof = vi.fn(async () => ({ safe: true, conversationId: null, navigationEpoch: 0 }));
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({
        appOwnedOpeningTabs: { '49': { createdAt: Date.now(), marker: commandId } },
        tabDocuments: { '49': 'root-document' },
        tabEpochs: { '49': 0 }
      }),
      fetch,
      tabsQuery: async () => [source, root],
      tabsGet: async id => (id === root.id ? root : source) as never,
      tabsSendMessage: async (id, message) => id === root.id && message.type === 'clf-tab-close-check'
        ? proof()
        : { ok: true }
    });
    await worker.registerTab(source.id);

    await worker.send(
      { type: 'compact', conversationId: CHAT, token: '0123456789abcdef0123456789abcdef', summary: 'the brief' },
      source.id
    );

    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(proof).toHaveBeenCalledTimes(1);
    expect(worker.tabsUpdate).toHaveBeenCalledWith(root.id, { active: true });
    expect(worker.tabsReload).toHaveBeenCalledExactlyOnceWith(root.id);
  });

  it('restores a consumed clf marker on its proven-empty reasoning-only tab instead of opening another', async () => {
    const commandId = '4e689b755134a55a';
    const source = { id: 45, windowId: 9, index: 2, url: `https://chatgpt.com/c/${CHAT}` };
    const root = { id: 49, windowId: 9, index: 3, status: 'complete', active: false,
      url: 'https://chatgpt.com/?reasoning_effort=pro' };
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({
        appOwnedOpeningTabs: { '49': { createdAt: Date.now(), marker: commandId } },
        tabDocuments: { '49': 'root-document' },
        tabEpochs: { '49': 0 }
      }),
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/compact' && init.method === 'POST') {
          return response(200, { stored: true, commandId,
            placement: { id: commandId, reasoningEffort: 'pro' } });
        }
        return response(404, {});
      },
      tabsQuery: async () => [source, root],
      tabsGet: async id => (id === root.id ? root : source) as never,
      tabsUpdate: async (id, properties) => ({ ...(id === root.id ? root : source), ...properties }),
      tabsSendMessage: async (_id, message) => message.type === 'clf-tab-close-check'
        ? { safe: true, conversationId: null, navigationEpoch: 0 }
        : { ok: true }
    });
    await worker.registerTab(source.id);

    await worker.send(
      { type: 'compact', conversationId: CHAT, token: '0123456789abcdef0123456789abcdef', summary: 'the brief' },
      source.id
    );

    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).toHaveBeenCalledWith(root.id, expect.objectContaining({
      active: true,
      url: expect.stringContaining(`clf=${commandId}`)
    }));
    expect(worker.tabsReload).not.toHaveBeenCalled();
  });

  it('does not duplicate or reload an exact command root whose composer contains a draft', async () => {
    const commandId = 'de01c492cdde4054';
    const source = { id: 45, windowId: 9, index: 2, url: `https://chatgpt.com/c/${CHAT}` };
    const root = { id: 49, windowId: 9, index: 3, status: 'complete', active: false,
      url: `https://chatgpt.com/?clf=${commandId}&reasoning_effort=xhigh#clf=${commandId}` };
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({
        appOwnedOpeningTabs: { '49': { createdAt: Date.now(), marker: commandId } },
        tabDocuments: { '49': 'root-document' },
        tabEpochs: { '49': 0 }
      }),
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/compact' && init.method === 'POST') {
          return response(200, { stored: true, commandId, placement: { id: commandId } });
        }
        return response(404, {});
      },
      tabsQuery: async () => [source, root],
      tabsGet: async id => (id === root.id ? root : source) as never,
      tabsSendMessage: async (_id, message) => message.type === 'clf-tab-close-check'
        ? { safe: false, conversationId: null, navigationEpoch: 0 }
        : { ok: true }
    });
    await worker.registerTab(source.id);

    await worker.send(
      { type: 'compact', conversationId: CHAT, token: '0123456789abcdef0123456789abcdef', summary: 'the brief' },
      source.id
    );

    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).not.toHaveBeenCalledWith(root.id, expect.anything());
  });

  it('retargets one proven-empty resume root when main remints that logical resume with a new id', async () => {
    const ids = ['34d2e1c08bd217ac', 'de01c492cdde4054'];
    const source = { id: 45, windowId: 9, index: 2, url: `https://chatgpt.com/c/${CHAT}` };
    const tabs: Array<Record<string, any>> = [source];
    let reply = 0;
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/compact' && init.method === 'POST') {
          const id = ids[Math.min(reply++, ids.length - 1)];
          return response(200, { stored: true, commandId: id,
            placement: { id, active: true, homeConversationId: CHAT, project: null } });
        }
        return response(404, {});
      },
      tabsQuery: async () => tabs as never,
      tabsCreate: async properties => {
        const tab = { id: 99, windowId: 9, index: 3, status: 'complete', active: true,
          url: String(properties.url) };
        tabs.push(tab);
        return tab;
      },
      tabsGet: async id => tabs.find(tab => tab.id === id) as never,
      tabsUpdate: async (id, properties) => {
        const tab = tabs.find(candidate => candidate.id === id)!;
        Object.assign(tab, properties);
        return { ...tab };
      },
      tabsSendMessage: async (_id, message) => message.type === 'clf-tab-close-check'
        ? { safe: true, conversationId: null, navigationEpoch: 0 }
        : { ok: true }
    });
    await worker.registerTab(source.id);

    await worker.send(
      { type: 'compact', conversationId: CHAT, token: '0123456789abcdef0123456789abcdef', summary: 'first' },
      source.id
    );
    await worker.registerTab(99, 'root-document', String(tabs[1]!.url));
    await worker.send(
      { type: 'compact', conversationId: CHAT, token: '1123456789abcdef0123456789abcdef', summary: 'retry' },
      source.id
    );

    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
    expect(worker.tabsUpdate).toHaveBeenCalledWith(99, expect.objectContaining({
      url: expect.stringContaining(`clf=${ids[1]!}`), active: true
    }));
    expect(worker.tabsReload).not.toHaveBeenCalled();
  });

  it('leaves a compaction reply that places nothing to the app’s own opener', async () => {
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/compact' && init.method === 'POST') {
        // What an automatic pickup or a restart-restored resume answers with: there is no page
        // in flight to hand the successor to, so the app opened it the way it always did.
        return response(200, { stored: true, commandId: 'cmd-auto', placement: null });
      }
      return response(404, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      fetch,
      tabsGet: async () => ({ id: 46, windowId: 9, index: 0, url: `https://chatgpt.com/c/${CHAT}` }) as never
    });
    await worker.registerTab(46);
    await worker.send({ type: 'bind', conversationId: CHAT }, 46);

    await worker.send(
      { type: 'compact', conversationId: CHAT, token: '0123456789abcdef0123456789abcdef', summary: 'the brief' },
      46
    );

    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('refuses a settings write that names a different conversation than the source tab owns', async () => {
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      return response(200, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(43);
    await worker.send({ type: 'bind', conversationId: CHAT }, 43);
    const other = '11111111-2222-4333-8444-555555555555';

    expect(await worker.send({ type: 'settings_set', conversationId: other, autoCompact: true }, 43)).toMatchObject({
      ok: false,
      error: 'stale_conversation'
    });
    expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/settings')).toBe(false);
  });

  /**
   * The half of this route that no test covered: the replacement chat's own checkpoints.
   *
   * Every case above sends `conversationId` alongside the token, because every one of them is
   * the *source* chat — a conversation that exists. The destination is the opposite by
   * construction: content.js asks for its permit from a page opened at `/?clf=<id>`, before
   * ChatGPT has assigned anything, so it sends a token and a flag and no conversation id at
   * all. Nothing here ever exercised that shape, and it is the shape the whole handoff depends
   * on: refuse it and the page clears its composer and stops, with no ack and no log line
   * anywhere — which is exactly what a stuck handoff looks like from the outside.
   */
  /**
   * The replacement chat asks for its permit while ChatGPT is still loading.
   *
   * Measured in the browser on 2026-09-10: the tab redeemed at 04:39:55.218 and got the whole
   * 48,975-character brief, then asked for `destinationAttempt` at 04:39:58.262 — three seconds
   * into a freshly opened ChatGPT, which is still `loading`. The worker refused it as a stale
   * document without ever calling the app, content.js read that as a denied permit, cleared the
   * composer and returned without an ack. The app then waited out its whole deadline and gave up
   * with "the chat this app opened did not report back in time", and nothing anywhere said why.
   *
   * The loading/pendingUrl guard is for a tab navigating *away* from what the message names. A
   * checkpoint that names no conversation, from a document the worker still owns, is the
   * opposite case: there is nothing to navigate away from yet.
   */
  it.each(['loading', 'pending'])('forwards a replacement chat permit while the tab is still %s', async state => {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/compact' && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body || '{}')));
        return response(200, { allowed: true });
      }
      return response(404, {});
    });
    const tab = state === 'loading'
      ? { id: 47, url: 'https://chatgpt.com/?clf=cmd-successor', status: 'loading' }
      : { id: 47, url: 'https://chatgpt.com/?clf=cmd-successor', pendingUrl: 'https://chatgpt.com/?clf=cmd-successor' };
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsGet: async () => tab });
    await worker.registerTab(47);
    const token = '0123456789abcdef0123456789abcdef';

    const commandId = 'cmd-successor', client = 'run-successor-document';
    const reply = await worker.send({ type: 'compact', token, commandId, client, destinationAttempt: true }, 47);

    expect(reply).not.toMatchObject({ error: 'stale_document' });
    expect(posted).toEqual([expect.objectContaining({ token, commandId, client, destinationAttempt: true })]);
  });

  it('forwards the destination checkpoints a replacement chat sends, which name no conversation', async () => {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/compact' && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body || '{}')));
        return response(200, { allowed: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsGet: async () => ({ id: 46, url: 'https://chatgpt.com/?clf=cmd-successor' }) });
    await worker.registerTab(46);
    const token = '0123456789abcdef0123456789abcdef';

    const commandId = 'cmd-successor', client = 'run-successor-document';
    await worker.send({ type: 'compact', token, commandId, client, destinationAttempt: true }, 46);
    await worker.send({ type: 'compact', token, commandId, client, destinationDispatch: true }, 46);
    await worker.send({ type: 'compact', token, commandId, client, destinationLost: true }, 46);

    expect(posted).toEqual([
      expect.objectContaining({ token, commandId, client, destinationAttempt: true }),
      expect.objectContaining({ token, commandId, client, destinationDispatch: true }),
      expect.objectContaining({ token, commandId, client, destinationLost: true })
    ]);
  });

  it.each(['conversation', 'pending-conversation', 'pending-foreign'])('refuses a replacement permit on a %s route', async state => {
    const fetch = vi.fn(async (input: string) => new URL(input).pathname === '/hello'
      ? response(200, { app: 'chat-on-steroids', paired: true }) : response(200, { allowed: true }));
    const home = 'https://chatgpt.com/?clf=cmd-successor';
    const chat = `https://chatgpt.com/c/${CHAT}`;
    const tab = { id: 48, url: state === 'conversation' ? chat : home,
      ...(state === 'pending-conversation' ? { pendingUrl: chat } : {}),
      ...(state === 'pending-foreign' ? { pendingUrl: 'https://example.com/' } : {}) };
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsGet: async () => tab });
    await worker.registerTab(48);
    expect(await worker.send({ type: 'compact', token: '0123456789abcdef0123456789abcdef',
      commandId: 'cmd-successor', client: 'run-successor-document', destinationAttempt: true }, 48))
      .toMatchObject({ ok: false, error: 'stale_document' });
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/compact')).toBe(false);
  });


  /**
   * The mode a goal was written in, which the app turns into a durable per-chat switch.
   *
   * Both halves matter. It has to cross — a goal written with "add specific loop" that arrives
   * without its mode is answered by the standing switch, which is how an unattended run meant
   * to be endless stopped at its second turn. And only these two words may cross, because what
   * arrives here is written to disk and then decides whether a run is allowed to end at all.
   */
  it('passes the goal mode through, and only ever the two words that are modes', async () => {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/goal/objective') {
        posted.push(JSON.parse(String(init.body || '{}')));
        return response(200, { objective: 'build the sandbox', enabled: true, mode: 'loop' });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(44);
    await worker.send({ type: 'bind', conversationId: CHAT }, 44);

    const looped = await worker.send(
      { type: 'goal_objective', conversationId: CHAT, text: 'build the sandbox', mode: 'loop' },
      44
    );
    expect(looped).toMatchObject({ ok: true, data: { enabled: true, mode: 'loop' } });
    expect(posted.at(-1)).toEqual({ conversationId: CHAT, text: 'build the sandbox', mode: 'loop' });

    // Anything else is absent rather than forwarded, which leaves the standing switch deciding
    // exactly as it did before the two buttons existed — a state the app already handles.
    await worker.send({ type: 'goal_objective', conversationId: CHAT, text: 'build the sandbox', mode: 'endless' }, 44);
    expect(posted.at(-1)).toEqual({ conversationId: CHAT, text: 'build the sandbox' });

    await worker.send({ type: 'goal_objective', conversationId: CHAT, text: 'build the sandbox' }, 44);
    expect(posted.at(-1)).toEqual({ conversationId: CHAT, text: 'build the sandbox' });
  });
});

// ------------------------------------------------------------ command delivery

/**
 * The half of delivery that lives in the browser.
 *
 * The app opens the marked chat itself, so what is tested here is what the extension
 * does with a marker once a page has it, and the recovery path for commands the app
 * could not open — which is the only thing that runs while no ChatGPT page exists.
 */
describe('extension command delivery', () => {
  const paired = { port: 8765, token: 'paired-token' };

  it('redeems only the command id the page was opened for', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/redeem') {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (body.id !== 'cmd-1') return response(404, { error: 'gone' });
        return response(200, { command: { id: 'cmd-1', kind: 'open-chat', text: 'do the thing', agent: null } });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const mine = await worker.send({ type: 'redeem', id: 'cmd-1', client: 'page-1' });
    expect(mine).toMatchObject({ ok: true, command: { id: 'cmd-1', text: 'do the thing' } });

    // A marker for a command that has been cancelled, superseded or already sent gets
    // nothing, so a stale URL in history types nothing into a chat.
    const stale = await worker.send({ type: 'redeem', id: 'cmd-gone', client: 'page-1' });
    expect(stale).toMatchObject({ ok: true, command: null, gone: true });
    // The page identifies itself, because a command belongs to one page: a second tab on
    // the same marker is a different claimant and the app refuses it.
    expect(bodies).toHaveLength(2);
    expect(bodies.map(({ tabLease: _tabLease, ...body }) => body)).toEqual([
      { id: 'cmd-1', client: 'page-1' },
      { id: 'cmd-gone', client: 'page-1' }
    ]);
    expect(bodies[0]?.tabLease).toMatch(/^[a-f0-9]{32}_[a-f0-9-]{36}$/);
    expect(bodies[1]?.tabLease).toBe(bodies[0]?.tabLease);
  });

  it('keeps one tab lease across document and extension reloads, but rotates it on browser restart', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const leases: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const route = new URL(input).pathname;
      if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (route === '/commands/redeem') {
        leases.push(JSON.parse(String(init.body)).tabLease);
        return response(200, { command: null });
      }
      if (route === '/status') return response(200, { repairs: [], openConversationRequests: [] });
      return response(404, {});
    });

    const first = loadWorker({ local, session, fetch });
    await first.send({ type: 'redeem', id: 'cmd-a', client: 'document-a' }, 7);
    await first.send({ type: 'redeem', id: 'cmd-b', client: 'document-a' }, 7);
    await first.send({ type: 'redeem', id: 'cmd-c', client: 'document-c' }, 8);
    expect(leases[1]).toBe(leases[0]);
    expect(leases[2]).not.toBe(leases[0]);
    expect(String(leases[2]).slice(0, 32)).toBe(String(leases[0]).slice(0, 32));

    // A service-worker/extension reload retains local tab custody.
    const reloaded = loadWorker({ local, session, fetch });
    await reloaded.send({ type: 'redeem', id: 'cmd-d', client: 'document-d' }, 7);
    expect(leases[3]).toBe(leases[0]);

    // A whole browser restart destroys the old documents and rotates the generation. Main can
    // recover an untouched Resume from this proof while still rejecting another tab above.
    await reloaded.startBrowser();
    await reloaded.send({ type: 'redeem', id: 'cmd-e', client: 'document-e' }, 7);
    expect(leases[4]).not.toBe(leases[0]);
    expect(String(leases[4]).slice(0, 32)).not.toBe(String(leases[0]).slice(0, 32));
  });

  it.each(['safe', 'draft', 'different-marker', 'pinned'])('retires only the exact empty stale command page: %s', async scenario => {
    const id = 'cmd-stale-root';
    const tab = {
      id: 42,
      url: `https://chatgpt.com/?clf=${scenario === 'different-marker' ? 'somebody-else' : id}#clf=${id}`,
      pinned: scenario === 'pinned'
    };
    if (scenario === 'different-marker') tab.url = 'https://chatgpt.com/?clf=somebody-else#clf=somebody-else';
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/redeem') return response(404, { error: 'no_such_command' });
      return response(404, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      fetch,
      tabsQuery: async () => [tab, { id: 99, windowId: 8, url: 'https://example.com/' }],
      tabsGet: async () => tab,
      tabsSendMessage: async (_tabId, message) => message.type === 'clf-tab-close-check'
        ? { safe: scenario !== 'draft', conversationId: null, navigationEpoch: 0 }
        : { ok: true }
    });
    await worker.registerTab(42);

    expect(await worker.send({ type: 'redeem', id, client: 'page-stale' }, 42)).toMatchObject({
      ok: true,
      command: null,
      gone: true
    });
    const retired = await worker.send({ type: 'retire_stale_command', id }, 42);

    expect(retired).toMatchObject({ ok: true, closed: scenario === 'safe' });
    expect(worker.tabsRemove).toHaveBeenCalledTimes(scenario === 'safe' ? 1 : 0);
  });

  it('never redeems a command this browser already delivered', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea({ settled: ['cmd-done'] });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      return response(200, { command: { id: 'cmd-done', text: 'again?' } });
    });
    const worker = loadWorker({ local, session, fetch });

    expect(await worker.send({ type: 'redeem', id: 'cmd-done' })).toMatchObject({ ok: true, command: null });
    expect(fetch.mock.calls.some(([input]) => String(input).includes('/commands/redeem'))).toBe(false);
  });

  /**
   * The extension does not go looking for work, and cannot open a chat of its own accord.
   *
   * This replaces the whole recovery-alarm path. A command used to be a thing the browser
   * fetched: a half-minute `chrome.alarms` tick pulled `GET /commands`, opened a marked tab
   * per unopened command, and persisted an `opened` list so a restarted service worker would
   * not open a second chat for the same job. Every part of that could act on a run the app
   * had already finished with, and every part of it was a clock. The app opens the chat now,
   * in the same transaction that creates the command, so the extension has nothing to poll
   * and nothing to remember. The only alarm now is a delivery retry for observations and
   * close notices already accepted into durable session storage; it never discovers work
   * and never opens a tab.
   */
  it('opens no tabs and holds no alarm of its own', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    // Starting up is not a reason to open anything, and neither is asking how things are.
    await worker.send({ type: 'status' });
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
    expect(session.data.opened).toBeUndefined();

    // There is no listing route left to ask, so nothing here ever asks for one.
    expect(fetch.mock.calls.every(([input]) => new URL(String(input)).pathname !== '/commands')).toBe(true);
    expect(backgroundSource).toContain("const RETRY_ALARM = 'clf-bridge-drain'");
    expect(backgroundSource).not.toContain("call('/commands'");
  });

  it('projects the app attention command ids into the content status reply', async () => {
    const commandId = 'cmd-exact-attention-owner';
    let attention: unknown[] = [commandId, commandId, '', 42];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/status') return response(200, {
        browserAttentionCommandIds: attention,
        repairs: [],
        openConversationRequests: []
      });
      return response(404, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      fetch
    });

    await worker.fireAlarm();
    expect(await worker.send({ type: 'status' })).toMatchObject({
      browserAttentionCommandIds: [commandId]
    });

    attention = [];
    await worker.fireAlarm();
    expect(await worker.send({ type: 'status' })).toMatchObject({
      browserAttentionCommandIds: []
    });
  });

  it('rearms one exact app-owned empty root when ChatGPT strips its attention marker', async () => {
    const commandId = '4e689b755134a55a';
    const tab = {
      id: 42,
      windowId: 7,
      url: 'https://chatgpt.com/?reasoning_effort=xhigh',
      status: 'complete',
      active: false,
      pinned: false,
      autoDiscardable: false
    };
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea({
      appOwnedOpeningTabs: {
        '42': { createdAt: Date.now(), marker: commandId }
      },
      tabDocuments: { '42': 'document-42-0' },
      tabEpochs: { '42': 0 }
    });
    const worker = loadWorker({
      local,
      session,
      tabsQuery: async () => [tab],
      tabsGet: async () => ({ ...tab }),
      tabsSendMessage: async (_tabId, message) => message.type === 'clf-tab-close-check'
        ? { safe: true, conversationId: null, navigationEpoch: 0 }
        : { ok: true },
      fetch: async input => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/status') return response(200, {
          browserCommandIds: [commandId],
          browserAttentionCommandIds: [commandId],
          repairs: [],
          openConversationRequests: []
        });
        return response(200, { ok: true });
      }
    });

    await worker.fireAlarm();

    const retarget = worker.tabsUpdate.mock.calls.find(([, update]) => typeof update.url === 'string');
    expect(retarget?.[0]).toBe(42);
    expect(new URL(String(retarget?.[1].url)).searchParams.get('clf')).toBe(commandId);
    expect(new URL(String(retarget?.[1].url)).searchParams.get('reasoning_effort')).toBe('xhigh');
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('re-injects the recorder into already-open ChatGPT tabs after an extension reload', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session,
      tabsSendMessage: async () => { throw new Error('Receiving end does not exist'); } });
    worker.tabsQuery.mockResolvedValueOnce([{ id: 41 }, { id: 42 }]);

    await worker.installed('update');

    expect(worker.tabsQuery).toHaveBeenCalledWith({
      url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
    });
    expect(worker.scriptingExecuteScript.mock.calls).toEqual([
      [{ target: { tabId: 41 }, world: 'MAIN', files: ['fiber.js'] }],
      [{ target: { tabId: 41 }, files: ['chatgpt-dom.js', 'content.js'] }],
      [{ target: { tabId: 42 }, world: 'MAIN', files: ['fiber.js'] }],
      [{ target: { tabId: 42 }, files: ['chatgpt-dom.js', 'content.js'] }]
    ]);
    expect(worker.scriptingInsertCSS.mock.calls).toEqual([
      [{ target: { tabId: 41 }, files: ['overlay.css'] }],
      [{ target: { tabId: 42 }, files: ['overlay.css'] }]
    ]);
  });

  it('recovers across a navigation between script calls without starting a recorder without its adapter', async () => {
    const start = backgroundSource.indexOf('async function restoreChatgptTab(id) {');
    const end = backgroundSource.indexOf('\nconst USAGE_REPLACE_RETRY_MS', start);
    let document = 0, adapterDocument = -1, recorderDocument = -1;
    const restore = vm.runInNewContext(`${backgroundSource.slice(start, end)}; restoreChatgptTab`, {
      PAGE_RECORDER_VERSION: currentRecorderVersion,
      tabReply: async () => { throw new Error('Missing receiver'); },
      chrome: { scripting: {
        executeScript: async ({ files }: { files: string[] }) => {
          for (const file of files) {
            if (file === 'chatgpt-dom.js') adapterDocument = document;
            if (file === 'content.js') {
              if (adapterDocument !== document) throw new ReferenceError('CLF_DOM is not defined');
              recorderDocument = document;
            }
          }
          // Native navigation can retire the isolated world after an awaited call.
          if (files.includes('chatgpt-dom.js') && !files.includes('content.js')) document++;
        }, insertCSS: async () => undefined
      } }
    }) as (id: number) => Promise<boolean>;
    expect(await restore(41)).toBe(true);
    expect(recorderDocument).toBe(adapterDocument);
    expect(recorderDocument).toBeGreaterThanOrEqual(0);
  });

  it.each(['reload', 'pause-during-page', 'error-during-page'] as const)(
    'runs marked-helper preclaim recovery through the whole worker and current Main policy (%s)', async mode => {
      const id = '4d170da1-47c3-49c6-860b-61d29ec78112', generation = 'a'.repeat(32);
      const expiresAt = Date.now() + 60_000;
      const tab = { id: 41, windowId: 7, status: 'complete', active: false, pinned: false,
        url: 'https://chatgpt.com/?temporary-chat=true&cos-input=' + id + '#cos-input=' + id };
      const local = new FakeStorageArea({ port: 8765, token: 'paired-token', instanceId: 'profile-one',
        commandLeaseGeneration: generation, inputOpenings: { [id]: { tab: 41, stage: 'ready', browserGeneration: generation } } });
      let pages = 0, inspections = 0, hold = false, release: (()=>void) | undefined;
      const session = new FakeStorageArea();
      const worker = loadWorker({ local, session,
        tabsQuery: async () => [tab], tabsGet: async () => tab,
        fetch: async (input, init) => {
          const pathname = new URL(input).pathname;
          if (pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true, instanceId: 'profile-one' });
          if (pathname === '/status') return response(200, { ok: true, repairs: [], automationPaused: hold,
            inputOpeningIds: [id], inputs: hold ? [] : [{ id, conversationId: null, lifetime: 'temporary-planner', preclaimRecovery: { expiresAt } }] });
          if (pathname === '/input/output') {
            expect(JSON.parse(String(init?.body))).toMatchObject({ id, conversationId: null, inspectPreclaim: true });
            inspections++;
            return response(200, { ok: true, preclaimRecovery: { expiresAt } });
          }
          if (pathname === '/settings') return mode === 'error-during-page'
            ? response(423, { error: 'core_disconnected' }) : response(200, { ui: { automationPaused: hold } });
          return response(200, { ok: true });
        },
        tabsSendMessage: async (_tab, message) => {
          if (message.type === 'clf-desktop-input') return { ok: false };
          if (message.type === 'clf-recorder-ping') return { ok: true, recorderVersion: currentRecorderVersion, freshTurnProtocol: 1, requiredFeatures: { promptEnvelope: true, nativeAllowOnce: true } };
          if (message.type === 'clf-page-status') {
            if (message.preclaimInputId) {
              pages++;
              if (pages === 2 && mode !== 'reload') await new Promise<void>(resolve => { release = resolve; });
            }
            return { ok: true, epoch: 0, authState: 'signed-in', streaming: false, generating: false, pendingTools: 0,
              jobBusy: false, goalBusy: false, projectCreateBusy: false, pluginRefreshBusy: false, modelCatalogBusy: false, desktopInputBusy: false,
              ...(message.preclaimInputId ? { temporaryInputPreclaim: { id, safe: true, url: tab.url, progressRevision: 0, stopRevision: 0 } } : {}) };
          }
          return { safe: false };
        }
      });
      await worker.registerTab(41);
      await worker.fireAlarm();
      if (mode !== 'reload') {
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        hold = true;
        await worker.send({ type: 'settings_get' }, 41);
        release!();
        await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => setTimeout(resolve, 0));
      } else await vi.waitFor(() => expect(worker.tabsReload, JSON.stringify({ inspections, pages,
        messages: worker.tabsSendMessage.mock.calls.map(([, message]) => ({ type: message.type, proof: message.preclaimRecovery })), docs: session.data.tabDocuments, epochs: session.data.tabEpochs, opening: (local.data.inputOpenings as any)?.[id],
        instance: local.data.instanceId, generation: local.data.commandLeaseGeneration })).toHaveBeenCalledExactlyOnceWith(41));
      expect(inspections).toBe(2);
      expect(worker.tabsReload).toHaveBeenCalledTimes(mode === 'reload' ? 1 : 0);
      expect((local.data.inputOpenings as Record<string, any>)[id]).toMatchObject({ tab: 41, stage: 'ready', preclaimReloaded: true });
      await worker.fireAlarm();
      expect(worker.tabsReload).toHaveBeenCalledTimes(mode === 'reload' ? 1 : 0);
      expect(worker.tabsCreate).not.toHaveBeenCalled();
    });

  it.each([true, false])('preserves Main preclaim proof through the existing elected-helper delivery (%s)', async capability => {
    const start = backgroundSource.indexOf('async function deliverDesktopInputs(');
    const end = backgroundSource.indexOf('\n// A read-only catalog', start);
    const id = '4d170da1-47c3-49c6-860b-61d29ec78112';
    const proof = { expiresAt: Date.now() + 60000 };
    const tab = { id: 41, url: 'https://chatgpt.com/?temporary-chat=true&cos-input=' + id + '#cos-input=' + id };
    const offer = vi.fn();
    const deliver = vm.runInNewContext(backgroundSource.slice(start, end) + '; deliverDesktopInputs', {
      URL, Date, commandAckOutbox: [], inputOpenings: { [id]: { tab: 41, stage: 'ready', browserGeneration: 'browser-one' } },
      commandLeaseGeneration: 'browser-one', CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
      cleanConversationId: () => null, commandOwnedOpeningTab: () => false,
      chrome: { tabs: { query: async () => [tab] } },
      offerDesktopInput: offer, cleanupRetiredInputTabs: async () => undefined
    });
    expect(await deliver([{ id, conversationId: null, lifetime: 'temporary-planner',
      ...(capability ? { preclaimRecovery: proof } : {}) }], true, [], undefined, 0)).toBe(0);
    expect(offer).toHaveBeenCalledExactlyOnceWith(41, { type: 'clf-desktop-input', id, conversationId: null,
      lifetime: 'temporary-planner', ...(capability ? { preclaimRecovery: proof } : {}) }, false);
  });

  it.each(['once', 'main-refused', 'missing-proof', 'busy', 'foreign-marker', 'foreign-election', 'expired', 'unpaired',
    'paused-final', 'claimed-final', 'draft-final', 'document-final', 'activity-final', 'deadline-final', 'restart', 'inflight', 'old-main', 'http-error', 'page-unknown', 'old-page', 'election-final', 'deadline-mismatch', 'connection-final', 'pin-final', 'loading-final', 'url-final', 'page-epoch', 'persist-failure', 'flag-final', 'ordinary-null', 'history-final', 'instance-final', 'disconnect-final', 'token-final', 'browser-final'] as const)(
    'reloads only one exact never-claimed Temporary helper under its original deadline (%s)', async mode => {
      const start = backgroundSource.indexOf('const desktopInputReceiverRepairs = new Map();');
      const end = backgroundSource.indexOf('\nasync function deliverDesktopInputs(', start);
      const id = '4d170da1-47c3-49c6-860b-61d29ec78112';
      let now = 1000, mainReads = 0, pageReads = 0, tabReads = 0;
      const expiresAt = 60000;
      const tab = { id: 41, status: 'complete', pinned: false,
        url: 'https://chatgpt.com/?temporary-chat=true&cos-input=' + id + '#cos-input=' + id };
      if (mode === 'foreign-marker') tab.url = tab.url.replaceAll(id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
      const opening = { tab: mode === 'foreign-election' ? 42 : 41, stage: 'ready', browserGeneration: 'browser-one' };
      const elections: Record<string, any> = { [id]: opening };
      let persisted = false, release: (()=>void) | undefined;
      const persist = vi.fn(async () => {
        persisted = elections[id].preclaimReloaded === true;
        if (mode === 'deadline-final') now = expiresAt;
        if (mode === 'election-final') elections[id] = { ...elections[id], tab: 42 };
        if (mode === 'connection-final') context.connectionEpoch++;
        if (mode === 'history-final') context.unassignedHistoryUncertain = true;
        if (mode === 'instance-final') context.instanceId = 'foreign-profile';
        if (mode === 'disconnect-final') context.disconnected = true;
        if (mode === 'token-final') context.token = 'foreign-token';
        if (mode === 'browser-final') context.browserId = 'foreign-browser';
        if (mode === 'flag-final') elections[id].preclaimReloaded = false;
        if (mode === 'persist-failure') throw new Error('fixture storage refused');
        if (mode === 'inflight') await new Promise<void>(resolve => { release = resolve; });
      });
      const send = vi.fn(async () => ({ ok: false }));
      const reload = vi.fn(async () => { expect(persisted).toBe(true); });
      const context: Record<string, any> = {
        URL, URLSearchParams, Date: { now: () => now }, console: { info: vi.fn(), warn: vi.fn() },
        inputOpenings: elections, commandLeaseGeneration: 'browser-one',
        tabDocuments: { '41': 'document-one' }, tabEpochs: { '41': 3 },
        token: mode === 'unpaired' ? null : 'paired-token', port: 8765, instanceId: 'profile-one',
        browserId: 'browser-one', disconnected: false, pairing: false, unassignedHistoryGeneration: 0, unassignedHistoryUncertain: false,
        unassignedHistoryConversation: () => false, connectionEpoch: 1, persistLive: persist,
        ownsDocument: (source: any) => source.documentId === context.tabDocuments['41'] && source.navigationEpoch === context.tabEpochs['41'],
        restoreChatgptTab: vi.fn(async () => true),
        call: vi.fn(async () => {
          mainReads++;
          if (mode === 'old-main') return { ok: true, data: { ok: false } };
          if (mode === 'http-error') return { ok: false, data: {} };
          return { ok: true, data: { ok: true, preclaimRecovery:
            mode === 'main-refused' || (mode === 'claimed-final' && mainReads > 1) || (mode === 'paused-final' && mainReads > 1)
              ? null : { expiresAt: expiresAt + (mode === 'deadline-mismatch' ? 1 : 0) } } };
        }),
        tabReply: vi.fn(async () => {
          pageReads++;
          if (mode === 'page-unknown') return undefined;
          if (mode === 'old-page') return { ok: true, epoch: 3 };
          if (mode === 'document-final' && pageReads > 1) context.tabDocuments['41'] = 'replacement-document';
          return { ok: true, epoch: mode === 'page-epoch' ? 4 : 3, temporaryInputPreclaim: { id, url: tab.url, safe: mode !== 'busy' && !(mode === 'draft-final' && pageReads > 1),
            progressRevision: mode === 'activity-final' && pageReads > 1 ? 1 : 0, stopRevision: 0 } };
        }),
        chrome: { tabs: { get: vi.fn(async () => {
          tabReads++;
          return { ...tab, ...(tabReads > 1 && mode === 'pin-final' ? { pinned: true } : {}),
            ...(tabReads > 1 && mode === 'loading-final' ? { pendingUrl: tab.url } : {}),
            ...(tabReads > 1 && mode === 'url-final' ? { url: 'https://chatgpt.com/' } : {}) };
        }), sendMessage: send, reload } }
      };
      const admissionStart = backgroundSource.indexOf('function conversationAdmission(');
      const admissionEnd = backgroundSource.indexOf('\nfunction conversationAdmissionRefusal(', admissionStart);
      const load = () => vm.runInNewContext('(() => {' + backgroundSource.slice(admissionStart, admissionEnd) + backgroundSource.slice(start, end) + '; return {offer: offerDesktopInput, repairs: desktopInputReceiverRepairs}; })()', context);
      let owner = load();
      const message = { type: 'clf-desktop-input', id, conversationId: null,
        ...(mode === 'ordinary-null' ? {} : { lifetime: 'temporary-planner' }),
        ...(mode === 'missing-proof' ? {} : { preclaimRecovery: { expiresAt } }) };
      if (mode === 'expired') now = expiresAt;
      owner.offer(41, message);
      if (mode === 'inflight') {
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        owner.offer(41, message);
        await Promise.resolve(); expect(send).toHaveBeenCalledTimes(1);
        release!();
      }
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledTimes(1);
        expect(owner.repairs.size).toBe(0);
        if (['once', 'restart', 'inflight'].includes(mode)) expect(reload).toHaveBeenCalledTimes(1);
      });
      if (['once', 'restart', 'inflight'].includes(mode)) {
        if (mode === 'restart') owner = load();
        owner.offer(41, message);
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
        await Promise.resolve(); await Promise.resolve();
        expect(reload).toHaveBeenCalledExactlyOnceWith(41);
        expect(elections[id]).toMatchObject({ tab: 41, stage: 'ready', preclaimReloaded: true });
      } else expect(reload).not.toHaveBeenCalled();
    });

  it.each(['accepted', 'refused', 'disconnected'] as const)(
    'repairs a pre-claim DOM adapter refusal through the existing receiver owner once (%s)', async outcome => {
      const start = backgroundSource.indexOf('function offerDesktopInput(');
      const end = backgroundSource.indexOf('\nasync function deliverDesktopInputs(', start);
      const message = { type: 'clf-desktop-input', id: '4d170da1-47c3-49c6-860b-61d29ec78112',
        conversationId: null, lifetime: 'temporary-planner' };
      const send = vi.fn().mockResolvedValueOnce({ ok: false, error: 'dom_adapter_unready' });
      if (outcome === 'disconnected') send.mockRejectedValueOnce(new Error('synthetic disconnected receiver'));
      else send.mockResolvedValueOnce(outcome === 'accepted' ? { ok: true } : { ok: false, error: 'dom_adapter_unready' });
      const repair = vi.fn(async () => true);
      const offer = vm.runInNewContext(`${backgroundSource.slice(start, end)}; offerDesktopInput`, {
        chrome: { tabs: { sendMessage: send } }, repairDesktopInputReceiver: repair, desktopInputReceiverRepairs: new Map(),
        console: { info: vi.fn() }
      }) as (tab: number, input: typeof message) => void;

      offer(41, message);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(repair).toHaveBeenCalledExactlyOnceWith(41);
      expect(send.mock.calls).toEqual([[41, message], [41, message]]);
      await Promise.resolve();
      expect(send).toHaveBeenCalledTimes(2);
    });

  it.each([true, false])('does not reoffer a DOM refusal when repair is held, or reinterpret another refusal (adapter=%s)', async adapter => {
    const start = backgroundSource.indexOf('function offerDesktopInput(');
    const end = backgroundSource.indexOf('\nasync function deliverDesktopInputs(', start);
    const send = vi.fn(async () => ({ ok: false, error: adapter ? 'dom_adapter_unready' : 'input_not_pending' }));
    const repair = vi.fn(async () => false);
    const offer = vm.runInNewContext(`${backgroundSource.slice(start, end)}; offerDesktopInput`, {
      chrome: { tabs: { sendMessage: send } }, repairDesktopInputReceiver: repair, desktopInputReceiverRepairs: new Map(),
      console: { info: vi.fn() }
    }) as (tab: number, input: Record<string, unknown>) => void;
    offer(41, { type: 'clf-desktop-input', id: '4d170da1-47c3-49c6-860b-61d29ec78112' });
    if (adapter) await vi.waitFor(() => expect(repair).toHaveBeenCalledExactlyOnceWith(41));
    else { await Promise.resolve(); await Promise.resolve(); expect(repair).not.toHaveBeenCalled(); }
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps a live recorder but revalidates the idempotent MAIN-world Fiber helper', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    worker.tabsQuery.mockResolvedValueOnce([{ id: 41 }]);
    worker.tabsSendMessage.mockResolvedValueOnce({ ok: true, recorderVersion: currentRecorderVersion, freshTurnProtocol: 1, requiredFeatures: { promptEnvelope: true, nativeAllowOnce: true } });

    await worker.installed('update');

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(41, { type: 'clf-recorder-ping' }, undefined);
    expect(worker.scriptingExecuteScript.mock.calls).toEqual([
      [{ target: { tabId: 41 }, world: 'MAIN', files: ['fiber.js'] }]
    ]);
    expect(worker.scriptingInsertCSS).not.toHaveBeenCalled();
  });

  it.each([48, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 83, 84])('reinjects the healthy revision %s predecessor to publish current continuation evidence', async revision => {
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea() });
    worker.tabsQuery.mockResolvedValueOnce([{ id: 41 }]);
    worker.tabsSendMessage.mockResolvedValueOnce({ ok: true, recorderVersion: revision, freshTurnProtocol: 1, requiredFeatures: { promptEnvelope: true, nativeAllowOnce: true } });
    worker.tabsSendMessage.mockResolvedValueOnce({ ok: true, streaming: false, generating: false, pendingTools: 0,
      jobBusy: false, goalBusy: false, projectCreateBusy: false, pluginRefreshBusy: false,
      modelCatalogBusy: false, desktopInputBusy: false });

    await worker.installed('update');

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(41, { type: 'clf-recorder-ping' }, undefined);
    expect(worker.scriptingExecuteScript.mock.calls).toEqual([
      [{ target: { tabId: 41 }, world: 'MAIN', files: ['fiber.js'] }],
      [{ target: { tabId: 41 }, files: ['chatgpt-dom.js', 'content.js'] }]
    ]);
    expect(worker.scriptingInsertCSS.mock.calls).toEqual([
      [{ target: { tabId: 41 }, files: ['overlay.css'] }]
    ]);
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it.each([52, 54, 55, 56, 61, 64].flatMap(revision =>
    (['generating', 'pendingTools', 'desktopInputBusy'] as const).map(veto => ({ revision, veto }))))(
    'retains revision $revision custody while $veto blocks recorder replacement', async ({ revision, veto }) => {
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea() });
    worker.tabsQuery.mockResolvedValueOnce([{ id: 41 }]);
    worker.tabsSendMessage.mockResolvedValueOnce({ ok: true, recorderVersion: revision, freshTurnProtocol: 1, requiredFeatures: { promptEnvelope: true, nativeAllowOnce: true } });
    worker.tabsSendMessage.mockResolvedValueOnce({ ok: true, streaming: false, generating: false, pendingTools: 0,
      jobBusy: false, goalBusy: false, projectCreateBusy: false, pluginRefreshBusy: false,
      modelCatalogBusy: false, desktopInputBusy: false, [veto]: veto === 'pendingTools' ? 1 : true });

    await worker.installed('update');

    expect(worker.scriptingExecuteScript.mock.calls.some(([spec]) => spec.files?.includes('content.js'))).toBe(false);
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('repairs a missing MAIN-world Fiber helper on demand for the sending tab only', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });

    const repaired = await worker.send({ type: 'repair_fiber' }, 73);

    expect(repaired).toMatchObject({ ok: true });
    expect(worker.scriptingExecuteScript).toHaveBeenCalledWith({
      target: { tabId: 73, documentIds: ['document-73-0'] },
      world: 'MAIN',
      files: ['fiber.js']
    });

    await worker.navigateTab(73, 'https://example.com/left');
    expect(await worker.send({ type: 'repair_fiber' }, 73)).toMatchObject({ ok: false, error: 'tab_closed' });
  });

  it.each(['exact', 'SPA original route', 'foreign account', 'foreign conversation', 'unpaired', 'injection failure', 'route race', 'pairing race'] as const)
  ('bounds an explicit same-document Fiber refresh without replacing companion custody: %s', async mode => {
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const other = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const instanceId = 'profile-fiber-refresh';
    let url = `https://chatgpt.com/c/${conversationId}`;
    const retained = [{ conversationId, event: { kind: 'progress', time: 1, text: 'Retained original observation' } }];
    const local = new FakeStorageArea({ ...paired, instanceId, ...(mode === 'unpaired' ? { token: null } : {}) });
    const session = new FakeStorageArea({ tabConversations: { '73': conversationId }, journal: retained });
    const worker = loadWorker({ local, session, tabsGet: async () => ({ id: 73, url, status: 'complete' }) });
    await worker.registerTab(73);
    worker.scriptingExecuteScript.mockImplementationOnce(async () => {
      if (mode === 'injection failure') throw new Error('PRIVATE injection details');
      if (mode === 'route race') url = `https://chatgpt.com/c/${other}`;
      if (mode === 'pairing race') await worker.send({ type: 'unpair' });
      return [];
    });
    const reply = await worker.send({ type: 'repair_fiber', operatorRefresh: true,
      conversationId: mode === 'foreign conversation' ? other : conversationId,
      instanceId: mode === 'foreign account' ? 'profile-foreign' : instanceId, navigationEpoch: 0 }, 73, undefined,
      mode === 'SPA original route' ? 'https://chatgpt.com/' : url);
    const errors = { 'foreign account': 'account_changed', 'foreign conversation': 'conversation_changed',
      unpaired: 'not_paired', 'injection failure': 'fiber_repair_failed',
      'route race': 'conversation_changed', 'pairing race': 'account_changed' };
    expect(reply).toEqual(mode === 'exact' || mode === 'SPA original route'
      ? { ok: true, refreshed: true } : { ok: false, error: errors[mode] });
    expect(worker.scriptingExecuteScript).toHaveBeenCalledTimes(
      ['foreign account', 'foreign conversation', 'unpaired'].includes(mode) ? 0 : 1);
    expect(journalOf(session)).toEqual(retained);
    expect(worker.tabsReload).not.toHaveBeenCalled(); expect(worker.runtimeReload).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).not.toHaveBeenCalled(); expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(reply)).not.toContain('PRIVATE');
  });

  it('rejects an explicit Fiber refresh from an already superseded document or navigation', async () => {
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const instanceId = 'profile-fiber-refresh';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const worker = loadWorker({ local: new FakeStorageArea({ ...paired, instanceId }),
      session: new FakeStorageArea({ tabConversations: { '73': conversationId } }),
      tabsGet: async () => ({ id: 73, url, status: 'complete' }) });
    await worker.registerTab(73, 'old-document');
    await worker.registerTab(73, 'new-document');
    const packet = { type: 'repair_fiber', operatorRefresh: true, conversationId, instanceId, navigationEpoch: 0 };
    expect(await worker.send(packet, 73, 'old-document', url)).toMatchObject({ ok: false, error: 'stale_document' });
    expect(await worker.send({ type: 'repair_fiber', navigationEpoch: 1 }, 73, 'new-document', url)).toMatchObject({ ok: true });
    worker.scriptingExecuteScript.mockClear();
    expect(await worker.send(packet, 73, 'new-document', url)).toMatchObject({ ok: false, error: 'stale_navigation' });
    expect(worker.scriptingExecuteScript).not.toHaveBeenCalled();
  });

  it.each(['document replaced', 'epoch changed', 'pending navigation', 'account changed before injection'] as const)
  ('rechecks an explicit Fiber refresh around awaited browser operations: %s', async mode => {
    const start = backgroundSource.indexOf('  async repair_fiber(');
    const end = backgroundSource.indexOf('\n  async closed(', start);
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const source = { tab: 73, documentId: 'original-document', navigationEpoch: 2 };
    const url = `https://chatgpt.com/c/${conversationId}`;
    const context: any = { connectionEpoch: 4, instanceId: 'profile-fiber-refresh', port: 8765,
      token: 'paired-token', disconnected: false, currentDocument: source.documentId, currentEpoch: 2,
      tabConversations: { '73': conversationId }, Number, String, load: async () => {},
      cleanConversationId: (value: unknown) => value === conversationId ? value : null,
      conversationFromUrl: (value: unknown) => value === url ? conversationId : null };
    context.ownsDocument = (held: typeof source) => held.documentId === context.currentDocument &&
      held.navigationEpoch === context.currentEpoch;
    context.conversationAdmission = (held: typeof source) => {
      const epoch = context.connectionEpoch;
      return () => context.connectionEpoch === epoch && context.ownsDocument(held);
    };
    const inject = vi.fn(async () => {
      if (mode === 'document replaced') context.currentDocument = 'replacement-document';
      if (mode === 'epoch changed') context.currentEpoch++;
      return [];
    });
    context.chrome = { scripting: { executeScript: inject }, tabs: { get: async () => {
      if (mode === 'account changed before injection') context.connectionEpoch++;
      return { id: 73, url, status: 'complete', ...(mode === 'pending navigation' ? { pendingUrl: url } : {}) };
    } } };
    const repair = vm.runInNewContext(`({${backgroundSource.slice(start, end)}}).repair_fiber`, context);
    const reply = await repair({ operatorRefresh: true, conversationId, instanceId: context.instanceId,
      navigationEpoch: 2 }, { url }, source);
    expect(reply).toMatchObject({ ok: false, error: mode === 'account changed before injection'
      ? 'account_changed' : mode === 'pending navigation' ? 'conversation_changed' : 'stale_document' });
    expect(inject).toHaveBeenCalledTimes(['pending navigation', 'account changed before injection'].includes(mode) ? 0 : 1);
  });

  it('serializes explicit Fiber refreshes through the incumbent tab owner', async () => {
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const instanceId = 'profile-fiber-refresh', url = `https://chatgpt.com/c/${conversationId}`;
    const fetch = vi.fn(async (input: string) => new URL(input).pathname === '/hello'
      ? response(200, { app: 'chat-on-steroids', bridge: 16, paired: true, instanceId }) : response(404, {}));
    const worker = loadWorker({ local: new FakeStorageArea({ ...paired, instanceId }),
      session: new FakeStorageArea({ tabConversations: { '73': conversationId } }),
      tabsGet: async () => ({ id: 73, url, status: 'complete' }), fetch });
    await worker.registerTab(73);
    let release!: () => void;
    worker.scriptingExecuteScript.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]); }));
    const request = { type: 'repair_fiber', operatorRefresh: true, conversationId, instanceId, navigationEpoch: 0 };
    const first = worker.send(request, 73, undefined, url);
    await vi.waitFor(() => expect(worker.scriptingExecuteScript).toHaveBeenCalledTimes(1));
    const second = worker.send(request, 73, undefined, url);
    await Promise.resolve(); expect(worker.scriptingExecuteScript).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toEqual({ ok: true, refreshed: true });
    expect(await second).toEqual({ ok: true, refreshed: true });
    expect(worker.scriptingExecuteScript).toHaveBeenCalledTimes(2);
    expect(worker.tabsReload).not.toHaveBeenCalled(); expect(worker.runtimeReload).not.toHaveBeenCalled();
  });

  it('has no way to ask the app for work at all', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    // The old poll message, from a stale content script that was never reloaded. It is not
    // a route any more, so it is answered as the unknown message it is rather than
    // reopening a path the app has stopped serving.
    const reply = await worker.send({ type: 'poll' });
    expect(reply?.ok).not.toBe(true);
    expect(fetch.mock.calls.every(([input]) => new URL(String(input)).pathname !== '/commands')).toBe(true);
  });

  it('provisions itself silently on the first call and retries with the new token', async () => {
    const local = new FakeStorageArea({ port: 8765 });
    const session = new FakeStorageArea();
    const seen: Array<{ path: string; auth: unknown }> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      seen.push({ path: url.pathname, auth: headers.authorization });
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: false });
      if (url.pathname === '/pair') return response(200, { token: 'fresh-token' });
      if (url.pathname === '/commands/redeem') return response(200, { command: null });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const status = await worker.send({ type: 'status' });
    expect(status).toMatchObject({ connected: true, paired: true });
    expect(seen.some((call) => call.path === '/pair')).toBe(true);
    expect(local.data.token).toBe('fresh-token');

    await worker.send({ type: 'redeem', id: 'cmd-1', client: 'page-1' });
    expect(seen.find((call) => call.path === '/commands/redeem')?.auth).toBe('Bearer fresh-token');
    // Nothing anywhere asked for a code.
    expect(fetch.mock.calls.some(([, init]) => String((init as any)?.body ?? '').includes('code'))).toBe(false);
  });

  it('pairs on its own after a worker reload when its account binding is already known (#568)', async () => {
    // The custom build can have three live local instances. Preserve its fail-closed account
    // chooser for genuinely empty storage; automatic pairing is safe once this Chrome profile's
    // port has already been persisted.
    const local = new FakeStorageArea({ port: 8765 });
    const session = new FakeStorageArea();
    const paths: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      paths.push(url.pathname);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', bridge: 16, paired: true });
      if (url.pathname === '/pair') return response(200, { token: 'fresh-start-token' });
      return response(200, {});
    });
    loadWorker({ local, session, fetch });
    await vi.waitFor(() => expect(local.data.token).toBe('fresh-start-token'), { timeout: 5_000 });
    expect(paths).toContain('/pair');
  });

  it('does not pair on its own after the user disconnected it', async () => {
    const local = new FakeStorageArea({ port: 8765, disconnected: true });
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', bridge: 16, paired: false });
      if (url.pathname === '/pair') return response(200, { token: 'unwanted-token' });
      return response(200, {});
    });
    loadWorker({ local, session, fetch });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/pair')).toBe(false);
    expect(local.data.token).toBeUndefined();
  });

  it('re-provisions once when the app no longer recognises the stored token', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'stale-token' });
    const session = new FakeStorageArea();
    const tokens: Array<unknown> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/pair') return response(200, { token: 'second-token' });
      if (url.pathname === '/commands/redeem') {
        tokens.push(headers.authorization);
        return headers.authorization === 'Bearer second-token'
          ? response(200, { command: null })
          : response(401, { error: 'unauthorised' });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const result = await worker.send({ type: 'redeem', id: 'cmd-1', client: 'page-1' });
    expect(result.ok).toBe(true);
    expect(tokens).toEqual(['Bearer stale-token', 'Bearer second-token']);
    expect(local.data.token).toBe('second-token');
  });
});

/**
 * Waking a worker happens in the chat that worker already has.
 *
 * The app cannot reach into the browser, so it opens `/c/<id>?clf=<command>` and lets the
 * page redeem the marker. That is right when the chat is closed and wrong when it is not:
 * ChatGPT is a single-page app, and a second tab on the same conversation is exactly the
 * duplicate this whole feature exists to avoid. The service worker sees the tab being
 * created, notices the conversation is already open somewhere, and hands the job over to
 * that document instead.
 */
describe('extension revival delivery', () => {
  const paired = { port: 8765, token: 'paired-token' };
  const CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const PRIME = '11111111-2222-4333-8444-555555555555';
  const revival = { id: 'cmd-wake', conversationId: CHAT };

  const app = (route: 'status' | 'activity' = 'status') =>
    vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === `/${route}`) {
        return response(200, { ok: true, recoveryMonitoring: true, repairs: [], revival });
      }
      if (url.pathname === '/commands/revivals/pending') {
        const body = JSON.parse(String(init.body || '{}'));
        return response(200, { pending: body.entries.map((entry: { id: string }) => entry.id) });
      }
      return response(404, {});
    });

  const liveRecorder = async (_tabId: number, message: Record<string, unknown>) =>
    message.type === 'clf-recorder-ping'
      ? { ok: true, recorderVersion: currentRecorderVersion, freshTurnProtocol: 1, requiredFeatures: { promptEnvelope: true, nativeAllowOnce: true } }
      : { ok: true, claimed: true };

  it.each([
    ['recorder-starting', { commandReadinessInitialized: false }],
    ['recorder-generating', { generating: true }],
    ['tools-pending', { pendingTools: 1 }],
    ['native-busy', { nativeBusy: {} }],
    ['goal-busy', { goalBusy: true }],
    ['input-busy', { job: { busy: true } }]
  ])('classifies the existing revival veto without exposing private state: %s', (reason, flags) => {
    const start = contentSource.indexOf('  function revivalReadinessReasons(');
    const end = contentSource.indexOf('\n  function noteRevivalReadiness(', start);
    const context = { alive: true, commandReadinessInitialized: true, generating: false, pendingTools: 0,
      nativeBusy: null, goalBusy: false, job: null, ...flags,
      CLF_DOM: { conversationId: () => CHAT, generating: () => false, composerSubmitReady: () => true },
      target: CHAT, actual: null };
    vm.runInNewContext(`${contentSource.slice(start, end)}; actual = revivalReadinessReasons(target);`, context);
    expect(context.actual).toEqual([reason]);
  });

  it('scans before opening and routes to the oldest exact worker tab', async () => {
    const local = new FakeStorageArea(paired);
    const worker = loadWorker({
      local,
      session: new FakeStorageArea({ recoveryMonitoring: true }),
      fetch: app(),
      tabsQuery: async () => [
        { id: 9, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, status: 'complete' },
        { id: 4, windowId: 7, url: `https://chat.openai.com/c/${CHAT}`, status: 'complete' }
      ],
      tabsSendMessage: liveRecorder
    });

    await worker.fireAlarm();

    await vi.waitFor(() =>
      expect(worker.tabsSendMessage).toHaveBeenCalledWith(4, {
        type: 'clf-run-command',
        id: revival.id,
        conversationId: CHAT,
        deferredRecovery: true
      })
    );
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
    expect(local.data.deferredRevivals).toMatchObject([revival]);
  });

  it.each(['status', 'activity'] as const)('takes every wake from %s even when the oldest exact tab is still unavailable', async route => {
    const second = { id: 'cmd-wake-2', conversationId: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === `/${route}`) return response(200, {
        ok: true, recoveryMonitoring: true, repairs: [], revival, revivals: [revival, second]
      });
      if (url.pathname === '/commands/revivals/pending') {
        const body = JSON.parse(String(init.body || '{}'));
        return response(200, {
          pending: body.entries.map((entry: { id: string }) => entry.id),
          placements: [revival, second].map(entry => ({ id: entry.id, homeConversationId: PRIME, background: false }))
        });
      }
      return response(200, { repairs: [] });
    });
    const local = new FakeStorageArea(paired);
    const worker = loadWorker({ local, session: new FakeStorageArea({ recoveryMonitoring: true }), fetch,
      tabsQuery: async () => [
        { id: 41, windowId: 9, url: `https://chatgpt.com/c/${PRIME}`, status: 'complete' },
        { id: 42, windowId: 9, url: `https://chatgpt.com/c/${CHAT}`, status: 'loading' }
      ],
      tabsSendMessage: async () => { throw new Error('page still loading'); }
    });
    worker.scriptingExecuteScript.mockRejectedValue(new Error('page still loading'));
    await worker.registerTab(41);
    if (route === 'activity') await worker.send({ type: 'activity', conversationId: PRIME }, 41);
    else await worker.fireAlarm();
    await vi.waitFor(() => expect(worker.tabsCreate).toHaveBeenCalledTimes(1));
    expect(worker.tabsCreate).toHaveBeenCalledWith(expect.objectContaining({
      windowId: 9, active: false, url: expect.stringContaining(`/c/${second.conversationId}`)
    }));
    expect(local.data.deferredRevivals).toMatchObject([revival, second]);
    expect(worker.tabsReload).not.toHaveBeenCalled();
  });

  it('opens one missing revival inactive in its exact Prime window when background chats are off', async () => {
    const tabs: Array<Record<string, unknown>> = [
      { id: 41, windowId: 9, url: `https://chatgpt.com/c/${PRIME}`, status: 'complete', active: true }
    ];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/status') return response(200, {
        ok: true,
        recoveryMonitoring: true,
        repairs: [],
        background: false,
        revival: { ...revival, homeConversationId: PRIME, background: false }
      });
      if (url.pathname === '/commands/revivals/pending') {
        const body = JSON.parse(String(init.body || '{}'));
        return response(200, {
          pending: body.entries.map((entry: { id: string }) => entry.id),
          placements: [{ id: revival.id, homeConversationId: PRIME, background: false }]
        });
      }
      return response(404, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({ recoveryMonitoring: true }),
      fetch,
      tabsQuery: async () => tabs as never,
      tabsCreate: async properties => {
        const tab = { id: 99, windowId: Number(properties.windowId), url: String(properties.url),
          status: 'loading', active: properties.active };
        tabs.push(tab);
        return tab;
      }
    });

    await worker.fireAlarm();

    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
    expect(worker.tabsCreate).toHaveBeenCalledWith(expect.objectContaining({ windowId: 9, active: false }));
    const opened = String(worker.tabsCreate.mock.calls[0]?.[0]?.url || '');
    expect(opened).toContain(`/c/${CHAT}`);
    expect(opened).toContain(`clf=${revival.id}`);

    // The marker tab is visible to the next fresh scan even before redeem settles. The same
    // pending revival can therefore never turn an alarm/activity burst into a tab spiral.
    await worker.fireAlarm();
    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
  });

  it('reopens a missing background revival inactive beside its exact Prime', async () => {
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/status') return response(200, {
        ok: true,
        recoveryMonitoring: true,
        repairs: [],
        background: true,
        revival: { ...revival, homeConversationId: PRIME, background: true }
      });
      if (url.pathname === '/commands/revivals/pending') {
        const body = JSON.parse(String(init.body || '{}'));
        return response(200, {
          pending: body.entries.map((entry: { id: string }) => entry.id),
          placements: [{ id: revival.id, homeConversationId: PRIME, background: true }]
        });
      }
      return response(404, {});
    });
    const home = { id: 41, windowId: 9, url: `https://chatgpt.com/c/${PRIME}`, status: 'complete', active: true };
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({ recoveryMonitoring: true, chatBackgroundWindow: 7 }),
      fetch,
      tabsQuery: async () => [home],
      tabsGet: async id => id === home.id ? home : { id, windowId: 9, status: 'loading' },
      windowsGet: async id => ({ id, focused: id === 9 })
    });

    await worker.fireAlarm();

    expect(worker.tabsCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      windowId: 9,
      active: false,
      url: expect.stringContaining(`/c/${CHAT}`)
    }));
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
  });

  it('does not duplicate an exact tab while its replacement document is still loading', async () => {
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({ recoveryMonitoring: true }),
      fetch: app(),
      tabsQuery: async () => [
        { id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, status: 'loading' }
      ],
      tabsSendMessage: async () => {
        throw new Error('receiver is still starting');
      }
    });
    worker.scriptingExecuteScript.mockRejectedValue(new Error('document is navigating'));

    await worker.fireAlarm();

    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('does not turn a failed browser scan into absence or an opening permit', async () => {
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea({ recoveryMonitoring: true }),
      fetch: app(), tabsQuery: async () => { throw new Error('browser snapshot unavailable'); }
    });
    await worker.fireAlarm();
    await worker.fireAlarm();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('keeps an inaccessible complete exact tab as the only revival target', async () => {
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({ recoveryMonitoring: true }),
      fetch: app(),
      tabsQuery: async () => [
        { id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, status: 'complete' }
      ],
      tabsSendMessage: async () => {
        throw new Error('no receiver');
      }
    });
    worker.scriptingExecuteScript.mockRejectedValue(new Error('page cannot be repaired'));

    await worker.fireAlarm();

    await worker.fireAlarm();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('takes the fast path from any live activity poll without waiting for the alarm', async () => {
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      fetch: app('activity'),
      tabsQuery: async () => [
        { id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, status: 'complete' },
        { id: 9, windowId: 7, url: `https://chatgpt.com/c/${PRIME}`, status: 'complete' }
      ],
      tabsSendMessage: liveRecorder
    });
    await worker.registerTab(9, 'prime-document');
    await worker.send({ type: 'bind', conversationId: PRIME }, 9, 'prime-document');

    await worker.send({ type: 'activity', conversationId: PRIME, since: 0 }, 9, 'prime-document');

    await vi.waitFor(() =>
      expect(worker.tabsSendMessage).toHaveBeenCalledWith(4, {
        type: 'clf-run-command',
        id: revival.id,
        conversationId: CHAT,
        deferredRecovery: true
      })
    );
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('persists revival custody and never recreates its user-closed tab after browser restart', async () => {
    const local = new FakeStorageArea(paired);
    const first = loadWorker({ local, session: new FakeStorageArea(), fetch: app() });
    await first.registerTab(4, 'document-4-live');

    local.failNextSets = 1;
    const failed = await first.send({ type: 'defer_revival', ...revival }, 4, 'document-4-live');
    expect(failed).toMatchObject({ ok: false });
    expect(local.data.deferredRevivals ?? []).toEqual([]);

    const retried = await first.send({ type: 'defer_revival', ...revival }, 4, 'document-4-live');
    expect(retried).toEqual({ ok: true, deferred: true });
    expect(local.data.deferredRevivals).toMatchObject([revival]);

    const restarted = loadWorker({
      local,
      session: new FakeStorageArea(),
      fetch: app(),
      tabsQuery: async () => []
    });
    await restarted.fireAlarm();
    expect(restarted.tabsCreate).not.toHaveBeenCalled();
    expect(local.data.deferredRevivals).toMatchObject([{ ...revival, openingSpent: true }]);
  });

  it.each(['retired', 'old-live', 'new-claimed', 'transport'])
    ('allows inert waiter supersession only with exact Main command proof: %s', async fault => {
      const oldId = '1111111111111111', currentId = '2222222222222222';
      const checks: any[] = [];
      const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
        if (new URL(input).pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (new URL(input).pathname === '/commands/revivals/pending') {
          checks.push(JSON.parse(String(init.body)));
          if (fault === 'transport') return response(503, {});
          return response(200, { pending: fault === 'old-live' ? [oldId, currentId] : [currentId],
            readiness: fault === 'new-claimed' ? [] : [{ id: currentId, createdAt: Date.now() }] });
        }
        return response(404, {});
      });
      const local = new FakeStorageArea(paired);
      const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });
      await worker.registerTab(4, 'worker-document');
      const decision = worker.send({ type: 'defer_revival', id: currentId,
        conversationId: CHAT, supersedes: oldId }, 4, 'worker-document');
      expect((await decision) as any).toMatchObject({ ok: fault === 'retired',
        ...(fault === 'retired' ? { supersede: true } : {}) });
      expect(checks).toEqual([{ entries: [{ id: oldId, conversationId: CHAT },
        { id: currentId, conversationId: CHAT }], readiness: true }]);
      expect(local.data.deferredRevivals ?? []).toEqual([]);
      expect(worker.tabsCreate).not.toHaveBeenCalled();
    });

  it('forwards only exact-document bounded revival readiness after checking the command incarnation', async () => {
    const reports: any[] = [];
    const createdAt = Date.now();
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/revivals/pending') {
        const body = JSON.parse(String(init.body || '{}'));
        if (body.entries[0]?.readiness) reports.push(body.entries[0]);
        return response(200, { pending: [revival.id], readiness: [{ id: revival.id, createdAt }] });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsSendMessage: async (_tab, message) => message.type === 'clf-page-status' ? {
        ok: true, runId: 'worker-recorder', conversationId: CHAT,
        revivalReadiness: { ...revival, blockedBy: ['composer-draft', 'durable-events'], phase: 'waiting', waitingSince: Date.now() },
        privateText: 'this must never cross into diagnostics'
      } : { ok: true } });
    await worker.registerTab(4, 'worker-document');
    expect(await worker.send({ type: 'defer_revival', ...revival, readiness: true }, 4, 'worker-document'))
      .toEqual({ ok: true, deferred: true });
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(4, { type: 'clf-page-status' }, { documentId: 'worker-document' });
    expect(reports[0]).toMatchObject({ ...revival, readiness: {
      createdAt, tab: 4, documentId: 'worker-document', navigationEpoch: 0, client: 'worker-recorder',
      blockedBy: ['composer-draft', 'durable-events']
    } });
    expect(JSON.stringify(reports)).not.toContain('this must never');
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it.each(['changed-document', 'foreign-chat', 'foreign-command', 'unknown-reason', 'older-wake'])
    ('does not retain revival readiness from a stale or forged page proof: %s', async fault => {
      const reports: any[] = [];
      let release: ((value: unknown) => void) | null = null;
      const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
        if (new URL(input).pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        const body = JSON.parse(String(init.body || '{}'));
        if (body.entries?.[0]?.readiness) reports.push(body.entries[0]);
        return response(200, { pending: [revival.id], readiness: [{ id: revival.id, createdAt: Date.now() }] });
      });
      const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
        tabsSendMessage: async (_tab, message) => message.type === 'clf-page-status'
          ? new Promise(resolve => { release = resolve; }) : { ok: true } });
      await worker.registerTab(4, 'old-document');
      const attempt = worker.send({ type: 'defer_revival', ...revival, readiness: true }, 4, 'old-document');
      await vi.waitFor(() => expect(release).not.toBeNull());
      if (fault === 'changed-document') await worker.registerTab(4, 'replacement-document');
      release!({ ok: true, runId: 'worker-recorder', conversationId: fault === 'foreign-chat' ? PRIME : CHAT,
        revivalReadiness: { ...revival, id: fault === 'foreign-command' ? 'another-command' : revival.id,
          phase: 'waiting', waitingSince: fault === 'older-wake' ? 1 : Date.now(),
          blockedBy: fault === 'unknown-reason' ? ['private composer prose'] : ['native-busy'] } });
      await attempt;
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(reports).toEqual([]);
      expect(worker.tabsCreate).not.toHaveBeenCalled();
    });

  it('persists the first revival opening before Chrome and never repeats it across restart', async () => {
    const local = new FakeStorageArea({ ...paired, deferredRevivals: [revival] });
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/revivals/pending') {
        const body = JSON.parse(String(init.body || '{}'));
        return response(200, {
          pending: body.entries.map((entry: { id: string }) => entry.id),
          placements: [{ id: revival.id, homeConversationId: PRIME, background: true }]
        });
      }
      return response(404, {});
    });
    const first = loadWorker({
      local,
      session: new FakeStorageArea({ chatBackgroundWindow: 7 }),
      fetch,
      tabsQuery: async () => [],
      windowsGet: async id => ({ id, focused: false })
    });
    await vi.waitFor(() => expect(first.tabsCreate).toHaveBeenCalledTimes(1));
    expect(first.tabsCreate).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
    expect(local.data.deferredRevivals).toMatchObject([{ ...revival, openingSpent: true }]);
    await first.fireAlarm();
    expect(first.tabsCreate).toHaveBeenCalledTimes(1);
    const restarted = loadWorker({
      local,
      session: new FakeStorageArea({ chatBackgroundWindow: 7 }),
      fetch,
      tabsQuery: async () => [],
      windowsGet: async id => ({ id, focused: false })
    });
    await restarted.fireAlarm();
    expect(restarted.tabsCreate).not.toHaveBeenCalled();
  });

  it('prunes a stale deferred revival before browser startup can recreate its ChatGPT tab', async () => {
    const local = new FakeStorageArea({
      ...paired,
      deferredRevivals: [{ id: 'cmd-dead-after-restart', conversationId: CHAT, queuedAt: Date.now() }]
    });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/revivals/pending') return response(200, { pending: [] });
      return response(404, {});
    });

    const restarted = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsQuery: async () => [] });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/commands/revivals/pending')).toBe(true));

    expect(restarted.tabsCreate).not.toHaveBeenCalled();
    expect(local.data.deferredRevivals).toEqual([]);
  });

  it('fails closed when deferred-revival validation is unavailable instead of opening an unproven tab', async () => {
    const marker = { id: 'cmd-validation-unavailable', conversationId: CHAT, queuedAt: Date.now() };
    const local = new FakeStorageArea({ ...paired, deferredRevivals: [marker] });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/revivals/pending') return response(503, { error: 'bridge_recovering' });
      return response(404, {});
    });

    const restarted = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsQuery: async () => [] });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/commands/revivals/pending')).toBe(true));

    expect(restarted.tabsCreate).not.toHaveBeenCalled();
    expect(local.data.deferredRevivals).toMatchObject([marker]);
  });

  it('prunes process-local revival offer suppressors with the bounded durable revival owner', () => {
    const start = backgroundSource.indexOf('function pruneDeferredRevivalOffers()');
    const end = backgroundSource.indexOf('\nasync function rememberDeferredRevival(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const deferredRevivalOffers = new Map([
      ['keep-revival', 4],
      ['dropped-by-cap', 5],
      ['retired-by-app', 6]
    ]);
    const context = {
      deferredRevivals: [{ id: 'keep-revival' }],
      deferredRevivalOffers,
      deferredRevivalId: (value: unknown) => typeof value === 'string' ? value : null
    };

    vm.runInNewContext(`${backgroundSource.slice(start, end)}\npruneDeferredRevivalOffers();`, context);

    expect([...deferredRevivalOffers.entries()]).toEqual([['keep-revival', 4]]);
    expect(backgroundSource.slice(backgroundSource.indexOf('async function rememberDeferredRevival('),
      backgroundSource.indexOf('async function forgetDeferredRevival('))).toContain('pruneDeferredRevivalOffers();');
    expect(backgroundSource.slice(backgroundSource.indexOf('async function reconcileDeferredRevivalsWithApp()'),
      backgroundSource.indexOf('/**\n * Re-presents deferred revival markers'))).toContain('pruneDeferredRevivalOffers();');
    expect(backgroundSource.slice(backgroundSource.indexOf('function recoverDeferredRevivals()'),
      backgroundSource.indexOf('\nfunction restoreOpenChatgptTabs', backgroundSource.indexOf('function recoverDeferredRevivals()'))))
      .toContain('pruneDeferredRevivalOffers();');
  });

  it('replaces an obsolete deferred wake for the same worker conversation', async () => {
    const oldId = 'cmd-old-deferred-worker-wake';
    const local = new FakeStorageArea({
      ...paired,
      deferredRevivals: [{ id: oldId, conversationId: CHAT, queuedAt: 1 }]
    });
    const worker = loadWorker({ local, session: new FakeStorageArea() });
    await worker.registerTab(4, 'document-4-current');

    const custody = await worker.send({ type: 'defer_revival', ...revival }, 4, 'document-4-current');

    expect(custody).toEqual({ ok: true, deferred: true });
    expect(local.data.deferredRevivals).toMatchObject([revival]);
    expect((local.data.deferredRevivals as Array<{ id: string }>).some((entry) => entry.id === oldId)).toBe(false);
  });

  it('cuts old persistent ACK, revival and opening custody over to two new workers without opening a fresh chat', async () => {
    const ackedConversation = 'abababab-1111-4111-8111-abababababab';
    const pendingConversation = 'cdcdcdcd-2222-4222-8222-cdcdcdcdcdcd';
    const ackedId = 'cmd-cutover-acked-revival';
    const pendingId = 'cmd-cutover-still-pending';
    const terminalOpeningConversation = 'efefefef-3333-4333-8333-efefefefefef';
    const local = new FakeStorageArea({
      ...paired,
      deferredRevivals: [
        { id: ackedId, conversationId: ackedConversation, queuedAt: Date.now() - 2_000 },
        { id: pendingId, conversationId: pendingConversation, queuedAt: Date.now() - 1_000, openingSpent: true }
      ],
      // The already-sent page result is stronger authority than its older deferred-revival
      // marker. Current loadOnce() deliberately prefers this browser-restart durable local copy.
      commandAckOutbox: [{ id: ackedId, status: 'sent', conversationId: ackedConversation, client: 'old-page' }]
    });
    const session = new FakeStorageArea({
      // Old companion state can contain a terminal Open episode at replacement time. This row
      // may be retained or retired by current cleanup, but it must never become fresh-tab
      // authority merely because a new MV3 worker loaded it.
      appOwnedOpeningTabs: {
        '89': {
          createdAt: Date.now() - 30_000,
          conversationId: terminalOpeningConversation,
          openRequestId: 'open-cutover-terminal',
          openState: 'escalated',
          retargetCount: 2,
          replacementCreated: true,
          escalationNonce: '1234567890abcdef1234567890abcdef',
          escalationReported: true
        }
      },
      // Seed the old session fallback too: local is authoritative, so replacement must not
      // replay both copies of the same irreversible ACK.
      commandAckOutbox: [{ id: ackedId, status: 'sent', conversationId: ackedConversation, client: 'old-page' }]
    });
    const ackBodies: Array<Record<string, unknown>> = [];
    const routes: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const route = new URL(input).pathname;
      routes.push(route);
      if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (route === '/commands/ack') {
        ackBodies.push(JSON.parse(String(init.body || '{}')));
        return response(200, { ok: true, committed: true });
      }
      if (route === '/commands/revivals/pending') {
        return response(200, { pending: [pendingId] });
      }
      if (route === '/status') {
        return response(200, { ok: true, recoveryMonitoring: true, repairs: [], openConversationRequests: [] });
      }
      if (route === '/browser/unreachable-conversation' || route === '/browser/open-chat') {
        return response(409, { accepted: false });
      }
      return response(404, {});
    });

    const first = loadWorker({ local, session, fetch, tabsQuery: async () => [] });
    await first.send({ type: 'status' });
    await first.fireAlarm();
    await vi.waitFor(() => expect(ackBodies).toHaveLength(1));

    expect(ackBodies).toEqual([{ id: ackedId, status: 'sent', conversationId: ackedConversation, client: 'old-page' }]);
    expect(local.data.commandAckOutbox).toEqual([]);
    expect(session.data.commandAckOutbox).toEqual([]);
    expect(local.data.deferredRevivals).toEqual([
      expect.objectContaining({ id: pendingId, conversationId: pendingConversation, openingSpent: true })
    ]);
    expect(first.tabsCreate).not.toHaveBeenCalled();
    expect(first.tabsUpdate.mock.calls.some(([, update]) => typeof update.url === 'string')).toBe(false);
    expect(first.tabsSendMessage.mock.calls.some(([, message]) => message.type === 'clf-run-command')).toBe(false);

    // A second current worker over exactly the storage left by the first one is the real MV3
    // replacement/restart boundary. No ACK, revival or terminal Open episode may mint a second
    // browser action merely because process-local maps were lost.
    const second = loadWorker({ local, session, fetch, tabsQuery: async () => [] });
    await second.send({ type: 'status' });
    await second.fireAlarm();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(ackBodies).toHaveLength(1);
    expect(local.data.commandAckOutbox).toEqual([]);
    expect(session.data.commandAckOutbox).toEqual([]);
    expect(local.data.deferredRevivals).toEqual([
      expect.objectContaining({ id: pendingId, conversationId: pendingConversation, openingSpent: true })
    ]);
    expect(second.tabsCreate).not.toHaveBeenCalled();
    expect(second.tabsUpdate.mock.calls.some(([, update]) => typeof update.url === 'string')).toBe(false);
    expect(second.tabsSendMessage.mock.calls.some(([, message]) => message.type === 'clf-run-command')).toBe(false);
    expect(routes.filter(route => route === '/commands/ack')).toHaveLength(1);
    expect(routes.filter(route => route === '/browser/open-chat')).toHaveLength(0);
    expect(routes.filter(route => route === '/browser/unreachable-conversation')).toHaveLength(0);
  });
});

describe('extension observation journal', () => {
  it('carries the native ChatGPT Project with terminal observations', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const project = 'g-p-11111111111111111111111111111111';
    const posted: Record<string, unknown>[] = [];
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({
      local,
      session: new FakeStorageArea(),
      tabsGet: async () => ({ id: 61, url: `https://chatgpt.com/g/g-${project.slice(2)}/c/${conversationId}` }),
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/events') {
          posted.push(JSON.parse(String(init.body)));
          return response(200, { sessionId: 'session', stored: 1 });
        }
        return response(404, {});
      }
    });

    await worker.send({
      type: 'events',
      conversationId,
      entries: [{ conversationId, event: {
        kind: 'chat_error', time: Date.now(), reason: 'conversation_limit', recoverable: false,
        text: 'This chat has reached its limit. Please create a new chat to continue.'
      } }]
    }, 61);

    expect(posted).toEqual([expect.objectContaining({ conversationId, project })]);
  });

  it('delivers another chat and its Goal while a slow chat holds one slot, without overlapping same-chat batches', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    const gateB = new Promise<void>(resolve => { releaseB = resolve; });
    const posted: Array<{ conversationId: string; events: Array<{ text: string }> }> = [];
    const active = new Set<string>();
    let maximum = 0;
    let overlaps = 0;
    let drafts = 0;
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') {
        const batch = JSON.parse(String(init.body));
        posted.push(batch);
        if (active.has(batch.conversationId)) overlaps++;
        active.add(batch.conversationId);
        maximum = Math.max(maximum, active.size);
        if (batch.conversationId === a) await gateA;
        if (batch.conversationId === b && batch.events[0].text === 'B1') await gateB;
        active.delete(batch.conversationId);
        return response(200, { stored: batch.events.length });
      }
      if (url.pathname === '/goal/draft') { drafts++; return response(200, { goal: { stage: 'drafting' } }); }
      return response(404, {});
    } });
    const event = (conversationId: string, text: string) => ({
      type: 'events', conversationId,
      entries: [{ conversationId, event: { kind: 'progress', time: Date.now(), text } }]
    });
    let aFinished = false;
    const pendingA = worker.send(event(a, 'A1'), 61).then(result => { aFinished = true; return result; });
    try {
      await vi.waitFor(() => expect(active.has(a)).toBe(true));
      await worker.send(event(b, 'B1'), 62);
      await vi.waitFor(() => expect(active.has(b)).toBe(true));
      await worker.send(event(b, 'B2'), 62);
      expect(posted.filter(batch => batch.conversationId === b)).toHaveLength(1);
      const goal = worker.send({ type: 'goal_draft', conversationId: b, turnId: 'B-final' }, 62);
      releaseB();
      await expect(goal).resolves.toMatchObject({ ok: true });
      expect(aFinished).toBe(false);
      expect(drafts).toBe(1);
      expect(posted.filter(batch => batch.conversationId === b).flatMap(batch => batch.events.map(row => row.text))).toEqual(['B1', 'B2']);
      expect(maximum).toBe(2);
      expect(overlaps).toBe(0);
      expect(journalOf(session).map(entry => entry.conversationId)).toEqual([a]);
    } finally { releaseA(); releaseB(); }
    await pendingA;
    expect(journalOf(session)).toEqual([]);
  });

  it('lets an exact Goal retry drain its failed transcript while another conversation remains in flight', async () => {
    const slow = '11111111-2222-3333-4444-555555555555';
    const goal = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let healthy = false;
    const posted: string[] = [];
    let goalRequests = 0;
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') {
        const id = JSON.parse(String(init.body)).conversationId;
        posted.push(id);
        if (id === slow) await gate;
        if (id === goal && !healthy) return response(503, {});
        return response(200, { stored: 1 });
      }
      if (url.pathname === '/goal/draft') {
        goalRequests++;
        return response(200, { accepted: true });
      }
      return response(404, {});
    } });
    const pending = worker.send({ type: 'events', entries: [slow, goal].map(conversationId => ({
      conversationId, event: { kind: 'progress', time: Date.now(), text: conversationId }
    })) }, 61);
    try {
      await vi.waitFor(() => expect(posted.filter(id => id === goal)).toHaveLength(1));
      expect(goalRequests).toBe(0);
      const stillUnavailable = await worker.send({ type: 'goal_draft', conversationId: goal, turnId: 'same-original-final' }, 62);
      expect(stillUnavailable).toMatchObject({ ok: false, error: 'transcript_not_delivered' });
      expect(posted.filter(id => id === goal)).toHaveLength(2);
      expect(goalRequests).toBe(0);
      expect(journalOf(session).map(entry => entry.conversationId)).toEqual([slow, goal]);
      healthy = true;
      const retry = await worker.send({ type: 'goal_draft', conversationId: goal, turnId: 'same-original-final' }, 62);
      expect(retry).toMatchObject({ ok: true });
      expect(posted.filter(id => id === goal)).toHaveLength(3);
      expect(posted.filter(id => id === slow)).toHaveLength(1);
      expect(goalRequests).toBe(1);
      expect(journalOf(session).map(entry => entry.conversationId)).toEqual([slow]);
    } finally { release(); }
    await pending;
  });

  it('keeps command-receipt custody and failed batches isolated while another transport slot is busy', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const c = '33333333-4444-5555-6666-777777777777';
    const d = '44444444-5555-6666-7777-888888888888';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let healthy = false;
    const posted: string[] = [];
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/ack') return healthy ? response(200, { ok: true }) : response(503, {});
      if (url.pathname === '/events') {
        const id = JSON.parse(String(init.body)).conversationId;
        posted.push(id);
        if (id === a) await gate;
        if (id === c && !healthy) return response(503, {});
        return response(200, { stored: 1 });
      }
      return response(404, {});
    } });
    await worker.send({ type: 'ack', id: 'blocked-command', status: 'sent', conversationId: b }, 62);
    const row = (conversationId: string) => ({ conversationId, event: { kind: 'progress', time: Date.now(), text: conversationId } });
    const pending = worker.send({ type: 'events', entries: [a, b, c, d].map(row) }, 61);
    try {
      await vi.waitFor(() => expect(posted).toContain(d));
      expect(posted).not.toContain(b);
      expect(posted.filter(id => id === c)).toHaveLength(1);
      await expect(worker.send({ type: 'goal_draft', conversationId: b, turnId: 'blocked' }, 62))
        .resolves.toMatchObject({ ok: false, error: 'transcript_not_delivered' });
      expect(journalOf(session).map(entry => entry.conversationId)).toEqual([a, b, c]);
    } finally { release(); }
    await pending;
    healthy = true;
    await worker.send({ type: 'status' }, 62);
    await vi.waitFor(() => expect(journalOf(session)).toEqual([]));
    expect(posted).toContain(b);
    expect(posted.filter(id => id === c)).toHaveLength(2);
  });

  it('does not let one chat\'s retryable ACK block a later conversation receipt', async () => {
    const a = '11111111-2222-4333-8444-555555555551';
    const b = '11111111-2222-4333-8444-555555555552';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const attempts: string[] = [];
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/ack') {
        const body = JSON.parse(String(init.body));
        attempts.push(body.conversationId);
        return body.conversationId === a ? response(503, { error: 'retry' }) : response(200, { ok: true });
      }
      return response(404, {});
    } });

    expect((await worker.send({ type: 'ack', id: 'ack-a', status: 'sent', conversationId: a, client: 'a-page' })).ok).toBe(false);
    const second = await worker.send({ type: 'ack', id: 'ack-b', status: 'sent', conversationId: b, client: 'b-page' });
    expect(second.ok).toBe(true);
    expect(attempts).toEqual([a, a, b]);
    expect(session.data.commandAckOutbox).toMatchObject([{ id: 'ack-a', conversationId: a }]);
  });

  it('Goal actively drains its recovered send receipt before publishing the triggering transcript', async () => {
    const conversationId = '11111111-2222-4333-8444-555555555553';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let ackHealthy = false;
    let drafts = 0;
    const routes: string[] = [];
    const worker = loadWorker({ local, session, fetch: async (input) => {
      const url = new URL(input);
      routes.push(url.pathname);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/ack') return ackHealthy ? response(200, { ok: true }) : response(503, { error: 'retry' });
      if (url.pathname === '/events') return response(200, { stored: 1 });
      if (url.pathname === '/goal/draft') { drafts += 1; return response(200, { goal: { stage: 'drafting' } }); }
      return response(404, {});
    } });

    expect((await worker.send({ type: 'ack', id: 'goal-receipt', status: 'sent', conversationId, client: 'goal-page' })).ok).toBe(false);
    await worker.send({ type: 'events', conversationId, entries: [{ conversationId,
      event: { kind: 'assistant_message', time: Date.now(), text: 'final waiting behind receipt', messageId: 'goal-final', final: true, state: 'final' } }] }, 62);
    expect(journalOf(session)).toHaveLength(1);
    expect(session.data.commandAckOutbox).toHaveLength(1);

    ackHealthy = true;
    routes.length = 0;
    const drafted = await worker.send({ type: 'goal_draft', conversationId, turnId: 'goal-turn' }, 62);
    expect(drafted).toMatchObject({ ok: true });
    expect(routes).toEqual(['/commands/ack', '/events', '/goal/draft']);
    expect(session.data.commandAckOutbox).toEqual([]);
    expect(journalOf(session)).toEqual([]);
    expect(drafts).toBe(1);
  });

  it('yields a hot conversation to an unserved conversation between batches', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const c = '33333333-4444-5555-6666-777777777777';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const posted: string[] = [];
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') {
        const id = JSON.parse(String(init.body)).conversationId;
        posted.push(id);
        if (id === a) await gate;
        return response(200, { stored: 1 });
      }
      return response(404, {});
    } });
    const row = (conversationId: string, index: number) => ({ conversationId, event: { kind: 'progress', time: index, text: String(index) } });
    const pending = worker.send({ type: 'events', entries: [row(a, 0), ...Array.from({ length: 101 }, (_, i) => row(b, i)), row(c, 0)] });
    try {
      await vi.waitFor(() => expect(posted).toHaveLength(4));
      expect(posted).toEqual([a, b, c, b]);
    } finally { release(); }
    await pending;
    expect(journalOf(session)).toEqual([]);
  });

  it('does not permanently settle a worker command merely because its bootstrap message was sent', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/ack') return response(200, { ok: true });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    await worker.send({ type: 'ack', id: 'worker-command', status: 'sent', agent: 'worker-1' });
    expect(session.data.settled ?? []).toEqual([]);

    await worker.send({ type: 'ack', id: 'resume-command', status: 'sent' });
    expect(session.data.settled).toEqual(['resume-command']);
  });

  it('preserves the deferred bootstrap status when returning an unready model picker to the app', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const bodies: any[] = [];
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/ack') {
        bodies.push(JSON.parse(String(init.body)));
        return response(200, { ok: true, final: false, committed: false, outcome: 'deferred' });
      }
      return response(404, {});
    } });

    await worker.send({ type: 'ack', id: 'picker-deferred-command', status: 'deferred',
      error: 'selection_unknown', client: 'picker-page' });

    expect(bodies).toEqual([expect.objectContaining({ id: 'picker-deferred-command', status: 'deferred',
      error: 'selection_unknown', client: 'picker-page' })]);
    expect(session.data.commandAckOutbox).toEqual([]);
    expect(session.data.settled ?? []).toEqual([]);
  });

  it('preserves the observation journal on a 426 protocol mismatch', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') return response(426, { error: 'upgrade_required' });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    const result = await worker.send({
      type: 'events',
      conversationId,
      entries: [
        { conversationId, event: { kind: 'user_message', time: 1_700_000_000_000, text: 'must survive upgrade skew' } }
      ]
    });

    expect(result).toMatchObject({ ok: true, pending: 1, durable: true });
    expect(journalOf(session)).toEqual([
      expect.objectContaining({
        conversationId,
        event: expect.objectContaining({ kind: 'user_message', text: 'must survive upgrade skew' })
      })
    ]);
    expect(JSON.stringify(journalOf(session))).not.toContain('rejected by the local bridge');
  });

  it('keeps one retry alarm while work remains instead of resetting it on every failure', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let healthy = false;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') return healthy ? response(200, { ok: true }) : response(503, { error: 'retry' });
      if (url.pathname === '/closed') return response(200, { ok: true });
      if (url.pathname === '/status') return response(200, { ok: true, repairs: [], recoveryMonitoring: false });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '12121212-3434-5656-7878-909090909090';
    const event = (text: string) => ({ conversationId, event: { kind: 'progress', time: 1, text } });

    await worker.send({ type: 'events', conversationId, entries: [event('first')] });
    await worker.send({ type: 'events', conversationId, entries: [event('second')] });
    expect(worker.alarmCreate).toHaveBeenCalledTimes(1);
    expect(worker.alarmCreate).toHaveBeenCalledWith('clf-bridge-drain', { delayInMinutes: 0.5 });
    expect(journalOf(session)).toHaveLength(2);

    healthy = true;
    await worker.send({ type: 'events', conversationId, entries: [event('third')] });
    expect(journalOf(session)).toEqual([]);
    // Delivered, but this browser is paired - and a paired worker keeps asking, because the
    // alarm is the only thing that wakes a stopped worker to collect a repair, tab or no tab.
    expect(worker.alarmClear).not.toHaveBeenCalled();

    await worker.closeTab(1);
    expect(worker.alarmClear).not.toHaveBeenCalledWith('clf-bridge-drain');
  });

  it('replays the same retained native final after source retirement without a new page observation', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let sourceClosed = false;
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') {
        bodies.push(JSON.parse(String(init.body)));
        return sourceClosed ? response(200, { ok: true })
          : response(503, { error: 'resume_source_retirement_pending', retryable: true });
      }
      if (url.pathname === '/status') return response(200, { ok: true, repairs: [], recoveryMonitoring: false });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '12121212-3434-5656-7878-909090909091';
    const entry = { conversationId, event: { kind: 'assistant_message', time: 1,
      messageId: 'aa120002-1111-4111-8111-000000000002', providerMessageId: 'aa120002-1111-4111-8111-000000000002',
      inputSourceUserMessageId: 'aa120001-1111-4111-8111-000000000001', fiberConversationId: conversationId,
      text: 'The exact resumed pass is complete.', state: 'final', final: true } };
    expect(await worker.send({ type: 'events', conversationId, entries: [entry] })).toMatchObject({ durable: true, pending: 1 });
    expect(journalOf(session)).toHaveLength(1);
    sourceClosed = true;
    await worker.fireAlarm();
    expect(journalOf(session)).toEqual([]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    await worker.fireAlarm();
    expect(bodies).toHaveLength(2);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('preserves a pre-Send attention ACK through the real handler without poisoning native input custody', async () => {
    const id = '5a5a5a5a6b6b6b6b', client = 'exact-resume-document';
    const error = 'ChatGPT did not create the exact native Core app token. This exact command was not sent.';
    const inputReceipt = { kind: 'input', id: 'original-input', owner: 'source-document',
      conversationId: '22222222-3333-4444-5555-666666666666', messageId: 'original-native-message', queuedAt: Date.now() };
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea({ commandAckOutbox: [inputReceipt] });
    const bodies: Array<Record<string, unknown>> = [];
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const route = new URL(input).pathname;
      if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (route === '/input/ack') return response(503, { error: 'retain_original_receipt' });
      if (route === '/commands/ack') {
        const body = JSON.parse(String(init.body)); bodies.push(body);
        return body.status === 'attention'
          ? response(200, { ok: true, final: false, committed: false, outcome: 'attention' })
          : response(503, { error: 'conversation_required', retryable: true });
      }
      return response(404, {});
    } });
    await worker.registerTab(1, client);
    expect(await worker.send({ type: 'ack', id, status: 'attention', error, client }, 1, client))
      .toMatchObject({ ok: true, data: { committed: false, outcome: 'attention' } });
    expect(bodies).toEqual([{ id, status: 'attention', error, client }]);
    expect(session.data.commandAckOutbox).toEqual([inputReceipt]);
    expect(session.data.settled ?? []).toEqual([]);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsRemove).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves exact attention ACK ownership and reason on durable retry (restart=%s)', async restart => {
    const id = '7c7c7c7c8d8d8d8d', client = 'original-attention-document';
    const error = 'The Core-bound composer changed. Nothing was sent.';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let healthy = false;
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = async (input: string, init: Record<string, unknown> = {}) => {
      const route = new URL(input).pathname;
      if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (route === '/commands/ack') {
        const body = JSON.parse(String(init.body)); bodies.push(body);
        return healthy && body.status === 'attention'
          ? response(200, { ok: true, final: false, committed: false, outcome: 'attention' })
          : response(503, { error: 'temporarily_unavailable' });
      }
      return response(404, {});
    };
    const first = loadWorker({ local, session, fetch });
    await first.registerTab(1, client);
    expect(await first.send({ type: 'ack', id, status: 'attention', error, client }, 1, client)).toMatchObject({ ok: false });
    expect(session.data.commandAckOutbox).toMatchObject([{ id, status: 'attention', error, client }]);
    const stored = structuredClone(session.data.commandAckOutbox);
    healthy = true;
    const recovered = restart ? loadWorker({ local, session, fetch }) : first;
    await recovered.fireAlarm();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual({ id, status: 'attention', error, client });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(stored).toMatchObject([{ id, status: 'attention', error, client, provisional: `tab-1:${client}` }]);
    expect(session.data.commandAckOutbox).toEqual([]);
    expect(session.data.settled ?? []).toEqual([]);
    expect(first.tabsCreate).not.toHaveBeenCalled();
    expect(recovered.tabsCreate).not.toHaveBeenCalled();
    expect(recovered.tabsRemove).not.toHaveBeenCalled();
  });

  it.each(['sent', 'failed', 'deferred', undefined, 'unknown'])('keeps the incumbent command ACK status contract (%s)', async status => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const bodies: Array<Record<string, unknown>> = [];
    const conversationId = '22222222-3333-4444-5555-666666666666';
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      if (new URL(input).pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (new URL(input).pathname === '/commands/ack') {
        bodies.push(JSON.parse(String(init.body)));
        return response(200, { ok: true, committed: false });
      }
      return response(404, {});
    } });
    await worker.send({ type: 'ack', id: 'legacy-status-command', status, conversationId, client: 'original-client' });
    expect(bodies).toEqual([{ id: 'legacy-status-command', status: status === 'failed' || status === 'deferred' ? status : 'sent',
      conversationId, client: 'original-client' }]);
    expect(session.data.commandAckOutbox).toEqual([]);
    expect(session.data.settled ?? []).toEqual([]);
  });

  it('does not relabel a historical sent ACK from its descriptive pre-Send error on restore', async () => {
    const receipt = { id: 'historical-command', status: 'sent', client: 'original-document',
      error: 'The Core-bound composer changed. Nothing was sent.', provisional: 'tab-1:original-document', queuedAt: Date.now() };
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea({ commandAckOutbox: [receipt] });
    const bodies: Array<Record<string, unknown>> = [];
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      if (new URL(input).pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (new URL(input).pathname === '/commands/ack') {
        bodies.push(JSON.parse(String(init.body)));
        return response(503, { error: 'conversation_required', retryable: true });
      }
      return response(404, {});
    } });
    await worker.fireAlarm();
    expect(bodies).toEqual([{ id: receipt.id, status: 'sent', client: receipt.client, error: receipt.error }]);
    expect(session.data.commandAckOutbox).toEqual([receipt]);
    expect(session.data.settled ?? []).toEqual([]);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it.each(['retired-document', 'foreign-client'])('keeps an attention ACK fenced from an invalid owner (%s)', async owner => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const bodies: Array<Record<string, unknown>> = [];
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      if (new URL(input).pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (new URL(input).pathname === '/commands/ack') {
        bodies.push(JSON.parse(String(init.body)));
        return response(409, { error: 'command_owner_changed' });
      }
      return response(404, {});
    } });
    await worker.registerTab(1, 'original-document');
    if (owner === 'retired-document') await worker.registerTab(1, 'replacement-document');
    const result = await worker.send({ type: 'ack', id: 'attention-owner-fence', status: 'attention',
      error: 'Nothing was sent.', client: owner === 'foreign-client' ? 'foreign-client' : 'original-client' }, 1, 'original-document');
    expect(result.ok).toBe(false);
    if (owner === 'retired-document') expect(bodies).toEqual([]);
    else expect(bodies).toEqual([{ id: 'attention-owner-fence', status: 'attention', error: 'Nothing was sent.', client: 'foreign-client' }]);
    expect(session.data.commandAckOutbox ?? []).toEqual([]);
    expect(session.data.settled ?? []).toEqual([]);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsRemove).not.toHaveBeenCalled();
  });

  it('durably retries a lost command ACK after the service worker restarts', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const firstFetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/ack') return response(503, { error: 'temporarily_unavailable' });
      return response(404, {});
    });
    const first = loadWorker({ local, session, fetch: firstFetch });
    const conversationId = '22222222-3333-4444-5555-666666666666';

    const attempted = await first.send({
      type: 'ack',
      id: 'resume-retry',
      status: 'sent',
      conversationId,
      client: 'page-one'
    });
    expect(attempted.ok).toBe(false);
    expect(session.data.commandAckOutbox).toMatchObject([
      { id: 'resume-retry', status: 'sent', conversationId, client: 'page-one' }
    ]);
    expect(session.data.settled ?? []).toEqual([]);

    const bodies: Array<Record<string, unknown>> = [];
    const secondFetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/ack') {
        bodies.push(JSON.parse(String(init.body)));
        return response(200, { ok: true, committed: true });
      }
      return response(404, {});
    });
    const restarted = loadWorker({ local, session, fetch: secondFetch });
    await restarted.send({ type: 'status' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bodies).toEqual([
      { id: 'resume-retry', status: 'sent', conversationId, client: 'page-one' }
    ]);
    expect(session.data.commandAckOutbox).toEqual([]);
    expect(session.data.settled).toEqual(['resume-retry']);
  });

  it('keeps a fresh command page journal behind its pending ACK after the route gets an id', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let ackHealthy = false;
    const postedEvents: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/ack') {
        return ackHealthy ? response(200, { ok: true, committed: true }) : response(503, { error: 'retry' });
      }
      if (url.pathname === '/events') {
        postedEvents.push(JSON.parse(String(init.body)));
        return response(200, { sessionId: 'session', stored: 1 });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const tabId = 42;
    const documentId = 'command-document';
    const conversationId = '33333333-4444-5555-6666-777777777777';
    await worker.registerTab(tabId, documentId);

    await worker.send(
      { type: 'ack', id: 'cmd-gate', status: 'sent', client: 'command-page' },
      tabId,
      documentId
    );
    expect(session.data.commandAckOutbox).toMatchObject([
      { id: 'cmd-gate', conversationId: undefined, provisional: `tab-${tabId}:${documentId}` }
    ]);

    // The command result and its id-less observations may both survive a real fresh-chat
    // reload. They must migrate to the replacement document together or the later /c/<id>
    // bind would gate only the journal and let it overtake the still-pending command ACK.
    await worker.navigateTab(tabId, 'https://chatgpt.com/');
    const replacementDocument = `document-${tabId}-1`;
    expect(session.data.commandAckOutbox).toMatchObject([
      { id: 'cmd-gate', conversationId: undefined, provisional: `tab-${tabId}:${replacementDocument}` }
    ]);

    await worker.send(
      {
        type: 'events',
        conversationId,
        entries: [{ conversationId, event: { kind: 'user_message', time: 10, text: 'command bootstrap' } }]
      },
      tabId,
      replacementDocument
    );
    expect(postedEvents).toEqual([]);
    expect(session.data.commandAckOutbox).toMatchObject([{ id: 'cmd-gate', conversationId }]);
    expect(journalOf(session)).toHaveLength(1);

    ackHealthy = true;
    await worker.send({ type: 'status' }, tabId, replacementDocument);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(postedEvents).toEqual([
      { conversationId, events: [expect.objectContaining({ kind: 'user_message', text: 'command bootstrap' })] }
    ]);
    expect(session.data.commandAckOutbox).toEqual([]);
    expect(journalOf(session)).toEqual([]);
  });

  it('keeps pre-conversation observations across page/service-worker reload and binds them when /c/<id> exists', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const first = loadWorker({ local, session });
    await first.send(
      {
        type: 'events',
        entries: [
          {
            conversationId: null,
            agent: null,
            event: { kind: 'user_message', time: Date.now(), text: 'opening requirement' }
          }
        ]
      },
      42
    );

    expect(journalOf(session)).toMatchObject([
      {
        conversationId: null,
        provisional: 'tab-42:document-42-0',
        event: { kind: 'user_message', text: 'opening requirement' }
      }
    ]);

    // Same Chrome tab after the page and service worker have both been recreated.
    const reloaded = loadWorker({ local, session });
    const bound = await reloaded.send(
      { type: 'bind', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      42
    );
    expect(bound).toMatchObject({ ok: true, bound: 1 });
    expect(journalOf(session)).toMatchObject([
      {
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        provisional: null,
        event: { kind: 'user_message', text: 'opening requirement' }
      }
    ]);
  });

  it('keeps a fresh chat provisional journal through a real ChatGPT page reload', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    await worker.send(
      {
        type: 'events',
        entries: [{ conversationId: null, event: { kind: 'user_message', time: Date.now(), text: 'fresh prompt' } }]
      },
      42
    );
    expect(journalOf(session)[0]).toMatchObject({ provisional: 'tab-42:document-42-0', conversationId: null });

    await worker.navigateTab(42, 'https://chatgpt.com/');
    expect(journalOf(session)[0]).toMatchObject({ provisional: 'tab-42:document-42-1', conversationId: null });

    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const bound = await worker.send({ type: 'bind', conversationId }, 42);
    expect(bound).toMatchObject({ ok: true, bound: 1 });
    expect(journalOf(session)[0]).toMatchObject({ provisional: null, conversationId });
  });

  it('does not lose an observation when two tabs wake a cold service worker at once', async () => {
    // Chrome shuts the worker down after seconds of idling, so two tabs reporting at the
    // same moment after that is ordinary, not exotic. Both handlers used to walk the cold
    // load path concurrently, and the second one assigned the journal it had read — before
    // the first one's write — straight over the global, discarding an entry the first tab
    // had already been told was durable.
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    local.lagMs = 40;
    session.lagMs = 40;
    const worker = loadWorker({ local, session });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    // Tab one starts the cold load. Tab two arrives while that load is still in flight, so
    // its own reads are issued before tab one's journal write and answered after it.
    const first = worker.send(
      { type: 'events', entries: [{ conversationId, event: { kind: 'user_message', time: 1, text: 'from tab one' } }] },
      1
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = worker.send(
      { type: 'events', entries: [{ conversationId, event: { kind: 'user_message', time: 2, text: 'from tab two' } }] },
      2
    );
    const answers = await Promise.all([first, second]);

    for (const answer of answers) expect(answer).toMatchObject({ ok: true, durable: true });
    expect(journalOf(session).map((entry) => entry.event.text)).toEqual(['from tab one', 'from tab two']);
  });

  it('serializes durable journal snapshots so an older slow write cannot erase a newer event', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    session.setDelays = [60, 0];
    const worker = loadWorker({ local, session });

    const first = worker.send(
      { type: 'events', entries: [{ conversationId: null, event: { kind: 'user_message', time: 1, text: 'A' } }] },
      1
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = worker.send(
      { type: 'events', entries: [{ conversationId: null, event: { kind: 'user_message', time: 2, text: 'B' } }] },
      2
    );
    const replies = await Promise.all([first, second]);

    for (const reply of replies) expect(reply).toMatchObject({ ok: true, durable: true });
    expect(journalOf(session).map((entry) => entry.event.text)).toEqual(['A', 'B']);
  });

  // Adapted from Maximapple PR1666 / 2aa6a753, with explicit publication barriers.
  it('coalesces a burst behind a slow journal write without acknowledging uncommitted observations', async () => {
    const local = new FakeStorageArea(), session = new FakeStorageArea();
    const set = session.set.bind(session), writes: string[][] = [];
    let firstStarted = () => {}, releaseFirst = () => {}, nextStarted = () => {}, releaseNext = () => {};
    const firstEntered = new Promise<void>(resolve => { firstStarted = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const nextEntered = new Promise<void>(resolve => { nextStarted = resolve; });
    const nextGate = new Promise<void>(resolve => { releaseNext = resolve; });
    session.set = async values => {
      const snapshot = structuredClone(values);
      if (Array.isArray(snapshot.journal)) {
        writes.push(snapshot.journal.map((row: any) => row.event.text));
        if (writes.length === 1) { firstStarted(); await firstGate; }
        else if (writes.length === 2) { nextStarted(); await nextGate; }
      }
      return set(snapshot);
    };
    const worker = loadWorker({ local, session });
    const send = (text: string, time: number) => worker.send({ type: 'events', entries: [
      { conversationId: null, event: { kind: 'user_message', time, text } }
    ] }, time);
    const first = send('A', 1);
    await firstEntered;
    let acknowledged = 0;
    const later = ['B', 'C', 'D', 'E'].map((text, index) => send(text, index + 2)
      .then(reply => { acknowledged++; return reply; }));
    // All event handlers reach their existing journal await; no timeout supplies durability.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(acknowledged).toBe(0);
    releaseFirst(); await nextEntered;
    expect(acknowledged).toBe(0);
    expect(journalOf(session).map(row => row.event.text)).toEqual(['A']);
    releaseNext();
    const replies = await Promise.all([first, ...later]);
    for (const reply of replies) expect(reply).toMatchObject({ ok: true, durable: true });
    expect(journalOf(session).map(row => row.event.text)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(writes).toEqual([['A'], ['A', 'B', 'C', 'D', 'E']]);
  });

  it('serializes live tab snapshots so a slow older write cannot forget a newer tab owner', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    session.setDelays = [60, 0];
    const worker = loadWorker({ local, session });
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const first = worker.send({ type: 'activity', conversationId: a, since: 0 }, 10);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = worker.send({ type: 'activity', conversationId: b, since: 0 }, 11);
    await Promise.all([first, second]);

    expect(session.data.tabConversations).toEqual({ '10': a, '11': b });
  });

  it('drains each conversation separately so navigation cannot file chat A observations into chat B', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const posted: Array<{ conversationId: string; events: Array<{ text?: string }> }> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') {
        posted.push(JSON.parse(String(init.body)));
        return response(200, { sessionId: 'session', stored: 1 });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    await worker.send({
      type: 'events',
      entries: [
        { conversationId: a, event: { kind: 'progress', time: Date.now(), text: 'A1' } },
        { conversationId: b, event: { kind: 'progress', time: Date.now(), text: 'B1' } },
        { conversationId: a, event: { kind: 'progress', time: Date.now(), text: 'A2' } }
      ]
    });

    expect(posted).toEqual([
      { conversationId: a, events: [{ kind: 'progress', time: expect.any(Number), text: 'A1' }, { kind: 'progress', time: expect.any(Number), text: 'A2' }] },
      { conversationId: b, events: [{ kind: 'progress', time: expect.any(Number), text: 'B1' }] }
    ]);
    expect(journalOf(session)).toEqual([]);
  });

  it('delivers the triggering conversation journal before asking the app for a Goal draft', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let acceptEvents = false;
    const order: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') {
        order.push('/events');
        return acceptEvents
          ? response(200, { sessionId: 'session', stored: 1 })
          : response(503, { error: 'temporarily_unavailable' });
      }
      if (url.pathname === '/goal/draft') {
        order.push('/goal/draft');
        return response(200, { goal: { stage: 'drafting' } });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    // The page handed the final assistant row to the service worker, but the app was briefly
    // unavailable, so the row is durable only in the worker journal when Goal asks for its
    // continuation. Drafting before retrying /events would omit the very answer that triggered
    // the Goal turn from conversationMessages().
    await worker.send(
      {
        type: 'events',
        conversationId,
        entries: [
          {
            conversationId,
            event: {
              kind: 'assistant_message',
              time: Date.now(),
              text: 'the answer Goal must continue from',
              messageId: 'assistant-final',
              final: true,
              state: 'final'
            }
          }
        ]
      },
      61
    );
    expect(journalOf(session)).toHaveLength(1);

    order.length = 0;
    acceptEvents = true;
    const drafted = await worker.send(
      { type: 'goal_draft', conversationId, turnId: 'generation-final' },
      61
    );

    expect(drafted).toMatchObject({ ok: true });
    expect(order).toEqual(['/events', '/goal/draft']);
    expect(journalOf(session)).toEqual([]);
  });

  it('carries the browser tab identity through Goal activity, draft and acknowledgement', async () => {
    const conversationId = '22222222-3333-4444-5555-666666666666';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const seen: Array<{ route: string; client: string | null; messageId?: string | null; turnId?: string | null; confirmedUnsent?: boolean; sendModel?: string | null; sendReasoningEffort?: string | null }> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/activity') {
        seen.push({ route: url.pathname, client: url.searchParams.get('goalClient') });
        return response(200, { sessionId: 'session', entries: [], stream: [], nextSince: 0 });
      }
      if (url.pathname === '/goal/draft' || url.pathname === '/goal/ack') {
        const body = JSON.parse(String(init.body || '{}'));
        seen.push({
          route: url.pathname,
          client: typeof body.clientId === 'string' ? body.clientId : null,
          ...(url.pathname.endsWith('/ack')
            ? {
                messageId: typeof body.messageId === 'string' ? body.messageId : null,
                turnId: typeof body.turnId === 'string' ? body.turnId : null,
                confirmedUnsent: body.confirmedUnsent === true,
                sendModel: typeof body.sendModel === 'string' ? body.sendModel : null,
                sendReasoningEffort: typeof body.sendReasoningEffort === 'string' ? body.sendReasoningEffort : null
              }
            : {})
        });
        return response(200, url.pathname.endsWith('/draft') ? { goal: { stage: 'drafting' } } : { acknowledged: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    await worker.send({ type: 'activity', conversationId, since: 0 }, 73);
    await worker.send({ type: 'goal_draft', conversationId, turnId: 'generation-owned' }, 73);
    await worker.send({ type: 'goal_ack', conversationId, token: 'goal-token', messageId: 'native-message-id',
      sendModel: 'gpt-6-thinking', sendReasoningEffort: 'high' }, 73);
    await worker.send({ type: 'goal_ack', conversationId, token: 'unsent-token', turnId: 'generation-owned', confirmedUnsent: true }, 73);

    expect(seen).toEqual([
      { route: '/activity', client: '73' },
      { route: '/goal/draft', client: '73' },
      { route: '/goal/ack', client: '73', messageId: 'native-message-id', turnId: null, confirmedUnsent: false,
        sendModel: 'gpt-6-thinking', sendReasoningEffort: 'high' },
      { route: '/goal/ack', client: '73', messageId: null, turnId: 'generation-owned', confirmedUnsent: true,
        sendModel: null, sendReasoningEffort: null }
    ]);
  });

  it('forwards only bounded optional veto receipt diagnostics without inspecting private fields', () => {
    const start = backgroundSource.indexOf('function shellScanDiagnostic(');
    const end = backgroundSource.indexOf('\n}', start) + 2;
    expect(start).toBeGreaterThanOrEqual(0);
    const project = (rejects: unknown) => vm.runInNewContext(
      `${backgroundSource.slice(start, end)}; shellScanDiagnostic(raw);`,
      { SHELL_SCAN_MAX: 400, raw: { selectorMatches: 1, mapped: 1, rejects } });
    const base = { fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0 };
    expect(project({ ...base, callVetoReceiptChecked: 400, callVetoReceiptMatched: 1,
      assistantTerminalReceiptChecked: 2, assistantTerminalReceiptMatched: 1,
      privateShape: 'PRIVATE_NATIVE_SHAPE' }).rejects).toEqual({ ...base, callVetoReceiptChecked: 400,
      callVetoReceiptMatched: 1, assistantTerminalReceiptChecked: 2, assistantTerminalReceiptMatched: 1 });
    expect(project({ ...base, callCompletionVeto: 0, callVetoReceiptChecked: 0, callVetoReceiptMatched: 0 }).rejects)
      .toEqual({ ...base, callCompletionVeto: 0, callVetoReceiptChecked: 0, callVetoReceiptMatched: 0 });
    expect(project(base).rejects).not.toHaveProperty('callVetoReceiptChecked');
    expect(project(base).rejects).not.toHaveProperty('callVetoReceiptMatched');
    expect(project({ ...base, assistantTerminalReceiptChecked: 2, assistantTerminalReceiptMatched: 1 }).rejects)
      .toEqual({ ...base, assistantTerminalReceiptChecked: 2, assistantTerminalReceiptMatched: 1 });
    expect(project(base).rejects).not.toHaveProperty('assistantTerminalReceiptChecked');
    expect(project(base).rejects).not.toHaveProperty('assistantTerminalReceiptMatched');
    for (const key of ['callVetoReceiptChecked', 'callVetoReceiptMatched',
      'assistantTerminalReceiptChecked', 'assistantTerminalReceiptMatched']) {
      for (const invalid of [-1, 401, 1.5, null, undefined, 'PRIVATE_NATIVE_SHAPE'])
        expect(project({ ...base, [key]: invalid })).toBeNull();
      let reads = 0;
      const getter = { ...base };
      Object.defineProperty(getter, key, { get() { reads++; return 1; } });
      expect(project(getter)).toBeNull();
      expect(reads).toBe(0);
      expect(project(Object.assign(Object.create({ [key]: 1 }), base)).rejects).not.toHaveProperty(key);
    }
  });

  it.each([
    { callVetoReceiptChecked: 1 },
    { callVetoReceiptMatched: 1 },
    { callVetoReceiptChecked: 0, callVetoReceiptMatched: 1 },
    { callCompletionVeto: 0, callVetoReceiptChecked: 1, callVetoReceiptMatched: 1 }
  ])('rejects an incomplete or impossible veto receipt pair: %j', (pair) => {
    const start = backgroundSource.indexOf('function shellScanDiagnostic(');
    const end = backgroundSource.indexOf('\n}', start) + 2;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(vm.runInNewContext(`${backgroundSource.slice(start, end)}; shellScanDiagnostic(raw);`,
      { SHELL_SCAN_MAX: 400, raw: { selectorMatches: 1, mapped: 1, rejects: {
        fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0, ...pair } } })).toBeNull();
  });

  it.each([
    { assistantTerminalReceiptChecked: 1 },
    { assistantTerminalReceiptMatched: 1 },
    { assistantTerminalReceiptChecked: 0, assistantTerminalReceiptMatched: 1 }
  ])('rejects an incomplete or impossible assistant terminal receipt pair: %j', (pair) => {
    const start = backgroundSource.indexOf('function shellScanDiagnostic(');
    const end = backgroundSource.indexOf('\n}', start) + 2;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(vm.runInNewContext(`${backgroundSource.slice(start, end)}; shellScanDiagnostic(raw);`,
      { SHELL_SCAN_MAX: 400, raw: { selectorMatches: 1, mapped: 1, rejects: {
        fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0, ...pair } } })).toBeNull();
  });

  it('posts a complete 85-call native proof without overflowing activity URLs or losing document custody', async () => {
    const conversationId = '22222222-3333-4444-5555-666666666666';
    const documentId = 'document-73-large-native-proof';
    let packet: { url: URL; init: RequestInit; diagnostic: any } | null = null;
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
      fetch: async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/activity') {
          packet = { url, init: init || {}, diagnostic: init?.method === 'POST'
            ? JSON.parse(String(init.body)).coreDiagnostic : JSON.parse(url.searchParams.get('coreDiagnostic') || 'null') };
          return response(200, { sessionId: 'session', entries: [], stream: [], nextSince: 0 });
        }
        return response(404, {});
      },
      tabsGet: async id => ({ id, url: `https://chatgpt.com/c/${conversationId}`, status: 'complete' })
    });
    await worker.registerTab(73, documentId);
    await worker.send({ type: 'bind', conversationId }, 73, documentId);
    const coreCallMessageIds = Array.from({ length: 85 }, (_, index) => `native-call-${index}-${'a'.repeat(70)}`);
    const allCoreRequestIds = Array.from({ length: 85 }, (_, index) => `wfr_request_${index}_${'b'.repeat(60)}`);
    const identityRefusals = coreCallMessageIds.map((messageId, index) =>
      ({ messageId, reasons: index === 0 ? ['workingTurnMismatch'] : [] }));
    await worker.send({ type: 'activity', conversationId, since: 7, approval: true,
      coreDiagnostic: { shell: 'alternate', shellDiscovery: 'compatible', documentId: 'forged', navigationEpoch: 999,
        ordinaryFinal: { reason: 'open-call', questions: 1, calls: 85, openCalls: 85, codeCalls: 1,
          openCodeCalls: 1, activeTurnMapped: false, sourceUserMessageId: 'abababab-1111-4111-8111-111111111111',
          coreCallMessageIds, allCoreRequestIds, openRequestIds: allCoreRequestIds, identityRefusals,
          codeCallMessageIds: ['native-code-parent'], openCodeCallMessageIds: ['native-code-parent'],
          answeredCodeCallMessageIds: [], privateText: 'never transmit this' } } }, 73, documentId);
    expect(packet).not.toBeNull();
    const sent = packet! as { url: URL; init: RequestInit; diagnostic: any };
    expect(sent.init.method).toBe('POST');
    expect(sent.url.href.length).toBeLessThan(8_000);
    expect(sent.url.searchParams.get('coreDiagnostic')).toBeNull();
    expect(sent.url.searchParams.get('conversationId')).toBe(conversationId);
    expect(sent.url.searchParams.get('goalClient')).toBe('73');
    expect(sent.url.searchParams.get('approval')).toBe('1');
    expect(sent.diagnostic).toMatchObject({ documentId, navigationEpoch: 0,
      ordinaryFinal: { calls: 85, coreCallMessageIds, allCoreRequestIds, openRequestIds: allCoreRequestIds, identityRefusals } });
    expect(JSON.stringify(sent.diagnostic)).not.toContain('never transmit');
  });

  it.each(['valid', 'unknown', 'foreign-parent', 'reordered', 'partial', 'accessor', 'incomplete-inventory'] as const)(
    'forwards only complete exact-parent refusal diagnostics through the elected worker (%s)', async variant => {
      const conversationId = '22222222-3333-4444-5555-666666666666';
      const documentId = 'exact-diagnostic-worker-document';
      let diagnostic: any = null, getterReads = 0;
      const worker = loadWorker({
        local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
        fetch: async (input: string, init?: RequestInit) => {
          const url = new URL(input);
          if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
          if (url.pathname === '/activity') {
            diagnostic = init?.method === 'POST' ? JSON.parse(String(init.body)).coreDiagnostic
              : JSON.parse(url.searchParams.get('coreDiagnostic') || 'null');
            return response(200, { sessionId: 'session', entries: [], stream: [], nextSince: 0 });
          }
          return response(404, {});
        },
        tabsGet: async id => ({ id, url: `https://chatgpt.com/c/${conversationId}`, status: 'complete' })
      });
      await worker.registerTab(73, documentId);
      await worker.send({ type: 'bind', conversationId }, 73, documentId);
      const identityRefusals: any[] = [
        { messageId: 'native-diagnostic-a', reasons: ['workingTurnMismatch'] },
        { messageId: 'native-diagnostic-b', reasons: ['turnExchangeMissing'] }];
      if (variant === 'unknown') identityRefusals[0].reasons = ['PRIVATE_UNKNOWN_REASON'];
      if (variant === 'foreign-parent') identityRefusals[0].messageId = 'foreign-parent';
      if (variant === 'reordered') identityRefusals.reverse();
      if (variant === 'partial') identityRefusals.pop();
      if (variant === 'accessor') Object.defineProperty(identityRefusals[0], 'reasons', {
        get() { getterReads++; throw new Error('PRIVATE_ACCESSOR'); } });
      await worker.send({ type: 'activity', conversationId, since: 0,
        coreDiagnostic: { shell: 'alternate', shellDiscovery: 'compatible', documentId: 'forged', navigationEpoch: 999,
          ordinaryFinal: { reason: 'open-call', questions: 1, calls: 2, openCalls: 2,
            codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
            sourceUserMessageId: 'abababab-1111-4111-8111-111111111111',
            coreCallMessageIds: ['native-diagnostic-a', 'native-diagnostic-b'], codeCallMessageIds: [],
            identityRefusals, ...(variant === 'incomplete-inventory' ? { callInventoryComplete: false } : {})
          } } }, 73, documentId);
      expect(diagnostic).toMatchObject({ documentId, navigationEpoch: 0,
        ordinaryFinal: { calls: 2, openCalls: 2, reason: variant === 'incomplete-inventory' ? 'turn-invalid' : 'open-call' } });
      if (variant === 'valid') expect(diagnostic.ordinaryFinal.identityRefusals).toEqual(identityRefusals);
      else expect(diagnostic.ordinaryFinal.identityRefusals).toBeUndefined();
      expect(getterReads).toBe(0);
      expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_');
    });

  it.each(['accepted', 'old-main', 'missing-ack', 'false-ack', 'foreign-route', 'route-race', 'navigation-race', 'stale-document', 'unbound', 'foreign-owner', 'invalid-mode', 'missing-diagnostic'] as const)(
    'keeps explicit reader observation publication isolated from browser work: %s', async mode => {
      const conversationId = '22222222-3333-4444-5555-666666666666';
      const documentId = 'document-73-observation-only';
      let route = `https://chatgpt.com/c/${conversationId}`;
      let loading = false;
      const packets: Array<{ url: URL; body: any; method?: string }> = [];
      const retained = [{ conversationId, event: { kind: 'progress', time: 1, text: 'Retained worker observation' } }];
      const session = new FakeStorageArea({ journal: retained });
      const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token', instanceId: 'profile-observation-only' }), session,
        fetch: async (input: string, init?: RequestInit) => {
          const url = new URL(input);
          if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true, instanceId: 'profile-observation-only' });
          if (url.pathname === '/activity') {
            packets.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, method: init?.method });
            if (mode === 'route-race') route = 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
            if (mode === 'navigation-race') { loading = true; await worker.startTabNavigation(73, route); }
            if (mode === 'old-main') return response(400, { error: 'bad_request' });
            return response(200, { observationOnly: mode !== 'false-ack', observationAccepted: mode !== 'missing-ack', completionVerified: false,
              // Even an unexpected offer in a response is not permission for this observer.
              revivals: [{ id: 'never-open-this' }], placement: { conversationId: 'never-place-this' } });
          }
          return response(503, {});
        }, tabsGet: async id => ({ id, url: route, status: loading ? 'loading' : 'complete' }) });
      await worker.registerTab(73, documentId);
      if (mode !== 'unbound') await worker.send({ type: 'bind', conversationId: mode === 'foreign-owner'
        ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' : conversationId }, 73, documentId);
      if (mode === 'stale-document') await worker.registerTab(73, 'replacement-observation-document');
      if (mode === 'foreign-route') route = 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const beforeJournal = structuredClone(session.data.journal);
      const beforeBinding = structuredClone(session.data.tabConversations);
      const result = await worker.send({ type: 'activity', conversationId, since: 17, approval: true,
        observationOnly: mode === 'invalid-mode' ? false : true,
        ...(mode === 'missing-diagnostic' ? {} : { coreDiagnostic: { shell: 'alternate', shellDiscovery: 'compatible',
          documentId: 'forged-document', navigationEpoch: 900, observedAt: 1,
          ordinaryFinal: { reason: 'open-call', questions: 1, calls: 1, openCalls: 1, codeCalls: 0, openCodeCalls: 0,
            activeTurnMapped: false, sourceUserMessageId: 'abababab-1111-4111-8111-111111111111',
            coreCallMessageIds: ['original-open-call'], privateText: 'PRIVATE_OBSERVATION_TEXT' } } }) }, 73, documentId);
      if (mode === 'accepted') expect(result, JSON.stringify(result)).toMatchObject({ ok: true, data: {
        observationOnly: true, observationAccepted: true, completionVerified: false } });
      else expect(result).toMatchObject({ ok: false });
      const admitted = !['foreign-route', 'stale-document', 'unbound', 'foreign-owner', 'invalid-mode', 'missing-diagnostic'].includes(mode);
      expect(packets).toHaveLength(admitted ? 1 : 0);
      if (admitted) {
        expect(packets[0]!.method).toBe('POST');
        expect([...packets[0]!.url.searchParams.keys()]).toEqual(['conversationId']);
        expect(Object.keys(packets[0]!.body).sort()).toEqual(['coreDiagnostic', 'observationOnly']);
        expect(packets[0]!.body).toMatchObject({ observationOnly: true, coreDiagnostic: {
          documentId, navigationEpoch: 0, ordinaryFinal: { reason: 'open-call', openCalls: 1,
            coreCallMessageIds: ['original-open-call'] } } });
        expect(packets[0]!.body.coreDiagnostic.observedAt).toBeGreaterThan(1);
        expect(JSON.stringify(packets[0]!.body)).not.toContain('PRIVATE_OBSERVATION_TEXT');
      }
      expect(session.data.journal).toEqual(beforeJournal);
      expect(session.data.tabConversations).toEqual(beforeBinding);
      expect(worker.tabsCreate).not.toHaveBeenCalled();
      expect(worker.tabsReload).not.toHaveBeenCalled();
      expect(worker.scriptingExecuteScript).not.toHaveBeenCalled();
    }
  );

  it.each(['foreign-route', 'pending-route', 'stale-document', 'stale-epoch'] as const)(
    'does not publish a large native proof from a %s activity flight', async mode => {
      const conversationId = '22222222-3333-4444-5555-666666666666';
      const documentId = 'document-73-large-proof-revoked';
      const session = new FakeStorageArea();
      const packets: Array<{ url: URL; init: RequestInit }> = [];
      const worker = loadWorker({
        local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session,
        fetch: async (input: string, init?: RequestInit) => {
          const url = new URL(input);
          if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
          if (url.pathname === '/activity') packets.push({ url, init: init || {} });
          return response(200, { sessionId: 'session', entries: [], stream: [], nextSince: 0 });
        },
        tabsGet: async id => ({ id,
          url: mode === 'foreign-route' ? 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
            : `https://chatgpt.com/c/${conversationId}`,
          ...(mode === 'pending-route' ? { pendingUrl: 'https://chatgpt.com/' } : {}), status: 'complete' })
      });
      await worker.registerTab(73, documentId);
      await worker.send({ type: 'bind', conversationId }, 73, documentId);
      if (mode === 'stale-document') await worker.registerTab(73, 'new-document-73');
      if (mode === 'stale-epoch') await worker.navigateTab(73, `https://chatgpt.com/c/${conversationId}`);
      const ids = Array.from({ length: 85 }, (_, index) => `native-${index}-${'x'.repeat(80)}`);
      await worker.send({ type: 'activity', conversationId, since: 0, coreDiagnostic: {
        shell: 'alternate', shellDiscovery: 'compatible', ordinaryFinal: { reason: 'open-call', questions: 1,
          calls: 85, openCalls: 85, codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
          coreCallMessageIds: ids, allCoreRequestIds: ids, openRequestIds: ids } } }, 73, documentId);
      for (const packet of packets) {
        expect(packet.init.method).not.toBe('POST');
        expect(packet.url.searchParams.has('coreDiagnostic')).toBe(false);
      }
    });

  it.each(['valid', 'same-user', 'malformed', 'missing-user', 'busy'])(
    'forwards only a paired UUID settled-final diagnostic without changing strict completion (%s)', async shape => {
      const conversationId = '22222222-3333-4444-5555-666666666666';
      const sourceUserMessageId = 'abababab-1111-4111-8111-111111111111';
      const finalId = 'abababab-2222-4222-8222-222222222222';
      const documentId = 'document-73-settled-final';
      let diagnostic: any = null;
      const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
        session: new FakeStorageArea(),
        fetch: async (input: string) => {
          const url = new URL(input);
          if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
          if (url.pathname === '/activity') {
            diagnostic = JSON.parse(url.searchParams.get('coreDiagnostic')!);
            return response(200, { entries: [], stream: [] });
          }
          return response(404, {});
        },
        tabsGet: async id => ({ id, url: `https://chatgpt.com/c/${conversationId}`, status: 'complete' })
      });
      await worker.registerTab(73, documentId);
      await worker.send({ type: 'bind', conversationId }, 73, documentId);
      await worker.send({ type: 'activity', conversationId, coreDiagnostic: {
        shell: 'alternate', shellDiscovery: 'compatible', ordinaryFinal: {
          reason: shape === 'busy' ? 'busy' : 'open-call', questions: 1, calls: 1, openCalls: 1, codeCalls: 0, openCodeCalls: 0,
          activeTurnMapped: false, coreCallMessageIds: ['native-still-unresolved'],
          ...(shape === 'missing-user' ? {} : { sourceUserMessageId }),
          ...(shape === 'busy' ? {} : { settledFinalMessageId:
            shape === 'same-user' ? sourceUserMessageId : shape === 'malformed' ? 'private-final-text' : finalId })
        }
      } }, 73, documentId);
      expect(diagnostic).toMatchObject({ documentId, ordinaryFinal: { reason: shape === 'busy' ? 'busy' : 'open-call', openCalls: 1 } });
      if (shape === 'valid') expect(diagnostic.ordinaryFinal.settledFinalMessageId).toBe(finalId);
      else expect(diagnostic.ordinaryFinal.settledFinalMessageId).toBeUndefined();
      expect(JSON.stringify(diagnostic)).not.toContain('private-final-text');
    }
  );

  it.each(['valid', 'busy', 'mapped', 'malformed-user', 'partial-core', 'partial-code', 'duplicate-core', 'foreign-document'] as const)(
    'forwards only an authenticated stopped checkpoint identity (%s)', async shape => {
      const conversationId = '22222222-3333-4444-5555-666666666666';
      const sourceUserMessageId = 'abababab-1111-4111-8111-111111111111';
      const documentId = 'document-73-stopped-checkpoint';
      let diagnostic: any = null;
      const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
        fetch: async (input: string) => {
          const url = new URL(input);
          if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
          if (url.pathname === '/activity') { diagnostic = JSON.parse(url.searchParams.get('coreDiagnostic')!); return response(200, { entries: [], stream: [] }); }
          return response(404, {});
        }, tabsGet: async id => ({ id, url: `https://chatgpt.com/c/${conversationId}`, status: 'complete' }) });
      await worker.registerTab(73, documentId); await worker.send({ type: 'bind', conversationId }, 73, documentId);
      if (shape === 'foreign-document') await worker.registerTab(73, 'replacement-checkpoint-document');
      const ordinaryFinal: any = { reason: shape === 'busy' ? 'busy' : 'turn-invalid', questions: 1, calls: 1, openCalls: 1,
        codeCalls: 0, openCodeCalls: 0, activeTurnMapped: shape === 'mapped',
        checkpointSourceUserMessageId: shape === 'malformed-user' ? 'private-not-an-id' : sourceUserMessageId,
        coreCallMessageIds: ['stopped-unverified-core'], codeCallMessageIds: [] };
      if (shape === 'partial-core') ordinaryFinal.coreCallMessageIds = [];
      if (shape === 'partial-code') { ordinaryFinal.codeCalls = 1; ordinaryFinal.openCodeCalls = 1; }
      if (shape === 'duplicate-core') { ordinaryFinal.calls = 2; ordinaryFinal.openCalls = 2; ordinaryFinal.coreCallMessageIds.push('stopped-unverified-core'); }
      await worker.send({ type: 'activity', conversationId, coreDiagnostic: {
        shell: 'alternate', shellDiscovery: 'compatible', documentId: 'forged-content-document', navigationEpoch: 999, ordinaryFinal
      } }, 73, documentId);
      if (shape === 'foreign-document') expect(diagnostic).toBeNull();
      else {
        expect(diagnostic).toMatchObject({ documentId, navigationEpoch: 0, ordinaryFinal: { openCalls: ordinaryFinal.openCalls } });
        expect(diagnostic.ordinaryFinal.checkpointSourceUserMessageId).toBe(shape === 'valid' ? sourceUserMessageId : undefined);
        expect(diagnostic.ordinaryFinal.settledFinalMessageId).toBeUndefined();
        expect(JSON.stringify(diagnostic)).not.toContain('private-not-an-id');
      }
    });

  it.each(['open-call', 'associated'])('preserves sibling request identities through activity transport (%s)', async (reason) => {
    const conversationId = '22222222-3333-4444-5555-666666666666';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    let diagnostic: any;
    const worker = loadWorker({ local, session: new FakeStorageArea(),
      tabsGet: vi.fn(async tabId => ({ id: tabId, url: `https://chatgpt.com/c/${conversationId}`, status: 'complete' })),
      fetch: vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/activity') {
          diagnostic = JSON.parse(url.searchParams.get('coreDiagnostic')!);
          return response(200, { sessionId: 'session', entries: [], stream: [], nextSince: 0 });
        }
        return response(404, {});
      }) });
    const documentId = 'sibling-request-document';
    await worker.registerTab(73, documentId);
    await worker.send({ type: 'bind', conversationId }, 73, documentId);
    const requests = ['wfr_shared_workflow', 'wfr_shared_workflow'];
    const parents = ['native-sibling-one', 'native-sibling-two'];
    await worker.send({ type: 'activity', conversationId, since: 0,
      coreDiagnostic: { shell: 'alternate', shellDiscovery: 'compatible', requestIds: ['wfr_shared_workflow'],
        ordinaryFinal: { reason, questions: 1, calls: 2, openCalls: reason === 'open-call' ? 2 : 0,
          codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
          sourceUserMessageId: 'abababab-1111-4111-8111-111111111111',
          coreCallMessageIds: parents, allCoreRequestIds: requests,
          ...(reason === 'open-call' ? { openRequestIds: requests } : {}) } }
    }, 73, documentId);
    expect(diagnostic.ordinaryFinal.coreCallMessageIds).toEqual(parents);
    expect(diagnostic.ordinaryFinal.allCoreRequestIds).toEqual(requests);
    if (reason === 'open-call') expect(diagnostic.ordinaryFinal.openRequestIds).toEqual(requests);
    // This is transport preservation, not a terminal result or completion acknowledgement.
    expect(diagnostic.ordinaryFinal.openCalls).toBe(reason === 'open-call' ? 2 : 0);
    expect(diagnostic.documentId).toBe(documentId);
  });

  it.each(['duplicate-parent', 'missing-parent', 'blank-request', 'short-requests'])('withholds invalid sibling request pairs (%s)', async (shape) => {
    const conversationId = '22222222-3333-4444-5555-666666666666';
    let diagnostic: any;
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
      tabsGet: vi.fn(async tabId => ({ id: tabId, url: `https://chatgpt.com/c/${conversationId}`, status: 'complete' })),
      fetch: vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/activity') {
          diagnostic = JSON.parse(url.searchParams.get('coreDiagnostic')!);
          return response(200, { sessionId: 'session', entries: [], stream: [], nextSince: 0 });
        }
        return response(404, {});
      }) });
    const documentId = 'invalid-sibling-document';
    await worker.registerTab(73, documentId);
    await worker.send({ type: 'bind', conversationId }, 73, documentId);
    const parents = shape === 'duplicate-parent' ? ['native-one', 'native-one'] : shape === 'missing-parent' ? ['native-one'] : ['native-one', 'native-two'];
    const requests = shape === 'blank-request' ? ['wfr_shared', ''] : shape === 'short-requests' ? ['wfr_shared'] : ['wfr_shared', 'wfr_shared'];
    await worker.send({ type: 'activity', conversationId, since: 0,
      coreDiagnostic: { shell: 'alternate', shellDiscovery: 'compatible', requestIds: ['wfr_shared'],
        ordinaryFinal: { reason: 'open-call', questions: 1, calls: 2, openCalls: 2,
          codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
          sourceUserMessageId: 'abababab-1111-4111-8111-111111111111',
          coreCallMessageIds: parents, allCoreRequestIds: requests } }
    }, 73, documentId);
    expect(diagnostic.ordinaryFinal.allCoreRequestIds).toBeUndefined();
    expect(diagnostic.ordinaryFinal.openCalls).toBe(2);
  });

  it('stamps passive Core diagnostics with the owned Chrome document and navigation epoch', async () => {
    const conversationId = '22222222-3333-4444-5555-666666666666';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let diagnostic: Record<string, unknown> | null = null;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/activity') {
        const encoded = url.searchParams.get('coreDiagnostic');
        diagnostic = encoded ? JSON.parse(encoded) as Record<string, unknown> : null;
        return response(200, { sessionId: 'session', entries: [], stream: [], nextSince: 0 });
      }
      return response(404, {});
    });
    const worker = loadWorker({
      local,
      session,
      fetch,
      tabsGet: vi.fn(async (tabId) => ({
        id: tabId,
        url: `https://chatgpt.com/c/${conversationId}`,
        status: 'complete'
      }))
    });
    const documentId = 'document-73-core-evidence';
    await worker.registerTab(73, documentId);
    await worker.send({ type: 'bind', conversationId }, 73, documentId);
    await worker.send({
      type: 'activity',
      conversationId,
      since: 0,
      coreDiagnostic: {
        shell: 'alternate',
        shellDiscovery: 'failed',
        ordinaryFinal: { reason: 'open-code', questions: 1, calls: 2, openCalls: 0,
          codeCalls: 1, openCodeCalls: 1, activeTurnMapped: false, privateText: 'must not leave the page',
          sourceUserMessageId: 'abababab-1111-4111-8111-111111111111',
          coreCallMessageIds: ['native-call-one', 'native-call-two'],
          allCoreRequestIds: ['wfr_background_core_one', 'wfr_background_core_two'],
          codeCallMessageIds: ['native-code-parent'],
          openCodeCallMessageIds: ['native-code-parent'], answeredCodeCallMessageIds: [] },
        shellScan: {
          selectorMatches: 4,
          mapped: 1,
          rejects: {
            fiberMissing: 1,
            ownerMissing: 1,
            stableKeyMismatch: 1,
            itemsOverLimit: 0,
            privateReason: 'must not leave the page'
          },
          privateText: 'must not leave the page'
        },
        requestIds: ['wfr_shell_exact'],
        turnId: 'turn-shell-exact',
        // The page does not own these fields. They must be replaced below by service-worker proof.
        documentId: 'forged-page-document',
        navigationEpoch: 999,
        observedAt: 1
      }
    }, 73, documentId);

    expect(diagnostic).toMatchObject({
      shell: 'alternate',
      shellDiscovery: 'failed',
      ordinaryFinal: { reason: 'open-code', questions: 1, calls: 2, openCalls: 0,
        codeCalls: 1, openCodeCalls: 1, activeTurnMapped: false,
        sourceUserMessageId: 'abababab-1111-4111-8111-111111111111',
        coreCallMessageIds: ['native-call-one', 'native-call-two'],
        allCoreRequestIds: ['wfr_background_core_one', 'wfr_background_core_two'],
        codeCallMessageIds: ['native-code-parent'],
        openCodeCallMessageIds: ['native-code-parent'], answeredCodeCallMessageIds: [] },
      shellScan: {
        selectorMatches: 4,
        mapped: 1,
        rejects: {
          fiberMissing: 1,
          ownerMissing: 1,
          stableKeyMismatch: 1,
          itemsOverLimit: 0
        }
      },
      requestIds: ['wfr_shell_exact'],
      turnId: 'turn-shell-exact',
      documentId,
      navigationEpoch: expect.any(Number),
      observedAt: expect.any(Number)
    });
    const stamped = diagnostic as unknown as Record<string, unknown>;
    expect(stamped.documentId).not.toBe('forged-page-document');
    expect(stamped.navigationEpoch).not.toBe(999);
    expect(stamped.observedAt).not.toBe(1);
    expect(JSON.stringify(stamped.shellScan)).not.toContain('private');
    expect(JSON.stringify(stamped.ordinaryFinal)).not.toContain('private');

    diagnostic = null;
    await worker.send({
      type: 'activity',
      conversationId,
      since: 0,
      coreDiagnostic: {
        shell: 'alternate',
        shellDiscovery: 'compatible',
        shellScan: {
          selectorMatches: 401,
          mapped: 0,
          rejects: { fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0 }
        },
        requestIds: [],
        turnId: null
      }
    }, 73, documentId);
    expect(diagnostic).toMatchObject({ shellScan: null });
    for (const invalid of [
      { reason: 'private text', questions: 1, calls: 0, openCalls: 0, codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false },
      { reason: 'associated', questions: 401, calls: 0, openCalls: 0, codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false },
      { reason: 'associated', questions: 1, calls: 0, openCalls: 1, codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false },
      { reason: 'associated', questions: 1, calls: 0, openCalls: 0, codeCalls: 0, openCodeCalls: 0, activeTurnMapped: 'private' }
    ]) {
      await worker.send({ type: 'activity', conversationId, since: 0,
        coreDiagnostic: { shell: 'alternate', ordinaryFinal: invalid } }, 73, documentId);
      expect(diagnostic).toMatchObject({ ordinaryFinal: null });
    }
  });

  it('forwards only bounded completion veto diagnostics without changing document authority', async () => {
    const conversationId = '22222222-3333-4444-5555-666666666666';
    const documentId = 'document-73-veto-shapes';
    let diagnostic: any = null;
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
      fetch: async (input: string) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/activity') {
          diagnostic = JSON.parse(url.searchParams.get('coreDiagnostic') || 'null');
          return response(200, { sessionId: 'session', entries: [], stream: [], nextSince: 0 });
        }
        return response(404, {});
      },
      tabsGet: async id => ({ id, url: `https://chatgpt.com/c/${conversationId}`, status: 'complete' })
    });
    await worker.registerTab(73, documentId);
    await worker.send({ type: 'bind', conversationId }, 73, documentId);
    const details = { callRequestIdPresent: 2, callRequestIdMissing: 1, callInventoryMissing: 1,
      callInventoryIncomplete: 1,
      callIdentityRecovered: 1, callIdentityPriorPair: 2, callIdentityUserUnproved: 3,
      callIdentityNativeUnproved: 4, callIdentityScopeUnproved: 5, callIdentityParentUnproved: 6,
      callIdentitySelectedWithheld: 7,
      assistantTerminalReceiptChecked: 2, assistantTerminalReceiptMatched: 1,
      callJoinReferenceMissing: 1, callJoinReferenceUnselected: 2, callJoinReferenceConflict: 3,
      callJoinResultMissing: 4, callJoinResultIdentity: 5, callJoinDescriptorUnsupported: 400,
      callCompletedFalse: 1, callCompletedUndefined: 2, callCompletedNull: 3,
      callCompletedMalformed: 4, callStatusVeto: 5, callVetoStatusAbsent: 6, callVetoStatusPending: 7,
      callVetoStatusError: 8, callVetoStatusDone: 9, callVetoStatusFinal: 10, callVetoStatusCompleted: 11,
      callVetoStatusComplete: 12, callVetoStatusFinished: 13, callVetoStatusFinishedSuccessfully: 14,
      callVetoStatusUnknown: 400, userTypedMissing: 1, userIdentityInvalid: 2, userTextEmpty: 3,
      userTextUnsupported: 4, userBudgetDropped: 5, userProjected: 400 };
    const rejects = { fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0,
      callCompletionVeto: 1, ...details, privateStatus: 'PRIVATE_STATUS_VALUE' };
    const project = async (counts: unknown) => {
      await worker.send({ type: 'activity', conversationId, since: 0, coreDiagnostic: { shell: 'alternate',
        shellScan: { selectorMatches: 1, mapped: 1, rejects: counts }, documentId: 'forged', navigationEpoch: 999 } }, 73, documentId);
      return diagnostic;
    };
    const valid = await project(rejects);
    expect(valid?.shellScan?.rejects).toMatchObject({ callCompletionVeto: 1, ...details });
    expect(valid?.documentId).toBe(documentId);
    expect(valid?.navigationEpoch).not.toBe(999);
    expect(JSON.stringify(valid)).not.toContain('PRIVATE_STATUS_VALUE');
    for (const key of Object.keys(details)) for (const invalid of [-1, 401, 1.5, 'PRIVATE_STATUS_VALUE', null, undefined])
      expect((await project({ ...rejects, [key]: invalid }))?.shellScan).toBeNull();
    const legacy = await project({ fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0,
      callCompletionVeto: 1 });
    expect(legacy?.shellScan?.rejects.callCompletionVeto).toBe(1);
    expect(legacy?.shellScan?.rejects).not.toHaveProperty('callCompletedFalse');
    expect(legacy?.shellScan?.rejects).not.toHaveProperty('userProjected');
    expect(legacy?.shellScan?.rejects).not.toHaveProperty('assistantTerminalReceiptChecked');
    expect(legacy?.shellScan?.rejects).not.toHaveProperty('assistantTerminalReceiptMatched');
    for (const key of ['userProjected', 'callJoinReferenceMissing', 'callJoinReferenceUnselected', 'callJoinReferenceConflict',
      'callJoinResultMissing', 'callJoinResultIdentity', 'callJoinDescriptorUnsupported', 'callIdentityRecovered', 'callIdentityPriorPair', 'callIdentityUserUnproved', 'callIdentityNativeUnproved', 'callIdentityScopeUnproved', 'callIdentityParentUnproved', 'callIdentitySelectedWithheld']) {
      const inherited = Object.assign(Object.create({ [key]: 400 }), {
        fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0 });
      expect((await project(inherited))?.shellScan?.rejects).not.toHaveProperty(key);
      let getterReads = 0;
      Object.defineProperty(inherited, key, { enumerable: true, get() { getterReads++; return 1; } });
      expect((await project(inherited))?.shellScan).toBeNull();
      expect(getterReads).toBe(0);
    }
  });

  it('forwards the selected incomplete Code parent question but never its claimed terminal final', async () => {
    const conversationId = '22222222-3333-4444-5555-666666666666';
    const documentId = 'document-selected-code-incomplete';
    const sourceUserMessageId = 'abababab-1111-4111-8111-111111111111';
    const unprovedFinalMessageId = 'cdcdcdcd-2222-4222-8222-222222222222';
    let diagnostic: any = null;
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea(),
      fetch: async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/activity') {
          diagnostic = init?.method === 'POST'
            ? JSON.parse(String(init.body)).coreDiagnostic
            : JSON.parse(url.searchParams.get('coreDiagnostic') || 'null');
          return response(200, { sessionId: 'session', entries: [], stream: [], nextSince: 0 });
        }
        return response(404, {});
      }, tabsGet: async id => ({ id, url: `https://chatgpt.com/c/${conversationId}`, status: 'complete' }) });
    await worker.registerTab(73, documentId);
    await worker.send({ type: 'bind', conversationId }, 73, documentId);
    await worker.send({ type: 'activity', conversationId, coreDiagnostic: {
      shell: 'classic', shellDiscovery: 'compatible', ordinaryFinal: {
        reason: 'turn-invalid', questions: 1, calls: 0, openCalls: 0,
        codeCalls: 0, openCodeCalls: 0, activeTurnMapped: false,
        sourceUserMessageId, callInventoryComplete: false,
        settledFinalMessageId: unprovedFinalMessageId
      } } }, 73, documentId);
    expect(diagnostic).toMatchObject({ documentId, navigationEpoch: 0,
      ordinaryFinal: { reason: 'turn-invalid', sourceUserMessageId, callInventoryComplete: false } });
    expect(diagnostic.ordinaryFinal.settledFinalMessageId).toBeUndefined();
    expect(JSON.stringify(diagnostic)).not.toContain(unprovedFinalMessageId);
  });

  it('focuses only the exact owned Goal tab and its Chrome window without opening a duplicate', async () => {
    const conversationId = '22222222-3333-4444-5555-666666666666';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let active = false;
    let focused = false;
    const worker = loadWorker({
      local,
      session,
      fetch: async (input: string) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/status') return response(200, { automationPaused: false });
        return response(200, { ok: true });
      },
      tabsGet: async () => ({ id: 73, windowId: 7, url: `https://chatgpt.com/c/${conversationId}`, active }),
      tabsUpdate: async (id, properties) => {
        if (properties.active === true) active = true;
        return { id, windowId: 7, url: `https://chatgpt.com/c/${conversationId}`, active };
      },
      windowsGet: async id => ({ id, focused, state: 'normal' }),
      windowsUpdate: async (id, properties) => {
        if (properties.focused === true) focused = true;
        return { id, focused, state: 'normal' };
      }
    });

    await worker.registerTab(73);
    await worker.send({ type: 'bind', conversationId }, 73);

    expect(await worker.send({ type: 'focus_tab', conversationId, turnId: 'generation-owned' }, 73)).toMatchObject({
      ok: true,
      focused: true
    });
    expect(worker.tabsUpdate).toHaveBeenCalledTimes(1);
    expect(worker.tabsUpdate).toHaveBeenCalledWith(73, { active: true });
    expect(worker.windowsUpdate).toHaveBeenCalledExactlyOnceWith(7, { focused: true });
    expect(worker.tabsCreate).not.toHaveBeenCalled();

    const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(await worker.send({ type: 'focus_tab', conversationId: other, turnId: 'wrong-chat' }, 73)).toMatchObject({
      ok: false,
      error: 'stale_conversation'
    });
    expect(worker.tabsUpdate).toHaveBeenCalledTimes(1);
    expect(worker.windowsUpdate).toHaveBeenCalledTimes(1);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it.each([true, false])('does not steal focus for automatic work while paused or disconnected (paused=%s)', async paused => {
    const conversationId = '22222222-3333-4444-5555-666666666666';
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea(),
      fetch: async (input: string) => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (route === '/status') return paused ? response(200, { automationPaused: true }) : response(503, { error: 'unavailable' });
        return response(200, { ok: true });
      },
      tabsGet: async () => ({ id: 73, windowId: 7, url: `https://chatgpt.com/c/${conversationId}`, active: false })
    });
    await worker.registerTab(73);
    await worker.send({ type: 'bind', conversationId }, 73);
    const result = await worker.send({ type: 'focus_tab', conversationId }, 73);
    expect(result).toMatchObject({ ok: false, error: paused ? 'automation_paused' : 'automation_state_unavailable' });
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('refuses a Goal draft while the triggering transcript is still not deliverable', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let drafts = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') return response(503, { error: 'temporarily_unavailable' });
      if (url.pathname === '/goal/draft') {
        drafts += 1;
        return response(200, { goal: { stage: 'drafting' } });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    await worker.send(
      {
        type: 'events',
        conversationId,
        entries: [
          {
            conversationId,
            event: {
              kind: 'assistant_message',
              time: Date.now(),
              text: 'still only in the browser journal',
              messageId: 'assistant-undelivered',
              final: true,
              state: 'final'
            }
          }
        ]
      },
      62
    );
    expect(journalOf(session)).toHaveLength(1);

    const drafted = await worker.send(
      { type: 'goal_draft', conversationId, turnId: 'generation-undelivered' },
      62
    );

    expect(drafted).toMatchObject({
      ok: false,
      status: 503,
      error: 'transcript_not_delivered',
      retryable: true
    });
    expect(drafts).toBe(0);
    expect(journalOf(session)).toHaveLength(1);
  });

  it('closes a conversation only when its final browser tab is actually gone', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') return response(200, { sessionId: 'session', stored: 1 });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    for (const tabId of [10, 11]) {
      await worker.send(
        {
          type: 'events',
          conversationId,
          entries: [{ conversationId, event: { kind: 'progress', time: Date.now(), text: `tab ${tabId}` } }]
        },
        tabId
      );
    }

    await worker.closeTab(10);
    expect(closed).toEqual([]);
    await worker.closeTab(11);
    expect(closed).toEqual([conversationId]);
  });

  it('respects a manual close of a protected main chat even when its old Core policy still protects it', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const manuallyClosed: boolean[] = [];
    const conversationId = '12121212-3434-4567-8abc-909090909090';
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/status') return response(200, {
        repairs: [],
        managedConversations: [conversationId],
        mainConversations: [conversationId],
        workerConversations: [],
        nonDiscardableConversations: [conversationId],
        closableConversations: [],
        retiredConversations: []
      });
      if (url.pathname === '/closed') {
        const body = JSON.parse(String(init.body));
        closed.push(body.conversationId);
        manuallyClosed.push(body.manual);
        return response(200, { ok: true });
      }
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch });
    await worker.createTab({ id: 10, url: `https://chatgpt.com/c/${conversationId}`, active: true });
    await worker.send({ type: 'bind', conversationId }, 10);
    await worker.fireAlarm();

    expect(worker.tabsUpdate).toHaveBeenCalledWith(10, { autoDiscardable: false });
    await worker.closeTab(10, { windowId: 7, isWindowClosing: false });

    // A stale nonDiscardable snapshot must not bypass Main's existing deliberate-close fence.
    // Chrome reports no cause for the removal, so the extension cannot claim an accident.
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(closed).toEqual([conversationId]);
    expect(manuallyClosed).toEqual([true]);
  });

  it('does not restore a protected main chat while its entire Chrome window is closing', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const conversationId = '13131313-3535-4678-8bcd-919191919191';
    const worker = loadWorker({
      local,
      session,
      fetch: async (input) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/status') return response(200, {
          repairs: [], managedConversations: [conversationId], mainConversations: [conversationId], workerConversations: [],
          nonDiscardableConversations: [conversationId], closableConversations: [], retiredConversations: []
        });
        return response(200, { ok: true });
      }
    });
    await worker.createTab({ id: 12, url: `https://chatgpt.com/c/${conversationId}`, active: true });
    await worker.send({ type: 'bind', conversationId }, 12);
    await worker.fireAlarm();
    await worker.closeTab(12, { windowId: 7, isWindowClosing: true });

    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('does not resurrect a main tab after Core releases its protection before the close', async () => {
    const conversationId = '14141414-3636-4789-8cde-929292929292';
    let protectedNow = true;
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea(),
      fetch: async input => {
        if (new URL(input).pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (new URL(input).pathname === '/status') return response(200, {
          repairs: [], managedConversations: [conversationId], mainConversations: [conversationId],
          workerConversations: [], nonDiscardableConversations: protectedNow ? [conversationId] : [],
          closableConversations: protectedNow ? [] : [conversationId],
          retiredConversations: protectedNow ? [] : [conversationId]
        });
        return response(200, { ok: true });
      }
    });
    await worker.createTab({ id: 14, url: `https://chatgpt.com/c/${conversationId}`, active: true });
    await worker.send({ type: 'bind', conversationId }, 14);
    await worker.fireAlarm();
    protectedNow = false;
    await worker.closeTab(14, { windowId: 7, isWindowClosing: false });

    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('does not publish closed while an unregistered replacement already has the exact conversation URL', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const conversationId = '11111111-2222-3333-4444-555555555555';
    let visible = [{ id: 11, windowId: 7, url: 'https://chatgpt.com/c/' + conversationId, status: 'complete' }];
    const worker = loadWorker({
      local,
      session,
      tabsQuery: async () => visible,
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (url.pathname === '/closed') {
          closed.push(JSON.parse(String(init.body)).conversationId);
          return response(200, { ok: true });
        }
        return response(200, {});
      }
    });

    // Only the departing copy has registered so far. The replacement's concrete URL is exact
    // browser evidence for this same conversation and must veto the destructive close.
    await worker.send({ type: 'bind', conversationId }, 10);
    await worker.closeTab(10);
    expect(closed).toEqual([]);

    // Once that replacement registers and then really leaves Chrome, the existing close outbox
    // converges normally and publishes the single final close.
    await worker.send({ type: 'bind', conversationId }, 11);
    visible = [];
    await worker.closeTab(11);
    expect(closed).toEqual([conversationId]);
  });

  it.each(['absent', 'present', 'query-failed', 'same-chat', 'pending-chat', 'still-loading'])(
    'only closes a URL-redacted completed departure with positive absence: %s', async (mode) => {
      const conversationId = '11111111-2222-3333-4444-555555555555';
      const session = new FakeStorageArea();
      const closed: string[] = [];
      let completed = false;
      const worker = loadWorker({
        local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session,
        tabsGet: async () => ({ id: 12, status: completed && mode !== 'still-loading' ? 'complete' : 'loading',
          ...(mode === 'same-chat' ? { url: `https://chatgpt.com/c/${conversationId}` } : {}),
          ...(mode === 'pending-chat' ? { pendingUrl: `https://chatgpt.com/c/${conversationId}` } : {}) }),
        tabsQuery: async () => {
          if (mode === 'query-failed') throw new Error('query unavailable');
          return mode === 'present' ? [{ id: 12, url: `https://chatgpt.com/c/${conversationId}` }] : [];
        },
        fetch: async (input, init = {}) => {
          const path = new URL(input).pathname;
          if (path === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
          if (path === '/closed') closed.push(JSON.parse(String(init.body)).conversationId);
          return response(200, {});
        }
      });
      await worker.send({ type: 'bind', conversationId }, 12);
      await worker.startTabNavigation(12);
      expect(closed).toEqual([]);
      completed = true;
      await worker.completeTabNavigation(12);
      await worker.completeTabNavigation(12);
      expect(closed).toEqual(mode === 'absent' ? [conversationId] : []);
      expect(session.data.tabConversations).toEqual(mode === 'absent' ? {} : { '12': conversationId });
    }
  );

  it('does not let delayed departure absence release a newly registered document', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const session = new FakeStorageArea();
    const closed: string[] = [];
    let finishQuery!: (tabs: []) => void;
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session,
      tabsGet: async () => ({ id: 12, status: 'complete' }),
      tabsQuery: () => new Promise((resolve) => { finishQuery = resolve; }),
      fetch: async (input, init = {}) => {
        const path = new URL(input).pathname;
        if (path === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (path === '/closed') closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, {});
      }
    });
    await worker.send({ type: 'bind', conversationId }, 12);
    await worker.startTabNavigation(12);
    await worker.completeTabNavigation(12);
    await worker.registerTab(12, 'replacement-document');
    finishQuery([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toEqual([]);
    expect(session.data.tabConversations).toEqual({ '12': conversationId });
    expect(session.data.tabDocuments).toMatchObject({ '12': 'replacement-document' });
  });

  it('uses the pending destination before an old committed ChatGPT URL', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session,
      tabsGet: async () => ({ id: 12, status: 'loading',
        url: `https://chatgpt.com/c/${conversationId}`, pendingUrl: 'https://example.com/away' }),
      tabsQuery: async () => [{ id: 12, status: 'loading',
        url: `https://chatgpt.com/c/${conversationId}`, pendingUrl: 'https://example.com/away' }],
      fetch: async (input, init = {}) => {
        const path = new URL(input).pathname;
        if (path === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
        if (path === '/closed') closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, {});
      }
    });
    await worker.send({ type: 'bind', conversationId }, 12);
    await worker.startTabNavigation(12);
    expect(closed).toEqual([conversationId]);
    expect(session.data.tabConversations).toEqual({});
  });

  it('closes a conversation when its tab survives but navigates away from ChatGPT', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') return response(200, { sessionId: 'session', stored: 1 });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    await worker.send(
      {
        type: 'events',
        conversationId,
        entries: [{ conversationId, event: { kind: 'progress', time: Date.now(), text: 'still here' } }]
      },
      12
    );
    await worker.navigateTab(12, 'https://example.com/elsewhere');

    expect(closed).toEqual([conversationId]);
    expect(session.data.tabConversations).toEqual({});
  });

  /**
   * Typing chatgpt.com into a Prime's tab used to leave that chat bound to the tab until some
   * later chat happened to be given an id there, so the app never heard the page was gone and
   * never reopened it (2026-09-03). A full document load of any ChatGPT URL that is concretely
   * not the chat's own is the chat leaving; its own URL is the ambiguous reload it always was.
   */
  it('closes a conversation when its tab does a full navigation to another ChatGPT URL', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') return response(200, { sessionId: 'session', stored: 1 });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    await worker.send({ type: 'bind', conversationId }, 12);
    // A reload of the chat's own URL is not a departure.
    await worker.navigateTab(12, `https://chatgpt.com/c/${conversationId}`);
    expect(closed).toEqual([]);
    expect(session.data.tabConversations).toEqual({ '12': conversationId });

    await worker.navigateTab(12, 'https://chatgpt.com/');
    expect(closed).toEqual([conversationId]);
    expect(session.data.tabConversations).toEqual({});
  });

  it('lets terminal navigation beat a delayed message from the dying document', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea({ tabConversations: { '12': conversationId } });
    // Force both handlers through the same cold-worker load window. The browser event is
    // delivered first; stale content IPC arrives while storage is still resolving.
    session.lagMs = 40;
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      if (url.pathname === '/activity') return response(200, { sessionId: 'should-not-be-called', stream: [] });
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const leaving = worker.navigateTab(12, 'https://example.com/elsewhere');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stale = await worker.send({ type: 'activity', conversationId, since: 0 }, 12);
    await leaving;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(stale).toMatchObject({ ok: false, error: 'tab_closed' });
    expect(closed).toEqual([conversationId]);
    expect(session.data.tabConversations).toEqual({});
    expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/activity')).toBe(false);
  });

  it('rejects the old document after an external round trip and lets only the new document own the tab', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      if (url.pathname === '/activity') return response(200, { sessionId: 'session', stream: [] });
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const oldDocument = 'document-12-0';

    await worker.send({ type: 'bind', conversationId: a }, 12, oldDocument);
    await worker.navigateTab(12, 'https://example.com/away');
    await worker.navigateTab(12, `https://chatgpt.com/c/${b}`);

    expect(await worker.send({ type: 'activity', conversationId: a, since: 0 }, 12, oldDocument)).toMatchObject({
      ok: false,
      error: 'stale_document'
    });
    expect(await worker.send({ type: 'bind', conversationId: b }, 12)).toMatchObject({ ok: true });
    expect(session.data.tabConversations).toEqual({ '12': b });
    expect(closed).toEqual([a]);
  });

  it('tombstones a direct ChatGPT document navigation before the replacement document registers', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/activity') return response(200, { sessionId: 'session', stream: [] });
      return response(200, { ok: true });
    });
    const worker = loadWorker({ local, session, fetch });
    const oldDocument = 'document-19-0';

    await worker.send(
      {
        type: 'events',
        conversationId: null,
        entries: [{ conversationId: null, event: { kind: 'user_message', time: 1, text: 'belongs only to A' } }]
      },
      19,
      oldDocument
    );
    await worker.send({ type: 'bind', conversationId: a }, 19, oldDocument);

    const navigating = worker.navigateTab(19, `https://chatgpt.com/c/${b}`);
    const dying = await worker.send({ type: 'activity', conversationId: a, since: 0 }, 19, oldDocument);
    await navigating;

    expect(dying).toMatchObject({ ok: false, error: 'tab_closed' });
    expect(calls).not.toContain('/activity');
    expect(await worker.send({ type: 'bind', conversationId: b }, 19)).toMatchObject({ ok: true, bound: 0 });
    expect(journalOf(session)).toEqual([]);
    expect(session.data.tabConversations).toEqual({ '19': b });
    expect(calls).toContain('/closed');
  });

  it('does not let the dying document revoke its terminal lease while Chrome is still navigating', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const calls: string[] = [];
    const target = `https://chatgpt.com/c/${b}`;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/activity') return response(200, { sessionId: 'session', stream: [] });
      return response(200, { ok: true });
    });
    const worker = loadWorker({
      local,
      session,
      fetch,
      // During a real navigation Chrome can still deliver IPC from the old document while
      // tabs.get already describes the destination. That message is not evidence the
      // navigation was a false-positive terminal prediction.
      tabsGet: vi.fn(async (tabId) => ({ id: tabId, url: target, pendingUrl: target, status: 'loading' }))
    });
    const oldDocument = 'document-31-0';

    await worker.send({ type: 'bind', conversationId: a }, 31, oldDocument);
    const navigating = worker.navigateTab(31, target);
    const dying = await worker.send({ type: 'activity', conversationId: a, since: 0 }, 31, oldDocument);
    await navigating;

    expect(dying).toMatchObject({ ok: false, error: 'tab_closed' });
    expect(calls).not.toContain('/activity');
    expect(await worker.send({ type: 'bind', conversationId: b }, 31)).toMatchObject({ ok: true });
  });

  it('reopens a speculative terminal lease once Chrome proves the original document is settled', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/activity') return response(200, { sessionId: 'session', stream: [] });
      return response(200, { ok: true });
    });
    const worker = loadWorker({
      local,
      session,
      fetch,
      tabsGet: vi.fn(async (tabId) => ({ id: tabId, url: `https://chatgpt.com/c/${a}`, status: 'complete' }))
    });
    const documentId = 'document-32-0';

    await worker.send({ type: 'bind', conversationId: a }, 32, documentId);
    // Chrome emitted a speculative loading transition but the navigation was cancelled or
    // otherwise never replaced this document. Once tabs.get reports the page settled again,
    // its next message is the evidence that should reopen the lease.
    await worker.startTabNavigation(32, `https://chatgpt.com/c/${a}`);
    const recovered = await worker.send({ type: 'activity', conversationId: a, since: 0 }, 32, documentId);

    expect(recovered).toMatchObject({ ok: true });
    expect(calls).toContain('/activity');
  });

  it('blocks the dying reload document without closing the same conversation', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/closed') closed.push(JSON.parse(String(init.body)).conversationId);
      return response(200, { ok: true });
    });
    const worker = loadWorker({ local, session, fetch });
    const oldDocument = 'document-27-0';

    await worker.send({ type: 'bind', conversationId }, 27, oldDocument);
    const reloading = worker.navigateTab(27, `https://chatgpt.com/c/${conversationId}`);
    const dying = await worker.send({ type: 'activity', conversationId, since: 0 }, 27, oldDocument);
    await reloading;
    expect(dying).toMatchObject({ ok: false, error: 'tab_closed' });

    expect(await worker.send({ type: 'bind', conversationId }, 27)).toMatchObject({ ok: true });
    expect(session.data.tabConversations).toEqual({ '27': conversationId });
    expect(closed).toEqual([]);
  });

  it('keeps a terminal document tombstone across service-worker restart', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const oldDocument = 'document-44-old';
    const first = loadWorker({ local, session });
    await first.send({ type: 'bind', conversationId }, 44, oldDocument);
    await first.navigateTab(44, 'https://example.com/away');

    const restarted = loadWorker({ local, session });
    expect(
      await restarted.send({ type: 'compact', conversationId, resume: true }, 44, oldDocument)
    ).toMatchObject({ ok: false, error: 'tab_closed' });

    const newDocument = 'document-44-new';
    expect(await restarted.registerTab(44, newDocument)).toMatchObject({ ok: true });
    expect(await restarted.send({ type: 'bind', conversationId }, 44, newDocument)).toMatchObject({ ok: true });
  });

  it('does not bind an abandoned fresh chat into a later chat that reuses the tab', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });

    await worker.send(
      {
        type: 'events',
        entries: [{ conversationId: null, event: { kind: 'user_message', time: Date.now(), text: 'chat A opening' } }]
      },
      12
    );
    expect(journalOf(session)).toHaveLength(1);

    await worker.navigateTab(12, 'https://example.com/abandoned');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(journalOf(session)).toEqual([]);

    // A later real ChatGPT navigation is a new document and clears the terminal tombstone.
    await worker.navigateTab(12, 'https://chatgpt.com/');
    const bound = await worker.send({ type: 'bind', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, 12);
    expect(bound).toMatchObject({ ok: true, bound: 0 });
    expect(journalOf(session)).toEqual([]);
  });

  it('stays inside the count budget and leaves an explicit gap when progress has to be discarded', async () => {
    const local = new FakeStorageArea({ instanceId: 'profile-test', port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const entries = Array.from({ length: 4200 }, (_, index) => ({
      conversationId,
      event: { kind: 'progress', time: Date.now(), text: `progress ${index}` }
    }));

    await worker.send({ type: 'events', entries });
    const journal = journalOf(session);
    expect(journal.length).toBeLessThanOrEqual(4000);
    expect(journal.some((entry) => entry.gap === true && /progress line\(s\).*dropped/.test(entry.event.text))).toBe(true);
  });

  it('keeps queue-pressure gap evidence scoped to every affected chat and provisional route', async () => {
    const local = new FakeStorageArea({ instanceId: 'profile-test', port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const chatA = 'aaaaaaaa-1111-2222-3333-444444444444';
    const chatB = 'bbbbbbbb-1111-2222-3333-444444444444';
    const tabId = 42;
    const provisional = `tab-${tabId}:document-${tabId}-0`;
    const entries = Array.from({ length: 4200 }, (_, index) => ({
      conversationId: index % 3 === 0 ? chatA : index % 3 === 1 ? chatB : null,
      event: { kind: 'progress', time: Date.now(), text: `progress ${index}` }
    }));

    await worker.send({ type: 'events', entries }, tabId);
    let journal = journalOf(session);
    const gaps = journal.filter((entry) => entry.gap === true);
    expect(gaps.some((entry) => entry.conversationId === chatA && /progress line\(s\).*dropped/.test(entry.event.text))).toBe(true);
    expect(gaps.some((entry) => entry.conversationId === chatB && /progress line\(s\).*dropped/.test(entry.event.text))).toBe(true);
    expect(gaps.some((entry) => entry.conversationId === null && entry.provisional === provisional)).toBe(true);

    const freshChat = 'cccccccc-1111-2222-3333-444444444444';
    await worker.send({ type: 'bind', conversationId: freshChat }, tabId);
    journal = journalOf(session);
    expect(journal.some((entry) => entry.gap === true && entry.conversationId === freshChat && entry.provisional === null)).toBe(true);
    expect(journal.some((entry) => entry.gap === true && entry.conversationId === null && entry.provisional === provisional)).toBe(false);
  });

  it('keeps essential-loss markers scoped to each affected conversation', async () => {
    const local = new FakeStorageArea({ instanceId: 'profile-test', port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const chatA = 'dddddddd-1111-2222-3333-444444444444';
    const chatB = 'eeeeeeee-1111-2222-3333-444444444444';
    const entries = Array.from({ length: 4200 }, (_, index) => ({
      conversationId: index % 2 === 0 ? chatA : chatB,
      event: { kind: 'user_message', time: Date.now(), text: `essential ${index}` }
    }));

    await worker.send({ type: 'events', entries });
    const gaps = journalOf(session).filter((entry) => entry.gap === true && entry.event.kind === 'chat_error');
    expect(gaps.some((entry) => entry.conversationId === chatA && /observation\(s\).*lost/.test(entry.event.text))).toBe(true);
    expect(gaps.some((entry) => entry.conversationId === chatB && /observation\(s\).*lost/.test(entry.event.text))).toBe(true);
  });

  it('stays inside the journal byte budget under large observations', async () => {
    const local = new FakeStorageArea({ instanceId: 'profile-test', port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const conversationId = '99999999-8888-7777-6666-555555555555';
    // Four UTF-8 bytes but only two UTF-16 code units each. The old string-length budget
    // undercounted this journal by half and could acknowledge more than Chrome could store.
    const blob = '🧠'.repeat(2500);
    const entries = Array.from({ length: 1200 }, (_, index) => ({
      conversationId,
      event: { kind: 'progress', time: Date.now(), text: `${index}:${blob}` }
    }));

    await worker.send({ type: 'events', entries });
    const journal = journalOf(session);
    expect(Buffer.byteLength(JSON.stringify(journal), 'utf8')).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(journal.some((entry) => entry.gap === true)).toBe(true);
  });

  it('replaces a single unhalvable 413 observation with an explicit durable gap', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const received: any[] = [];
    let rejected = false;
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') {
        const body = JSON.parse(String(init.body));
        if (!rejected) {
          rejected = true;
          return response(413, { error: 'body_too_large' });
        }
        received.push(...body.events);
        return response(200, { ok: true });
      }
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch });

    await worker.send({
      type: 'events',
      conversationId: '11111111-2222-3333-4444-555555555555',
      entries: [{
        conversationId: '11111111-2222-3333-4444-555555555555',
        event: { kind: 'assistant_message', time: 1, text: 'x'.repeat(600_000) }
      }]
    });

    expect(journalOf(session)).toEqual([]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: 'chat_error' });
    expect(received[0].text).toMatch(/too large.*explicit gap/i);
  });

  it('tightens and retries when Chrome rejects a session-storage write', async () => {
    const local = new FakeStorageArea({ instanceId: 'profile-test', port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    // Below the journal's normal 4 MiB target but above its tightened 3 MiB target,
    // purely to force the "write rejected → compact harder → retry" path.
    session.maxBytes = 3_500_000;
    const worker = loadWorker({ local, session });
    const conversationId = 'abababab-cdcd-efef-1212-343434343434';
    const entries = Array.from({ length: 3200 }, (_, index) => ({
      conversationId,
      event: { kind: 'progress', time: Date.now(), text: `${index}:${'y'.repeat(1500)}` }
    }));

    const reply = await worker.send({ type: 'events', entries });
    expect(reply.durable).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(session.data), 'utf8')).toBeLessThanOrEqual(3_500_000);
  });
});

// ---------------------------------------------------------------- connecting

/**
 * How this browser gets, keeps and gives up a credential.
 *
 * All three of these were the same shape of bug: a decision taken once being quietly
 * retaken a couple of seconds later by a poll that runs in every open tab.
 */
describe('extension connection', () => {
  /** Records every request the worker makes, and answers them the way the app would. */
  function app(): {
    calls: string[];
    fetch: (input: string, init?: Record<string, unknown>) => Promise<any>;
    tokens: number;
  } {
    const state = {
      calls: [] as string[],
      tokens: 0,
      async fetch(input: string) {
        state.calls.push(input);
        if (input.endsWith('/hello')) return response(200, { app: 'chat-on-steroids', paired: true });
        if (input.endsWith('/pair')) {
          state.tokens++;
          return response(200, { token: `token-${state.tokens}` });
        }
        return response(200, {});
      }
    };
    return state;
  }

  /**
   * `/pair` mints a fresh credential and invalidates the one before it, so two callers
   * arriving together do not get two tokens — they get one working token and one that
   * has already been revoked, and then each 401 provisions again.
   */
  it('mints one token however many callers ask at once', async () => {
    const server = app();
    const worker = loadWorker({ local: new FakeStorageArea(), session: new FakeStorageArea(), fetch: server.fetch });

    await Promise.all([
      worker.send({ type: 'status' }),
      worker.send({ type: 'status' }),
      worker.send({ type: 'status' }),
      worker.send({ type: 'status' })
    ]);
    expect(server.tokens).toBe(1);
  });

  it('learns the app instance once, persists it, and presents it on pairing', async () => {
    const instanceId = 'local-instance';
    let pairBody: Record<string, unknown> | null = null;
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') {
        return response(200, { app: 'chat-on-steroids', instanceId, legacyInstance: true, paired: false });
      }
      if (url.pathname === '/pair') {
        pairBody = JSON.parse(String(init.body));
        return response(200, { token: 'instance-token', instanceId });
      }
      return response(404, {});
    });
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });

    expect(await worker.send({ type: 'pair' })).toMatchObject({ ok: true });
    expect(await worker.send({ type: 'status' })).toMatchObject({
      connected: true,
      paired: true,
      instanceId,
      instanceError: null
    });
    expect(pairBody).toEqual({ reconnect: true, instanceId });
    expect(local.data).toMatchObject({ instanceId, token: 'instance-token' });

    await worker.send({ type: 'unpair' });
    expect(local.data.instanceId).toBe(instanceId);
  });

  it('requires separate explicit companion choices for Primary, Zeta and Alpha', async () => {
    const pairPorts: number[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      const candidate = Number(url.port);
      if (url.pathname === '/hello' && [8765, 8767, 8768].includes(candidate)) {
        return response(200, {
          app: 'chat-on-steroids',
          instanceId: candidate === 8765 ? 'local-instance' : candidate === 8768 ? 'profile-Zeta' : 'profile-Alpha',
          displayName: candidate === 8765 ? 'Primary' : candidate === 8768 ? 'Zeta' : 'Alpha',
          legacyInstance: candidate === 8765, paired: false
        });
      }
      if (url.pathname === '/pair') {
        pairPorts.push(candidate);
        expect([8767, 8768]).toContain(candidate);
        const instanceId = candidate === 8768 ? 'profile-Zeta' : 'profile-Alpha';
        expect(JSON.parse(String(init.body))).toEqual({ reconnect: true, instanceId });
        return response(200, { token: `${instanceId}-token`, instanceId });
      }
      return response(503, {});
    });
    const ZetaStorage = new FakeStorageArea();
    const worker = loadWorker({ local: ZetaStorage, session: new FakeStorageArea(), fetch });

    expect(await worker.send({ type: 'status' })).toMatchObject({
      connected: false, paired: false, instanceId: null, instanceError: 'instance_selection_required'
    });
    expect(pairPorts).toEqual([]);
    const popupUrl = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const choices = await worker.send({ type: 'accountChoices' }, 1, undefined, popupUrl);
    expect(choices).toMatchObject({ ok: true });
    expect(choices.accounts).toEqual(expect.arrayContaining([
      { instanceId: 'local-instance', name: 'Primary', port: 8765, legacy: true, compatible: true },
      { instanceId: 'profile-Zeta', name: 'Zeta', port: 8768, legacy: false, compatible: true },
      { instanceId: 'profile-Alpha', name: 'Alpha', port: 8767, legacy: false, compatible: true }
    ]));
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-Zeta' }, 1, undefined, popupUrl)).toMatchObject({ ok: true });
    expect(pairPorts).toEqual([8768]);
    expect(ZetaStorage.data).toMatchObject({ port: 8768, instanceId: 'profile-Zeta', token: 'profile-Zeta-token' });
    expect(await worker.send({ type: 'status' })).toMatchObject({ connected: true, paired: true, port: 8768 });

    // Each Chrome profile owns independent extension storage. Selecting Alpha in a
    // different profile cannot silently retarget Zeta's saved companion or bridge.
    const AlphaStorage = new FakeStorageArea();
    const AlphaWorker = loadWorker({ local: AlphaStorage, session: new FakeStorageArea(), fetch });
    expect(await AlphaWorker.send({ type: 'status' })).toMatchObject({
      connected: false, paired: false, instanceError: 'instance_selection_required'
    });
    expect(await AlphaWorker.send({ type: 'pairTo', instanceId: 'profile-Alpha' }, 1, undefined, popupUrl))
      .toMatchObject({ ok: true });
    expect(pairPorts).toEqual([8768, 8767]);
    expect(AlphaStorage.data).toMatchObject({
      port: 8767, instanceId: 'profile-Alpha', token: 'profile-Alpha-token'
    });
    expect(ZetaStorage.data).toMatchObject({ port: 8768, instanceId: 'profile-Zeta', token: 'profile-Zeta-token' });
  });

  it('offers private development alongside installed legacy and pairs only the chosen dev port', async () => {
    const devInstanceId = 'dev-0123456789abcdef01234567';
    const pairPorts: number[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      const candidate = Number(url.port);
      if (url.pathname === '/hello') {
        if (candidate === 8765) return response(200, { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL,
          instanceId: 'local-instance', displayName: 'Local Windows', legacyInstance: true, paired: true });
        if (candidate === 8796) return response(200, { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL,
          instanceId: devInstanceId, displayName: 'Local Windows (Dev 8796)', legacyInstance: false, paired: false });
      }
      if (url.pathname === '/pair') {
        pairPorts.push(candidate);
        expect(candidate).toBe(8796);
        expect(JSON.parse(String(init.body))).toEqual({ reconnect: true, instanceId: devInstanceId });
        return response(200, { token: 'isolated-dev-only-token', instanceId: devInstanceId });
      }
      return response(503, {});
    });
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });
    expect(await worker.send({ type: 'status' })).toMatchObject({
      connected: false, paired: false, instanceId: null, instanceError: 'instance_selection_required'
    });
    expect(pairPorts).toEqual([]);
    const popupUrl = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const choices = await worker.send({ type: 'accountChoices' }, 1, undefined, popupUrl);
    expect(choices.accounts).toEqual(expect.arrayContaining([
      { instanceId: 'local-instance', name: 'Local Windows', port: 8765, legacy: true, compatible: true },
      { instanceId: devInstanceId, name: 'Local Windows (Dev 8796)', port: 8796, legacy: false, compatible: true }
    ]));
    expect(await worker.send({ type: 'pairTo', instanceId: devInstanceId }, 1, undefined, popupUrl))
      .toMatchObject({ ok: true });
    expect(pairPorts).toEqual([8796]);
    expect(local.data).toMatchObject({ instanceId: devInstanceId, port: 8796, token: 'isolated-dev-only-token' });
  });

  it('does not let a popup pairing request waiting on dev /hello override a later Disconnect', async () => {
    const devId = 'dev-0123456789abcdef01234567';
    let reachedDevHello!: () => void;
    let releaseDevHello!: () => void;
    const started = new Promise<void>(resolve => { reachedDevHello = resolve; });
    const pendingHello = new Promise<void>(resolve => { releaseDevHello = resolve; });
    const pairPorts: number[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8796') {
        reachedDevHello();
        await pendingHello;
        return response(200, { app: 'chat-on-steroids', instanceId: devId, paired: false });
      }
      if (url.pathname === '/hello' && url.port === '8765')
        return response(200, { app: 'chat-on-steroids', instanceId: 'local-instance', paired: true, legacyInstance: true });
      if (url.pathname === '/pair') {
        pairPorts.push(Number(url.port));
        return response(200, { instanceId: devId, token: 'stale-dev-token' });
      }
      return response(503, {});
    });
    const local = new FakeStorageArea({ port: 8765, instanceId: 'local-instance', token: 'existing-prod-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';

    const stalePair = worker.send({ type: 'pairTo', instanceId: devId }, 1, undefined, popup);
    await started;
    expect(await worker.send({ type: 'unpair' })).toMatchObject({ ok: true });
    releaseDevHello();
    expect(await stalePair).toMatchObject({ ok: false });
    expect(pairPorts).toEqual([]);
    expect(local.data).toMatchObject({ port: 8765, instanceId: 'local-instance', token: null, disconnected: true });
    expect(await worker.send({ type: 'status' })).toMatchObject({ paired: false, disconnected: true });
    expect(pairPorts).toEqual([]);
  });

  it('allows only the newest of two popup pairTo account intents to retarget the profile', async () => {
    const devId = 'dev-0123456789abcdef01234567';
    let reachedDevHello!: () => void;
    let releaseDevHello!: () => void;
    const started = new Promise<void>(resolve => { reachedDevHello = resolve; });
    const pendingHello = new Promise<void>(resolve => { releaseDevHello = resolve; });
    const pairPorts: number[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8796') {
        reachedDevHello();
        await pendingHello;
        return response(200, { app: 'chat-on-steroids', instanceId: devId, paired: false });
      }
      if (url.pathname === '/hello' && url.port === '8768')
        return response(200, { app: 'chat-on-steroids', instanceId: 'profile-Zeta', paired: false });
      if (url.pathname === '/pair') {
        pairPorts.push(Number(url.port));
        return response(200, { instanceId: url.port === '8796' ? devId : 'profile-Zeta', token: 'latest-Zeta-token' });
      }
      return response(503, {});
    });
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const older = worker.send({ type: 'pairTo', instanceId: devId }, 1, undefined, popup);
    await started;
    const newer = worker.send({ type: 'pairTo', instanceId: 'profile-Zeta' }, 1, undefined, popup);
    // Permit the second message to register its intent before the original /hello resolves.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    releaseDevHello();
    expect(await older).toMatchObject({ ok: false });
    expect(await newer).toMatchObject({ ok: true });
    expect(pairPorts).toEqual([8768]);
    expect(local.data).toMatchObject({ instanceId: 'profile-Zeta', port: 8768,
      token: 'latest-Zeta-token', disconnected: false });
  });

  it('persists a later Disconnect after a pending popup retarget storage write', async () => {
    const devId = 'dev-0123456789abcdef01234567';
    let startedWriting!: () => void;
    let releaseWrite!: () => void;
    const started = new Promise<void>(resolve => { startedWriting = resolve; });
    const gate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const local = new FakeStorageArea({ port: 8765, instanceId: 'local-instance', token: 'prod-token' });
    const actualSet = local.set.bind(local);
    local.set = async values => {
      if (values.port === 8796 && values.instanceId === devId && values.token === null) {
        startedWriting();
        await gate;
      }
      await actualSet(values);
    };
    const pairPorts: number[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8796')
        return response(200, { app: 'chat-on-steroids', instanceId: devId, paired: false });
      if (url.pathname === '/hello' && url.port === '8765')
        return response(200, { app: 'chat-on-steroids', instanceId: 'local-instance', paired: true });
      if (url.pathname === '/pair') {
        pairPorts.push(Number(url.port));
        return response(200, { instanceId: devId, token: 'must-not-pair' });
      }
      return response(503, {});
    });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const pendingPair = worker.send({ type: 'pairTo', instanceId: devId }, 1, undefined, popup);
    await started;
    const disconnecting = worker.send({ type: 'unpair' });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    releaseWrite();
    expect(await disconnecting).toMatchObject({ ok: true });
    expect(await pendingPair).toMatchObject({ ok: false });
    expect(pairPorts).toEqual([]);
    expect(local.data.token).toBeNull();
    expect(local.data.disconnected).toBe(true);
    const restored = loadWorker({ local, session: new FakeStorageArea(), fetch });
    expect(await restored.send({ type: 'status' })).toMatchObject({ paired: false, disconnected: true });
  });

  it('can explicitly correct a Chrome profile previously paired to the wrong account', async () => {
    const pairPorts: number[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      const candidate = Number(url.port);
      if (url.pathname === '/hello' && (candidate === 8765 || candidate === 8768)) {
        return response(200, {
          app: 'chat-on-steroids', instanceId: candidate === 8765 ? 'local-instance' : 'profile-Zeta',
          displayName: candidate === 8765 ? 'Primary' : 'Zeta', legacyInstance: candidate === 8765,
          paired: candidate === 8765, bridge: BRIDGE_PROTOCOL
        });
      }
      if (url.pathname === '/pair') {
        pairPorts.push(candidate);
        return response(200, { token: 'Zeta-token', instanceId: 'profile-Zeta' });
      }
      return response(503, {});
    });
    const local = new FakeStorageArea({ instanceId: 'local-instance', port: 8765, token: 'Primary-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });
    expect(await worker.send({ type: 'status' })).toMatchObject({ connected: true, paired: true, port: 8765 });
    const popupUrl = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-Zeta' }, 1, undefined, popupUrl))
      .toMatchObject({ ok: true });
    expect(pairPorts).toEqual([8768]);
    expect(local.data).toMatchObject({ instanceId: 'profile-Zeta', port: 8768, token: 'Zeta-token' });
  });

  const currentPairingPage = async () => ({ ok: true, epoch: 0, streaming: false, generating: false, pendingTools: 0 });

  const legacyFirstBindingStorage = (changes: {
    local?: Record<string, unknown>;
    session?: Record<string, unknown>;
    row?: Record<string, unknown>;
    event?: Record<string, unknown>;
    close?: Record<string, unknown>;
    sessionClose?: Record<string, unknown>;
  } = {}) => {
    const conversationId = '11111111-2222-3333-4444-555555555557';
    const close = { conversationId, queuedAt: 1_700_000_000_000, ...changes.close };
    const sessionClose = { ...close, ...changes.sessionClose };
    const observation = {
      conversationId, provisional: null, agent: null, agentCommandId: null, project: null,
      enrollmentHeld: true,
      event: { kind: 'assistant_message', time: 1_700_000_000_001,
        text: 'preserved unassigned history', ...changes.event },
      ...changes.row
    };
    return {
      conversationId,
      local: new FakeStorageArea({ browserId: 'a'.repeat(32), closeOutbox: [close], ...changes.local }),
      session: new FakeStorageArea({
        journal: [observation], closeOutbox: [sessionClose], recoveryMonitoring: true,
        terminalDocuments: { '51': 'legacy-first-bind-document' },
        tabDocuments: { '51': 'legacy-first-bind-document' }, tabEpochs: { '51': 4 }, tabConversations: {},
        ...changes.session
      })
    };
  };

  const prospectiveFirstBindingStorage = (changes: {
    local?: Record<string, unknown>;
    session?: Record<string, unknown>;
    source?: Record<string, unknown>;
    sessionSource?: Record<string, unknown>;
  } = {}) => {
    const conversationId = '11111111-2222-3333-4444-555555555558';
    const browserId = 'b'.repeat(32);
    const source = { version: 1, browserId, tab: 61, documentId: 'prospective-document',
      navigationEpoch: 7, ...changes.source };
    const sessionSource = { ...source, ...changes.sessionSource };
    const localClose = { conversationId, queuedAt: 1_700_000_000_100, firstEnrollmentSource: source };
    const sessionClose = { ...localClose, firstEnrollmentSource: sessionSource };
    const observation = { conversationId, provisional: null, agent: null, agentCommandId: null, project: null,
      event: { kind: 'assistant_message', time: 1_700_000_000_101, text: 'prospectively retained history' } };
    return {
      local: new FakeStorageArea({ browserId, closeOutbox: [localClose], ...changes.local }),
      session: new FakeStorageArea({
        journal: [observation], closeOutbox: [sessionClose], recoveryMonitoring: true,
        terminalDocuments: { '61': 'prospective-document' }, tabDocuments: { '61': 'prospective-document' },
        tabEpochs: { '61': 7 }, tabConversations: {}, ...changes.session
      })
    };
  };

  it.each([{ id: 'profile-business', port: '8770' }, { id: 'profile-Epsilon', port: '8771' }])
  ('enrolls a never-bound observer journal only into the explicitly selected $id after durable pairing', async ({ id, port }) => {
    const observation = { conversationId: '11111111-2222-3333-4444-555555555555',
      provisional: null, agent: null, agentCommandId: null, project: null,
      event: { kind: 'assistant_message', time: Date.now(), text: 'original private observation', messageId: 'native-message' } };
    const local = new FakeStorageArea({ popupAccountChoiceInstanceId: id === 'profile-business' ? 'profile-Epsilon' : 'profile-business' });
    const session = new FakeStorageArea({ journal: [observation] });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let delivered: unknown = null;
    const pairPorts: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && ['8770', '8771'].includes(url.port)) return response(200, {
        app: 'chat-on-steroids', instanceId: url.port === '8770' ? 'profile-business' : 'profile-Epsilon', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') {
        pairPorts.push(url.port);
        expect(JSON.parse(String(init.body))).toEqual({ reconnect: true, instanceId: id });
        return response(200, { token: 'new-exact-account-token', instanceId: id });
      }
      if (url.pathname === '/events') {
        expect(url.port).toBe(port);
        delivered = JSON.parse(String(init.body));
        await held;
        return response(200, { ok: true });
      }
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: id }, 1, 'settings-document', 'https://chatgpt.com/');
    if (!result.ok) { release(); expect(result).toEqual({ ok: true }); }
    expect(result).toEqual({ ok: true });
    expect(local.data).toMatchObject({ instanceId: id, port: Number(port), token: 'new-exact-account-token', disconnected: false });
    expect(pairPorts).toEqual([port]);
    await vi.waitFor(() => expect(delivered).not.toBeNull());
    expect(session.data.journal).toEqual([observation]);
    expect(delivered).toMatchObject({ conversationId: observation.conversationId, events: [observation.event] });
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsSendMessage.mock.calls.every(([, message]) => message.type === 'clf-page-status')).toBe(true);
    expect(fetch.mock.calls.some(([input]) => /\/(input|commands|goal)\//.test(new URL(input).pathname))).toBe(false);
    release();
    await vi.waitFor(() => expect(session.data.journal).toEqual([]));
  });

  it('enrolls a prospectively proved never-bound ordinary close and drains observations before closing', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555556';
    const local = new FakeStorageArea({ popupAccountChoiceInstanceId: 'profile-Epsilon' });
    const session = new FakeStorageArea();
    const delivered: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, {
        instanceId: 'profile-business', token: 'prospective-close-token'
      });
      if (url.pathname === '/events') {
        delivered.push('events');
        expect(JSON.parse(String(init.body))).toMatchObject({ conversationId,
          events: [{ kind: 'assistant_message', text: 'retained before first enrollment' }] });
        return response(200, { ok: true });
      }
      if (url.pathname === '/closed') {
        delivered.push('closed');
        expect(JSON.parse(String(init.body))).toEqual({ conversationId, manual: true });
        return response(200, { ok: true });
      }
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    expect(await worker.send({
      type: 'events', conversationId,
      entries: [{ conversationId, event: { kind: 'assistant_message', time: Date.now(),
        text: 'retained before first enrollment' } }]
    }, 41, 'first-enrollment-close-document')).toMatchObject({ ok: true, durable: true, pending: 1 });

    await worker.closeTab(41);
    expect(local.data.closeOutbox).toEqual([expect.objectContaining({ conversationId })]);
    expect(session.data.journal).toHaveLength(1);
    // MV3 service-worker restart preserves session storage. The durable local/session marker,
    // not in-memory knowledge from the close, must be what keeps this exact proof usable.
    const restarted = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    expect(await restarted.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup))
      .toEqual({ ok: true });
    await vi.waitFor(() => expect(delivered).toEqual(['events', 'closed']));
    expect(local.data.closeOutbox).toEqual([]);
    expect(session.data.journal).toEqual([]);
  });

  it.each([
    { name: 'a marker with an unknown key', changes: { source: { unknownOwner: 'private' } } },
    { name: 'different local and session markers', changes: { sessionSource: { documentId: 'other-document' } } },
    { name: 'a foreign browser marker', changes: { source: { browserId: 'c'.repeat(32) } } },
    { name: 'a mismatched terminal document', changes: { session: { terminalDocuments: { '61': 'other-document' } } } },
    { name: 'a late raw tuple', changes: { local: { token: null } } },
    { name: 'a late native receipt', changes: { session: { pendingInputReceipts: { private: { owner: 'late' } } } } },
    { name: 'a late delivery result', changes: { session: { delivery: { at: 2, total: 1, ok: true } } } },
    { name: 'a retired-document owner', changes: { session: { retiredDocuments: { old: { private: true } } } } },
    { name: 'a retained operation owner', changes: { session: { projectCreateOwner: { nonce: 'private-owner' } } } }
  ])('does not use prospective first-enrollment proof across $name', async ({ changes }) => {
    const { local, session } = prospectiveFirstBindingStorage(changes);
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html');
    expect(result).toMatchObject({ ok: false, error: 'account_busy' });
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it('rejects a cached prospective enrollment when a retired-document owner appears before raw acceptance', async () => {
    const { local, session } = prospectiveFirstBindingStorage();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, {
        instanceId: 'profile-business', token: 'must-not-bind-after-retirement'
      });
      if (url.pathname === '/events' || url.pathname === '/closed') return response(200, { ok: true });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    expect(await worker.send({ type: 'accountChoices' }, 1, undefined, popup)).toMatchObject({ ok: true });
    const beforeJournal = structuredClone(session.data.journal);
    const beforeCloses = structuredClone(session.data.closeOutbox);
    await session.set({ retiredDocuments: { 'late-document': { owner: 'foreign-retirement' } } });

    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup))
      .toMatchObject({ ok: false, error: 'account_busy' });
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
    expect(session.data.journal).toEqual(beforeJournal);
    expect(session.data.closeOutbox).toEqual(beforeCloses);
  });

  it('fails closed when only one durable store accepts a prospective ordinary-close marker', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555559';
    const local = new FakeStorageArea(), session = new FakeStorageArea();
    const sessionSet = session.set.bind(session);
    session.set = async values => {
      if (Array.isArray(values.closeOutbox) && values.closeOutbox.some((row: any) => row?.firstEnrollmentSource))
        throw new Error('simulated session persistence failure');
      await sessionSet(values);
    };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    expect(await worker.send({ type: 'events', conversationId, entries: [{ conversationId,
      event: { kind: 'assistant_message', time: Date.now(), text: 'preserve despite failed marker write' } }] },
    62, 'prospective-write-failure-document')).toMatchObject({ ok: true, durable: true });
    await worker.closeTab(62);
    await vi.waitFor(() => expect(local.data.closeOutbox).toEqual([
      expect.objectContaining({ conversationId, firstEnrollmentSource: expect.any(Object) })
    ]));
    expect(local.data.closeOutbox).toEqual([expect.objectContaining({ conversationId, firstEnrollmentSource: expect.any(Object) })]);
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html'))
      .toMatchObject({ ok: false, error: 'account_busy' });
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it('offers preservation-only recovery for unassigned history without inventing terminal proof', async () => {
    const { local, session } = legacyFirstBindingStorage({ session: {
      recoveryMonitoring: false, terminalDocuments: {},
      tabConversations: { '51': '11111111-2222-3333-4444-555555555557' }
    }, row: { legacyScope: { label: 'original unknown field', originalAccount: null } } });
    const journalBefore = structuredClone(session.data.journal);
    const closesBefore = structuredClone(local.data.closeOutbox);
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(result).toMatchObject({ ok: false, error: 'account_history_preservation_required',
      operatorPreservation: { version: 1, targetInstanceId: 'profile-business', journalCount: 1, ordinaryCloseCount: 1 } });
    expect(result.operatorPreservation.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(session.data.journal).toEqual(journalBefore);
    expect(local.data.closeOutbox).toEqual(closesBefore);
    expect(session.data.terminalDocuments).toEqual({});
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/original unknown field|originalAccount|11111111/);
  });

  it.each([
    { choice: 'profile-business', observations: false },
    { choice: 'profile-Epsilon', observations: true },
    { choice: 'a'.repeat(64), observations: false }
  ])('treats a bounded popup account choice as UI preference during history preservation ($choice)', async ({ choice, observations }) => {
    const { local, session } = legacyFirstBindingStorage({
      local: { commandLeaseGeneration: 'c'.repeat(32), popupAccountChoiceInstanceId: choice },
      session: { recoveryMonitoring: false, terminalDocuments: {}, ...(observations ? {} : { journal: [] }) }
    });
    const before = { local: structuredClone(local.data), session: structuredClone(session.data) };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html');
    expect(result).toMatchObject({ ok: false, error: 'account_history_preservation_required',
      operatorPreservation: { version: 1, targetInstanceId: 'profile-business',
        journalCount: observations ? 1 : 0, ordinaryCloseCount: 1 } });
    expect(result).not.toHaveProperty('operatorAdoption');
    expect(result).not.toHaveProperty('historyPreservationReason');
    expect(local.data).toEqual(before.local);
    expect(session.data).toEqual(before.session);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it.each(['', 'a'.repeat(65), 'Profile Business', null, true, ['profile-business'], { instanceId: 'profile-business' }]
    .map(choice => ({ choice })))
  ('holds malformed popup account choice data without expanding the local allowlist ($choice)', async ({ choice }) => {
    const { local, session } = legacyFirstBindingStorage({
      local: { commandLeaseGeneration: 'c'.repeat(32), popupAccountChoiceInstanceId: choice },
      session: { recoveryMonitoring: false, terminalDocuments: {} }
    });
    const before = { local: structuredClone(local.data), session: structuredClone(session.data) };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html');
    expect(result).toMatchObject({ ok: false, error: 'account_busy', historyPreservationReason: 'local_fields_unsupported',
      historyPreservationCounts: { unsupportedLocalFields: 1 } });
    expect(result).not.toHaveProperty('operatorAdoption');
    expect(result).not.toHaveProperty('operatorPreservation');
    expect(local.data).toEqual(before.local);
    expect(session.data).toEqual(before.session);
    expect(JSON.stringify(result)).not.toContain('popupAccountChoiceInstanceId');
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it('permits preservation beside the fresh idle record written by the actual browser-control owner', async () => {
    const { local, session } = legacyFirstBindingStorage({
      local: { commandLeaseGeneration: 'c'.repeat(32), popupAccountChoiceInstanceId: 'profile-Epsilon' },
      session: { journal: [], recoveryMonitoring: false, terminalDocuments: {} }
    });
    const controlSource = (await fs.readFile(path.join(process.cwd(), 'extension', 'browser-control.js'), 'utf8'))
      .replace(/^import .*$/gm, '').replace('export function createBrowserControl', 'function createBrowserControl');
    const control = vm.runInNewContext(`${controlSource}; createBrowserControl(chrome, transport);`, {
      chrome: { storage: { session } }, transport: vi.fn(), crypto: webcrypto
    });
    await control.ready();
    expect(session.data.cosBrowserControl).toEqual({ browserId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      epoch: null, receipt: null, tabs: [] });
    const before = { local: structuredClone(local.data), session: structuredClone(session.data) };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html');
    expect(result).toMatchObject({ ok: false, error: 'account_history_preservation_required',
      operatorPreservation: { version: 1, targetInstanceId: 'profile-business', journalCount: 0, ordinaryCloseCount: 1 } });
    expect(result).not.toHaveProperty('operatorAdoption');
    expect(local.data).toEqual(before.local);
    expect(session.data).toEqual(before.session);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it.each([
    { epoch: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    { receipt: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', result: { ok: true } } },
    { tabs: [{ tabId: 91, owner: 'private owner', lease: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }] },
    { browserId: 'invalid id' }, { privateField: 'private data' }, { tabs: {} }
  ])('holds prior, malformed or active browser-control custody during preservation (%j)', async changes => {
    const { local, session } = legacyFirstBindingStorage({
      local: { commandLeaseGeneration: 'c'.repeat(32), popupAccountChoiceInstanceId: 'profile-business' },
      session: { journal: [], recoveryMonitoring: false, terminalDocuments: {}, cosBrowserControl: {
        browserId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', epoch: null, receipt: null, tabs: [], ...changes
      } }
    });
    const before = { local: structuredClone(local.data), session: structuredClone(session.data) };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html');
    expect(result).toMatchObject({ ok: false, error: 'account_busy', historyPreservationReason: 'session_fields_unsupported',
      historyPreservationCounts: { unsupportedLocalFields: 0, unsupportedSessionFields: 1 } });
    expect(result).not.toHaveProperty('operatorPreservation');
    expect(result).not.toHaveProperty('operatorAdoption');
    expect(local.data).toEqual(before.local);
    expect(session.data).toEqual(before.session);
    expect(JSON.stringify(result)).not.toMatch(/cosBrowserControl|private owner|privateField|private data|invalid id|aaaaaaaa/);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it.each([false, true])('diagnoses preservation independently of monitoring-off adoption (unsupported session field=%s)', async unsupported => {
    const { local, session, conversationId } = legacyFirstBindingStorage({ local: { popupAccountChoiceInstanceId: 'profile-Epsilon' }, session: {
      recoveryMonitoring: false, terminalDocuments: {},
      tabDocuments: { '51': 'private-document-1', '52': 'private-document-2', '53': 'private-document-3', '54': 'private-document-4' },
      tabEpochs: { '51': 1, '52': 2, '53': 3, '54': 4 },
      tabConversations: { '51': '11111111-2222-3333-4444-555555555557', '52': '11111111-2222-3333-4444-555555555558' },
      ...(unsupported ? { privateUnknownStorageField: { token: 'private storage token' } } : {})
    } });
    session.data.journal = [...session.data.journal as unknown[], { conversationId, provisional: null, agent: null,
      agentCommandId: null, enrollmentHeld: true,
      event: { kind: 'progress', time: 1_700_000_000_002, text: 'private preserved second observation' } }];
    const before = { journal: structuredClone(session.data.journal), closes: structuredClone(local.data.closeOutbox) };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html');
    expect(result).toMatchObject({ ok: false, error: unsupported ? 'account_busy' : 'account_history_preservation_required',
      historyEligibility: 'terminal_mismatch', historyTerminalReason: 'monitoring_off' });
    if (unsupported) {
      expect(result).toMatchObject({ historyPreservationReason: 'session_fields_unsupported',
        historyPreservationCounts: { unsupportedSessionFields: 1, journalEntries: 2, closeReceipts: 1,
          documentEntries: 4, epochEntries: 4, conversationEntries: 2, terminalEntries: 0 } });
      expect(result.message).toContain('History preservation diagnostic: session_fields_unsupported');
      expect(result).not.toHaveProperty('operatorPreservation');
    } else {
      expect(result.operatorPreservation).toMatchObject({ journalCount: 2, ordinaryCloseCount: 1 });
      expect(result).not.toHaveProperty('historyPreservationReason');
    }
    expect(session.data.journal).toEqual(before.journal);
    expect(local.data.closeOutbox).toEqual(before.closes);
    expect(JSON.stringify(result)).not.toMatch(/private-|private storage|privateUnknownStorageField|private preserved|11111111/);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it.each([
    { name: 'unsupported local fields', reason: 'local_fields_unsupported', changes: { local: { privateStorageField: 'private token' } } },
    { name: 'retained operation custody', reason: 'active_custody', changes: { session: { delivery: { at: 1, total: 1, ok: true } } } },
    { name: 'invalid document shape', reason: 'document_shape', changes: { session: { tabDocuments: { '51': '' } } } },
    { name: 'unmatched document epoch', reason: 'document_map_mismatch', changes: { session: { tabEpochs: {} } } },
    { name: 'observation owner', reason: 'observation_shape', changes: { event: { privateOwner: 'private operation' } } },
    { name: 'extension-authored close', reason: 'close_shape', changes: { close: { byExtension: true } } },
    { name: 'different close snapshots', reason: 'receipt_mismatch', changes: { sessionClose: { queuedAt: 1_700_000_000_999 } } }
  ])('explains preservation refusal without changing pairing custody: $name', async ({ changes, reason }) => {
    const { local, session } = legacyFirstBindingStorage({ ...changes,
      session: { recoveryMonitoring: false, terminalDocuments: {}, ...changes.session } });
    const before = { journal: structuredClone(session.data.journal), closes: structuredClone(local.data.closeOutbox) };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html');
    expect(result).toMatchObject({ ok: false, error: 'account_busy', historyPreservationReason: reason });
    expect(result).not.toHaveProperty('operatorAdoption');
    expect(result).not.toHaveProperty('operatorPreservation');
    expect(result.message).toContain(`History preservation diagnostic: ${reason}`);
    expect(result.message.match(/Recovery protocol 1\./g)).toHaveLength(1);
    expect(result.message.length).toBeLessThanOrEqual(2400);
    expect(session.data.journal).toEqual(reason === 'active_custody'
      ? (before.journal as Record<string, unknown>[]).map(row => ({ ...row, enrollmentCustodyUncertain: true })) : before.journal);
    expect(local.data.closeOutbox).toEqual(before.closes);
    expect(JSON.stringify(result)).not.toMatch(/privateStorageField|private token|privateOwner|private operation|preserved unassigned history|11111111/);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it('publishes only bounded own-data preservation diagnostics without invoking accessors', () => {
    const start = backgroundSource.indexOf('function accountBusyError(');
    const end = backgroundSource.indexOf('/** Reprove the exact isolated document', start);
    const getter = vi.fn(() => 'private diagnostic');
    const counts = { localFields: 99999, sessionFields: null, unsupportedLocalFields: 0, unsupportedSessionFields: 1,
      journalEntries: 2, closeReceipts: 1, documentEntries: 4, epochEntries: 4, conversationEntries: 2, terminalEntries: 0,
      privateStorageField: 'private token' };
    const scenarios = [
      { value: { preservationRefusal: 'session_fields_unsupported', preservationCounts: counts },
        expected: { historyPreservationReason: 'session_fields_unsupported', historyPreservationCounts: {
          localFields: 4000, sessionFields: null, unsupportedLocalFields: 0, unsupportedSessionFields: 1,
          journalEntries: 2, closeReceipts: 1, documentEntries: 4, epochEntries: 4, conversationEntries: 2, terminalEntries: 0 } } },
      { value: { preservationRefusal: 'private diagnostic', preservationCounts: counts }, expected: {} },
      { value: Object.assign(Object.create({ preservationRefusal: 'active_custody' }), { preservationCounts: counts }), expected: {} },
      { value: Object.defineProperty({ preservationCounts: counts }, 'preservationRefusal', { get: getter }), expected: {} },
      { value: { preservationRefusal: 'active_custody', preservationCounts: Object.create(counts) },
        expected: { historyPreservationReason: 'active_custody' } },
      { value: Object.defineProperty({ preservationRefusal: 'active_custody' }, 'preservationCounts', { get: getter }),
        expected: { historyPreservationReason: 'active_custody' } },
      { value: { preservationRefusal: 'active_custody',
        preservationCounts: Object.defineProperty({ ...counts }, 'journalEntries', { get: getter }) },
        expected: { historyPreservationReason: 'active_custody' } },
      ...[-1, 0.5, Infinity, 'private count'].map(value => ({ value: { preservationRefusal: 'active_custody',
        preservationCounts: { ...counts, epochEntries: value } }, expected: { historyPreservationReason: 'active_custody' } }))
    ];
    for (const scenario of scenarios) {
      const result = vm.runInNewContext(`${backgroundSource.slice(start, end)}; accountBusyError({ journal: 2 }, diagnostic);`,
        { diagnostic: scenario.value });
      expect(result).toMatchObject(scenario.expected);
      for (const key of ['historyPreservationReason', 'historyPreservationCounts']) {
        if (!(key in scenario.expected)) expect(result).not.toHaveProperty(key);
      }
      expect(JSON.stringify(result)).not.toMatch(/private diagnostic|privateStorageField|private token/);
      expect(result).not.toHaveProperty('operatorPreservation');
      expect(result).not.toHaveProperty('operatorAdoption');
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['sealed_custody', 'prior_binding', 'active_custody', 'timeout', 'snapshot_read_failed',
    'snapshot_changed', 'memory_mismatch', 'invalid_snapshot'])
  ('keeps preservation snapshot refusal %s per-call and non-authorizing', async reason => {
    const start = backgroundSource.indexOf('async function unassignedHistorySnapshot(');
    const end = backgroundSource.indexOf('function sameUnassignedHistoryMemory(', start);
    const context = {
      unassignedHistoryUncertain: false, sealedUnassignedHistory: reason === 'sealed_custody' ? {} : null,
      instanceId: reason === 'prior_binding' ? 'private old account' : null, port: null, token: null, disconnected: false,
      pairing: false, journalWorkers: new Set(), maintenanceFlight: reason === 'active_custody' ? Promise.resolve() : null,
      modelCatalogFlight: null, pluginRefreshFlight: null, projectCreateFlight: null, deferredRecoveryWork: false,
      connectionEpoch: 1, liveWriteQueue: Promise.resolve(), journalWriteQueue: Promise.resolve(), connectionPersistTail: Promise.resolve(),
      readUnassignedHistoryStores: async () => {
        if (reason === 'timeout') return null;
        if (reason === 'snapshot_read_failed') throw new Error('private path/token/read exception');
        if (reason === 'snapshot_changed') context.connectionEpoch++;
        return [{ private: 'private stored data' }, { private: 'private live data' }];
      },
      cloneUnassignedHistoryData: (value: unknown) => {
        if (reason === 'invalid_snapshot') throw new Error('private malformed storage');
        return value;
      },
      unassignedHistoryState: () => ({ journal: [], localCloseOutbox: [{}] }),
      sameUnassignedHistoryMemory: () => reason !== 'memory_mismatch',
      unassignedHistoryDigest: async () => 'f'.repeat(64), stableOperatorAdoptionJson: JSON.stringify,
      diagnostic: { preservationRefusal: null as string | null }
    };
    const result = await vm.runInNewContext(`${backgroundSource.slice(start, end)};
      unassignedHistorySnapshot('profile-business', diagnostic);`, context);
    expect(result).toBeNull();
    expect(context.diagnostic).toEqual({ preservationRefusal: reason });
    const publicationStart = backgroundSource.indexOf('function accountBusyError(');
    const publicationEnd = backgroundSource.indexOf('/** Reprove the exact isolated document', publicationStart);
    const publication = vm.runInNewContext(`${backgroundSource.slice(publicationStart, publicationEnd)};
      accountBusyError({ journal: 2 }, diagnostic);`, context);
    expect(publication.historyPreservationReason).toBe(reason);
    expect(JSON.stringify(publication)).not.toMatch(/private path|private old|private stored|private live|private malformed/);
    expect(publication).not.toHaveProperty('operatorPreservation');
    context.readUnassignedHistoryStores = async () => { throw new Error('later private exception'); };
    await vm.runInNewContext(`${backgroundSource.slice(start, end)};
      unassignedHistorySnapshot('profile-business', diagnostic);`, context);
    expect(context.diagnostic).toEqual({ preservationRefusal: reason });
  });

  it('seals exact unassigned data before pairing, holds old replay and delivers only a new chat across restart', async () => {
    const { local, session, conversationId } = legacyFirstBindingStorage({ local: { popupAccountChoiceInstanceId: 'profile-Epsilon' }, session: {
      recoveryMonitoring: false, terminalDocuments: {}, tabConversations: { '51': '11111111-2222-3333-4444-555555555557' }
    }, row: { legacyScope: { originalAccount: null, unknownLabel: 'kept verbatim' } },
    event: { legacyEvent: { retained: [null, 7, 'ordinary unknown data'] } }, close: { originalScope: null } });
    const originalJournal = structuredClone(session.data.journal);
    const originalCloses = structuredClone(local.data.closeOutbox);
    const paths: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') {
        expect(local.data.sealedUnassignedHistory).toMatchObject({ phase: 'committed',
          history: { journal: originalJournal, localCloseOutbox: originalCloses } });
        expect(local.data.closeOutbox).toEqual([]);
        expect(session.data.journal).toEqual([]);
        paths.push('pair');
        return response(200, { instanceId: 'profile-business', token: 'future-only-token' });
      }
      if (url.pathname === '/events') {
        expect(String(init.body)).not.toContain(conversationId);
        paths.push('events'); return response(200, { ok: true });
      }
      if (url.pathname === '/correlations') {
        expect(String(init.body)).not.toContain(conversationId);
        paths.push('correlations'); return response(200, { ok: true, confirmed: ['fresh-request'] });
      }
      if (url.pathname === '/closed') { paths.push('closed'); return response(200, { ok: true }); }
      return response(503, {});
    });
    const options = { local, session, fetch, tabsSendMessage: currentPairingPage };
    const worker = loadWorker(options);
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business',
      operatorPreservation: offer.operatorPreservation }, 1, undefined, popup)).toEqual({ ok: true });
    expect(paths).toEqual(['pair']);
    expect(local.data.popupAccountChoiceInstanceId).toBe('profile-Epsilon');
    expect(local.data.instanceId).toBe('profile-business');
    const archiveBefore = structuredClone(local.data.sealedUnassignedHistory);
    const restarted = loadWorker(options);
    expect(await restarted.send({ type: 'events', conversationId, entries: originalJournal }, 51))
      .toMatchObject({ ok: false, error: 'account_history_unassigned', durable: false });
    const newConversation = '11111111-2222-3333-4444-555555555559';
    expect(await restarted.send({ type: 'events', conversationId: newConversation, entries: [{
      conversationId: newConversation, event: { kind: 'user_message', time: Date.now(), text: 'new account work', messageId: 'new-native-user' }
    }] }, 52)).toMatchObject({ ok: true, durable: true });
    await vi.waitFor(() => expect(paths).toEqual(['pair', 'events']));
    expect(await restarted.send({ type: 'correlate', conversationId, calls: [{ requestId: 'old-request' }] }, 51))
      .toMatchObject({ ok: false, error: 'account_history_unassigned' });
    expect(await restarted.send({ type: 'correlate', conversationId: newConversation,
      calls: [{ messageId: 'fresh-message', tool: 'read', order: 0, answered: false, requestId: 'fresh-request' }] }, 52))
      .toMatchObject({ ok: true, data: { confirmed: ['fresh-request'] } });
    expect(paths).toEqual(['pair', 'events', 'correlations']);
    expect(local.data.sealedUnassignedHistory).toEqual(archiveBefore);
    expect(session.data.journal).toEqual([]);
  });

  it.each(['seal-quota', 'unknown-owner', 'idle-root', 'stale-digest'])
  ('refuses preservation without clearing or pairing at %s boundary', async mode => {
    const { local, session } = legacyFirstBindingStorage({ session: { recoveryMonitoring: false, terminalDocuments: {} } });
    const paths: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      paths.push(url.pathname); return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(offer.error).toBe('account_history_preservation_required');
    const before = structuredClone(session.data.journal);
    if (mode === 'seal-quota') local.maxBytes = JSON.stringify(local.data).length + 10;
    if (mode === 'unknown-owner') session.data.unrecognizedOperationOwner = { awaitingAck: true };
    if (mode === 'idle-root') session.data.idleRootTabs = { '51': { appOwned: true, owner: 'retained-operation' } };
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business', operatorPreservation: {
      ...offer.operatorPreservation, ...(mode === 'stale-digest' ? { snapshotDigest: 'f'.repeat(64) } : {})
    } }, 1, undefined, popup);
    expect(result.ok).toBe(false);
    expect(session.data.journal).toEqual(before);
    expect(local.data.closeOutbox).toHaveLength(1);
    expect(paths).not.toContain('/pair');
    expect(paths).not.toContain('/events');
    expect(paths).not.toContain('/closed');
  });

  it.each(['close-only'])('preserves %s custody without inventing the missing history half', async mode => {
    const { local, session } = legacyFirstBindingStorage({ session: { recoveryMonitoring: false, terminalDocuments: {} } });
    if (mode === 'close-only') session.data.journal = [];
    else { local.data.closeOutbox = []; session.data.closeOutbox = []; }
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, { instanceId: 'profile-business', token: 'future-only-token' });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(offer).toMatchObject({ error: 'account_history_preservation_required', operatorPreservation: {
      journalCount: mode === 'close-only' ? 0 : 1, ordinaryCloseCount: mode === 'close-only' ? 1 : 0
    } });
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business', operatorPreservation: offer.operatorPreservation },
      1, undefined, popup)).toEqual({ ok: true });
    expect(local.data.sealedUnassignedHistory).toMatchObject({ phase: 'committed', history: {
      journal: mode === 'close-only' ? [] : [{ event: { text: 'preserved unassigned history' } }],
      localCloseOutbox: mode === 'close-only' ? [{ queuedAt: 1_700_000_000_000 }] : []
    } });
    expect(fetch.mock.calls.some(([input]) => ['/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it.each(['seal', 'session-cutover', 'local-cutover', 'promotion'])
  ('keeps preservation crash boundary %s disconnected on cold load and never republishes archived data', async boundary => {
    const { local, session } = legacyFirstBindingStorage({ session: { recoveryMonitoring: false, terminalDocuments: {} } });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const options = { local, session, fetch, tabsSendMessage: currentPairingPage };
    const worker = loadWorker(options);
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    let failed = false;
    const localSet = local.set.bind(local);
    local.set = async values => {
      const archive = values.sealedUnassignedHistory as { phase?: string } | undefined;
      if (!failed && (boundary === 'seal' && archive?.phase === 'sealed' ||
          boundary === 'local-cutover' && Array.isArray(values.closeOutbox) && values.closeOutbox.length === 0 ||
          boundary === 'promotion' && archive?.phase === 'committed')) {
        failed = true; throw new Error('bounded crash boundary');
      }
      await localSet(values);
    };
    const sessionSet = session.set.bind(session);
    session.set = async values => {
      if (!failed && boundary === 'session-cutover' && values.unassignedHistoryGeneration) {
        failed = true; throw new Error('bounded crash boundary');
      }
      await sessionSet(values);
    };
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business', operatorPreservation: offer.operatorPreservation },
      1, undefined, popup)).toMatchObject({ ok: false, error: 'account_history_preservation_uncertain' });
    expect(failed).toBe(true);
    if (boundary !== 'seal') expect(local.data.sealedUnassignedHistory).toMatchObject({ phase: 'sealed',
      history: { journal: [{ event: { text: 'preserved unassigned history' } }], localCloseOutbox: [{ queuedAt: 1_700_000_000_000 }] } });
    const restarted = loadWorker(options);
    await restarted.send({ type: 'status' });
    await restarted.fireAlarm();
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
    if (boundary !== 'seal') expect(await restarted.send({ type: 'pairTo', instanceId: 'profile-business' },
      1, undefined, popup)).toMatchObject({ ok: false, error: 'account_history_preservation_uncertain' });
  });

  it('refuses unsafe history data without invoking getters, compacting or projecting ordinary unknown fields', () => {
    const start = backgroundSource.indexOf('function cloneUnassignedHistoryData(');
    const end = backgroundSource.indexOf('async function unassignedHistoryDigest(', start);
    const getter = vi.fn(() => 'must not read');
    const unsafe = [Object.defineProperty({}, 'text', { enumerable: true, get: getter }),
      { text: undefined }, { helper: () => true }, new Date(), Object.create({ inherited: true })];
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; unsafe.push(cyclic);
    for (const value of unsafe) expect(() => vm.runInNewContext(`${backgroundSource.slice(start, end)};
      cloneUnassignedHistoryData(value);`, { value, TextEncoder, stableOperatorAdoptionJson: JSON.stringify })).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const ordinary = { unknownScope: { original: null, labels: ['kept', 1, false] } };
    const result = vm.runInNewContext(`${backgroundSource.slice(start, end)}; cloneUnassignedHistoryData(value);`,
      { value: ordinary, TextEncoder, stableOperatorAdoptionJson: JSON.stringify });
    expect(result).toEqual(ordinary);
    expect(result).not.toBe(ordinary);
  });

  it.each([false, true])('retains malformed non-history census before normalization for %s close-only recovery', async closeOnly => {
    const { local, session } = legacyFirstBindingStorage({ local: { inputOpenings: ['malformed retained input'] },
      session: { recoveryMonitoring: false, terminalDocuments: {} } });
    if (closeOnly) session.data.journal = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const options = { local, session, fetch, tabsSendMessage: currentPairingPage };
    const worker = loadWorker(options);
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup))
      .toMatchObject({ ok: false, error: 'account_busy' });
    const negativeOwner = closeOnly ? local.data.closeOutbox : session.data.journal;
    expect(negativeOwner).toMatchObject([{ enrollmentCustodyUncertain: true }]);
    // Model the incumbent parsed-empty write, then restart: the existing history owner
    // must retain the earlier negative census without restoring private helper authority.
    local.data.inputOpenings = {};
    const restarted = loadWorker(options);
    const result = await restarted.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(result).toMatchObject({ ok: false, error: 'account_busy' });
    expect(result).not.toHaveProperty('operatorPreservation');
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it.each(['late-observation', 'disconnect'])('does not cross preservation seal after %s races its confirmation', async race => {
    const { local, session } = legacyFirstBindingStorage({ session: { recoveryMonitoring: false, terminalDocuments: {} } });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    const old = structuredClone(session.data.journal);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const set = local.set.bind(local);
    let sealed = false;
    local.set = async values => {
      await set(values);
      if ((values.sealedUnassignedHistory as { phase?: string })?.phase === 'sealed') { sealed = true; await held; }
    };
    const pending = worker.send({ type: 'pairTo', instanceId: 'profile-business', operatorPreservation: offer.operatorPreservation },
      1, undefined, popup);
    await vi.waitFor(() => expect(sealed).toBe(true));
    if (race === 'disconnect') await worker.send({ type: 'unpair' }, 1, undefined, popup);
    else await worker.send({ type: 'events', conversationId: '11111111-2222-3333-4444-555555555559', entries: [{
      conversationId: '11111111-2222-3333-4444-555555555559', event: { kind: 'assistant_message', time: Date.now(), text: 'late preserved row' }
    }] }, 52);
    release();
    expect((await pending).ok).toBe(false);
    expect(local.data.sealedUnassignedHistory).toMatchObject({ phase: 'sealed', history: { journal: old } });
    expect((session.data.journal as unknown[]).slice(0, (old as unknown[]).length)).toEqual(old);
    if (race === 'late-observation') expect(session.data.journal).toHaveLength(2);
    else expect(local.data.disconnected).toBe(true);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it('refuses an old packet suspended before preservation and resumed only after account pairing', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555557';
    const { local, session } = legacyFirstBindingStorage({ session: { recoveryMonitoring: false, terminalDocuments: {},
      tabDocuments: { '61': 'document-61-0' }, tabEpochs: { '61': 0 }, tabConversations: { '61': conversationId } } });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let probing = false;
    const paths: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') { paths.push('pair'); return response(200, { instanceId: 'profile-business', token: 'future-only-token' }); }
      if (['/events', '/closed'].includes(url.pathname)) { paths.push(url.pathname); return response(200, { ok: true }); }
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage,
      tabsGet: async tabId => { if (tabId === 61) { probing = true; await held; }
        return { id: tabId, url: `https://chatgpt.com/c/${conversationId}` }; } });
    const pending = worker.send({ type: 'events', conversationId, entries: [{ conversationId,
      event: { kind: 'assistant_message', time: Date.now(), text: 'suspended old packet' } }] }, 61);
    await vi.waitFor(() => expect(probing).toBe(true));
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(offer.error).toBe('account_history_preservation_required');
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business', operatorPreservation: offer.operatorPreservation },
      1, undefined, popup)).toEqual({ ok: true });
    release();
    expect(await pending).toMatchObject({ ok: false, error: 'account_history_unassigned', durable: false });
    expect(paths).toEqual(['pair']);
    expect(session.data.journal).toEqual([]);
    expect(local.data.sealedUnassignedHistory).toMatchObject({ history: { journal: [{ event: { text: 'preserved unassigned history' } }] } });
  });

  it('refuses an anonymous packet suspended across preservation and account pairing', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555557';
    const { local, session } = legacyFirstBindingStorage({ session: { recoveryMonitoring: false, terminalDocuments: {},
      tabDocuments: { '61': 'document-61-0' }, tabEpochs: { '61': 0 }, tabConversations: { '61': conversationId } } });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let probing = false;
    const paths: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') { paths.push('pair'); return response(200, { instanceId: 'profile-business', token: 'future-only-token' }); }
      if (['/events', '/closed'].includes(url.pathname)) { paths.push(url.pathname); return response(200, { ok: true }); }
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage,
      tabsGet: async tabId => { if (tabId === 61) { probing = true; await held; }
        return { id: tabId, url: `https://chatgpt.com/c/${conversationId}` }; } });
    const pending = worker.send({ type: 'events', conversationId: null, entries: [{ conversationId: null,
      event: { kind: 'assistant_message', time: Date.now(), text: 'suspended old packet' } }] }, 61);
    await vi.waitFor(() => expect(probing).toBe(true));
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(offer.error).toBe('account_history_preservation_required');
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business', operatorPreservation: offer.operatorPreservation },
      1, undefined, popup)).toEqual({ ok: true });
    release();
    expect(await pending).toMatchObject({ ok: false, error: 'account_history_unassigned', durable: false });
    expect(paths).toEqual(['pair']);
    expect(session.data.journal).toEqual([]);
    expect(local.data.sealedUnassignedHistory).toMatchObject({ history: { journal: [{ event: { text: 'preserved unassigned history' } }] } });
  });


  it('refuses a same-binding activity request suspended across preservation and account pairing', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555557';
    const { local, session } = legacyFirstBindingStorage({ session: { recoveryMonitoring: false, terminalDocuments: {},
      tabDocuments: { '61': 'document-61-0' }, tabEpochs: { '61': 0 }, tabConversations: { '61': conversationId } } });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let probing = false;
    const paths: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') { paths.push('pair'); return response(200, { instanceId: 'profile-business', token: 'future-only-token' }); }
      if (['/events', '/closed'].includes(url.pathname)) { paths.push(url.pathname); return response(200, { ok: true }); }
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage,
      tabsGet: async tabId => { if (tabId === 61) { probing = true; await held; }
        return { id: tabId, url: `https://chatgpt.com/c/${conversationId}` }; } });
    const pending = worker.send({ type: 'activity', conversationId, entries: [{ conversationId: null,
      event: { kind: 'assistant_message', time: Date.now(), text: 'suspended old packet' } }] }, 61);
    await vi.waitFor(() => expect(probing).toBe(true));
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(offer.error).toBe('account_history_preservation_required');
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business', operatorPreservation: offer.operatorPreservation },
      1, undefined, popup)).toEqual({ ok: true });
    release();
    expect(await pending).toMatchObject({ ok: false, error: 'account_history_unassigned', durable: false });
    expect(paths).toEqual(['pair']);
    expect(session.data.journal).toEqual([]);
    expect(local.data.sealedUnassignedHistory).toMatchObject({ history: { journal: [{ event: { text: 'preserved unassigned history' } }] } });
  });


  it.each(['activity', 'compact', 'goal_draft', 'goal_objective', 'goal_ack', 'settings_set',
    'conversation_deleted', 'desktop_input', 'focus_tab', 'closed', 'stop_redeem', 'stop_ack', 'redeem', 'defer_revival', 'ack'])(
    'refuses archived conversation authority through %s before HTTP', async type => {
      const { local, session, conversationId } = legacyFirstBindingStorage({ session: { recoveryMonitoring: false, terminalDocuments: {} } });
      const paths: string[] = [];
      const fetch = vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname === '/hello' && url.port === '8770') return response(200, {
          app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
        });
        if (url.pathname === '/pair') return response(200, { instanceId: 'profile-business', token: 'future-only-token' });
        paths.push(url.pathname);
        return response(200, { ok: true });
      });
      const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage,
        tabsGet: async id => ({ id, url: `https://chatgpt.com/c/${conversationId}` }) });
      const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
      const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
      expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business', operatorPreservation: offer.operatorPreservation },
        1, undefined, popup)).toEqual({ ok: true });
      await worker.registerTab(71);
      paths.length = 0;
      const result = await worker.send({ type, conversationId, token: 'draft-ticket', text: 'same ordinary goal', goal: true }, 71);
      expect(result).toMatchObject({ ok: false, error: 'account_history_unassigned' });
      expect(paths.filter(path => path !== '/status')).toEqual([]);
    });


  it.each([
    ['/commands/redeem', { conversationId: '11111111-2222-3333-4444-555555555557' }, false],
    ['/settings', null, true],
    ['/usage', { conversationId: '11111111-2222-3333-4444-555555555557' }, true],
    ['/project-create', { conversationId: '11111111-2222-3333-4444-555555555557' }, true]
  ] as const)('fences only established named request contracts during discovery: %s', async (path, body, remainsGlobal) => {
    const start = backgroundSource.indexOf('function conversationAdmission(');
    const end = backgroundSource.indexOf('function provision(', start);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    const fetchBounded = vi.fn(async () => response(200, { ok: true }));
    const context: Record<string, any> = {
      // Mirror the real connection tuple and incumbent repair registry read by the extracted owner.
      instanceId: 'fixture-instance', port: 8770, browserId: 'fixture-browser', desktopInputReceiverRepairs: new Map(),
      connectionEpoch: 1, unassignedHistoryGeneration: null, unassignedHistoryUncertain: false,
      token: 'fixture-token', disconnected: false, URL,
      cleanConversationId: (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{8,64}$/i.test(value) ? value : null,
      unassignedHistoryConversation: () => false, load: async () => undefined,
      discover: async () => { waiting = true; await held; return { port: 8770 }; },
      provision: vi.fn(), fetchBounded, versionHeaders: () => ({}), REQUEST_TIMEOUT_MS: 1000, TIMED_OUT: 'timeout',
      connectWakeSocket: () => undefined, forgetPort: vi.fn(), persist: vi.fn(), latchAppDisconnect: vi.fn()
    };
    const call = vm.runInNewContext(`${backgroundSource.slice(start, end)}; call`, context);
    const pending = call(path, body ? { method: 'POST', body: JSON.stringify(body) } : { method: 'GET' });
    await vi.waitFor(() => expect(waiting).toBe(true));
    context.connectionEpoch++;
    context.unassignedHistoryGeneration = 'new-preservation-generation';
    release();
    expect(await pending).toMatchObject(remainsGlobal ? { ok: true } : { ok: false, error: 'request_owner_changed' });
    expect(fetchBounded).toHaveBeenCalledTimes(remainsGlobal ? 1 : 0);
    expect(context.forgetPort).not.toHaveBeenCalled();
  });

  it('withdraws a suspended caller ACK before its local receipt mutation', async () => {
    const start = backgroundSource.indexOf('async function ackCommand(');
    const end = backgroundSource.indexOf('async function retireFailedCommandTab(', start);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    let admitted = true;
    const outbox: unknown[] = [];
    const context = {
      commandAckOutbox: outbox, load: async () => { waiting = true; await held; },
      conversationAdmissionRefusal: () => ({ ok: false, error: 'account_history_unassigned', durable: false }),
      commandAckPayload: vi.fn(), persistLive: vi.fn(), drainCommandAcks: vi.fn(), scheduleRetry: vi.fn()
    };
    const ack = vm.runInNewContext(`${backgroundSource.slice(start, end)}; ackCommand`, context);
    const pending = ack('old-command', 'sent', null, '11111111-2222-3333-4444-555555555557', null, 'old-client', null, undefined, () => admitted);
    await vi.waitFor(() => expect(waiting).toBe(true));
    admitted = false;
    release();
    expect(await pending).toMatchObject({ ok: false, error: 'account_history_unassigned', durable: false });
    expect(context.commandAckPayload).not.toHaveBeenCalled();
    expect(context.persistLive).not.toHaveBeenCalled();
    expect(context.drainCommandAcks).not.toHaveBeenCalled();
    expect(context.commandAckOutbox).toBe(outbox);
  });


  it.each([false, true])('excludes valid archived UUIDs regardless of letter case: uppercase stored=%s', async uppercaseStored => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const stored = uppercaseStored ? id.toUpperCase() : id;
    const requested = uppercaseStored ? id : id.toUpperCase();
    const { local, session } = legacyFirstBindingStorage({ row: { conversationId: stored }, close: { conversationId: stored },
      session: { recoveryMonitoring: false, terminalDocuments: {} } });
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, { instanceId: 'profile-business', token: 'future-only-token' });
      calls.push(url.pathname); return response(200, { ok: true });
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business', operatorPreservation: offer.operatorPreservation },
      1, undefined, popup)).toEqual({ ok: true });
    const archive = structuredClone(local.data.sealedUnassignedHistory);
    await worker.registerTab(71);
    calls.length = 0;
    expect(await worker.send({ type: 'goal_objective', conversationId: requested, text: 'must stay held' }, 71))
      .toMatchObject({ ok: false, error: 'account_history_unassigned' });
    expect(calls.filter(path => path !== '/status')).toEqual([]);
    expect(local.data.sealedUnassignedHistory).toEqual(archive);
    expect((local.data.sealedUnassignedHistory as { history: { journal: { conversationId: string }[] } })
      .history.journal[0]!.conversationId).toBe(stored);
  });

  it('withdraws nested activity revival acceptance before its inert marker save', async () => {
    const start = backgroundSource.indexOf('async function rememberDeferredRevival(');
    const end = backgroundSource.indexOf('async function forgetDeferredRevival(', start);
    const acceptStart = backgroundSource.indexOf('async function acceptBrowserRevival(');
    const acceptEnd = backgroundSource.indexOf('/**\n * Reconciles browser-persisted wake markers', acceptStart);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    let admitted = true;
    const context = {
      deferredRevivals: [] as unknown[], deferredRevivalOffers: new Map(),
      load: async () => { waiting = true; await held; }, cleanConversationId: (value: string) => value,
      deferredRevivalId: (value: string) => value,
      conversationAdmissionRefusal: () => ({ ok: false, error: 'account_history_unassigned' }),
      pruneDeferredRevivalOffers: vi.fn(), persistLive: vi.fn(async () => undefined)
    };
    const accept = vm.runInNewContext(`${backgroundSource.slice(start, end)};
      ${backgroundSource.slice(acceptStart, acceptEnd)}; acceptBrowserRevivals`, context);
    const pending = accept({ revival: { id: 'bounded-command', conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } }, () => admitted);
    await vi.waitFor(() => expect(waiting).toBe(true));
    admitted = false;
    release();
    expect(await pending).toBe(false);
    expect(context.deferredRevivals).toEqual([]);
    expect(context.persistLive).not.toHaveBeenCalled();
  });


  it.each(['placement', 'focus'])('withdraws %s before native mutation when its page probe crosses supported disconnect', async kind => {
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const { local, session } = legacyFirstBindingStorage({ session: { recoveryMonitoring: false, terminalDocuments: {},
      tabDocuments: { '61': 'document-61-0' }, tabEpochs: { '61': 0 }, tabConversations: {} } });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    let probes = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, { instanceId: 'profile-business', token: 'future-only-token' });
      if (url.pathname === '/activity') return response(200, { ok: true,
        placement: { id: '0123456789abcdef', homeConversationId: conversationId } });
      return response(200, { ok: true, automationPaused: false });
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage,
      tabsGet: async tabId => {
        if (tabId === 61 && ++probes === (kind === 'placement' ? 2 : 1)) { waiting = true; await held; }
        return { id: tabId, windowId: 7, index: 1, active: false, url: `https://chatgpt.com/c/${conversationId}` };
      } });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(offer.error).toBe('account_history_preservation_required');
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business', operatorPreservation: offer.operatorPreservation },
      1, undefined, popup)).toEqual({ ok: true });
    probes = 0;
    const pending = worker.send({ type: kind === 'placement' ? 'activity' : 'focus_tab', conversationId }, 61);
    await vi.waitFor(() => expect(waiting).toBe(true));
    expect(await worker.send({ type: 'unpair' })).toMatchObject({ ok: true });
    worker.tabsCreate.mockClear(); worker.tabsUpdate.mockClear(); worker.windowsUpdate.mockClear();
    release();
    expect(await pending).toMatchObject({ ok: false });
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
    expect(session.data.appOwnedOpeningTabs ?? {}).toEqual({});
  });


  it.each(['group', 'discard'])('retains %s custody when a withdrawn release probe rejects', async kind => {
    const start = backgroundSource.indexOf('async function releaseTab(');
    const end = backgroundSource.indexOf('\n}', start) + 2;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    let admitted = true;
    const fail = async () => { waiting = true; await held; throw new Error('native rejected after withdrawal'); };
    const context: Record<string, any> = {
      load: async () => undefined,
      conversationAdmissionRefusal: () => ({ ok: false, error: 'account_history_unassigned' }),
      commandTabLeases: {}, cosGroupedTabs: kind === 'group' ? { '61': true } : {}, browserControlsTab: () => false,
      protectedMainTabs: {}, appOwnedOpeningTabs: {}, idleRootTabs: {}, cleanConversationId: (value: unknown) => value ?? null,
      tabDocuments: { '61': 'same-document' }, tabEpochs: { '61': 0 }, journal: [], reloadProvisionalKey: () => null,
      tabConversations: { '61': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      discardProtectedTabs: kind === 'discard' ? { '61': true } : {}, chrome: { tabs: { ungroup: fail, update: fail } },
      persistLive: vi.fn(async () => undefined), persistJournal: vi.fn(async () => true)
    };
    const releaseTab = vm.runInNewContext(`${backgroundSource.slice(start, end)}; releaseTab`, context);
    const pending = releaseTab(61, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'same-document', 0, false, null, false, null, () => admitted);
    await vi.waitFor(() => expect(waiting).toBe(true)); admitted = false; release();
    expect(await pending).toMatchObject({ ok: false });
    expect(kind === 'group' ? context.cosGroupedTabs['61'] : context.discardProtectedTabs['61']).toBe(true);
    expect(context.persistLive).not.toHaveBeenCalled();
  });

  it('refuses the final desktop input receipt after a rejected withdrawn retirement probe', async () => {
    const start = backgroundSource.indexOf('  async desktop_input(');
    const end = backgroundSource.indexOf('  async register_document(', start);
    const helpers = backgroundSource.slice(backgroundSource.indexOf('function conversationAdmission('), backgroundSource.indexOf('function conversationRequestIdentity('));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    let reads = 0;
    const context: Record<string, any> = {
      connectionEpoch: 1, unassignedHistoryGeneration: null, unassignedHistoryUncertain: false,
      ownsDocument: () => true, unassignedHistoryConversation: () => false,
      cleanConversationId: (value: unknown) => value ?? null, tabConversations: {}, inputOpenings: {}, URL,
      conversationFromUrl: () => null, call: async () => ({ ok: true, data: { ok: true } }),
      chrome: { tabs: { get: async () => {
        if (++reads === 2) { waiting = true; await held; throw new Error('native rejected after withdrawal'); }
        return { url: 'https://chatgpt.com/?temporary-chat=true', pinned: false };
      } } }
    };
    const owner = vm.runInNewContext(`${helpers}; ({ ${backgroundSource.slice(start, end)} });`, context);
    const pending = owner.desktop_input({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', owner: '61:same-document:0',
      lifetime: 'temporary-planner', response: 'completed accepted answer' }, { documentId: 'same-document' },
      { tab: 61, documentId: 'same-document', navigationEpoch: 0 });
    await vi.waitFor(() => expect(waiting).toBe(true)); context.connectionEpoch++; release();
    expect(await pending).toMatchObject({ ok: false, error: 'account_history_unassigned' });
  });


  it.each([false, true])('checks caller admission after background-window preparation, default maintenance=%s', async maintenance => {
    const start = backgroundSource.indexOf('async function createChatTab(');
    const end = backgroundSource.indexOf('\n}', start) + 2;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    let admitted = true;
    const context = {
      inBackgroundWindow: async (run: () => unknown) => run(),
      backgroundTabWindow: async () => { waiting = true; await held; return 7; },
      chrome: { tabs: { create: vi.fn(async () => ({ id: 99 })) } },
      rememberAppOwnedOpeningTab: vi.fn(async () => undefined), rememberOpenConversationTab: vi.fn()
    };
    const create = vm.runInNewContext(`${backgroundSource.slice(start, end)}; createChatTab`, context);
    const pending = create('https://chatgpt.com/', true, false, null, 7, maintenance ? null : () => admitted);
    await vi.waitFor(() => expect(waiting).toBe(true)); admitted = false; release();
    expect(await pending).toEqual(maintenance ? { id: 99 } : null);
    expect(context.chrome.tabs.create).toHaveBeenCalledTimes(maintenance ? 1 : 0);
    expect(context.rememberAppOwnedOpeningTab).toHaveBeenCalledTimes(maintenance ? 1 : 0);
  });

  it('retains opening provenance when native creation was already dispatched before withdrawal', async () => {
    const start = backgroundSource.indexOf('async function createChatTab(');
    const end = backgroundSource.indexOf('\n}', start) + 2;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    let admitted = true;
    const context = {
      inBackgroundWindow: async (run: () => unknown) => run(), backgroundTabWindow: async () => 7,
      chrome: { tabs: { create: vi.fn(async () => { waiting = true; await held; return { id: 99 }; }) } },
      rememberAppOwnedOpeningTab: vi.fn(async () => undefined), rememberOpenConversationTab: vi.fn()
    };
    const create = vm.runInNewContext(`${backgroundSource.slice(start, end)}; createChatTab`, context);
    const pending = create('https://chatgpt.com/', false, true, null, 7, () => admitted);
    await vi.waitFor(() => expect(waiting).toBe(true)); admitted = false; release();
    expect(await pending).toEqual({ id: 99 });
    expect(context.rememberAppOwnedOpeningTab).toHaveBeenCalledWith({ id: 99 }, 'https://chatgpt.com/');
    expect(context.rememberOpenConversationTab).not.toHaveBeenCalled();
  });


  it.each([false, true])('rechecks each retained opening before metadata publication, maintenance=%s', async maintenance => {
    const start = backgroundSource.indexOf('async function rearmExistingSuccessorRoot(');
    const end = backgroundSource.indexOf('\n}', start) + 2;
    const rememberStart = backgroundSource.indexOf('async function rememberAppOwnedOpeningTab(');
    const rememberEnd = backgroundSource.indexOf('\n}', rememberStart) + 2;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    let admitted = true;
    let writes = 0;
    const id = '0123456789abcdef';
    const context: Record<string, any> = {
      chrome: { tabs: { query: async () => [7, 8].map(tab => ({ id: tab, url: `https://chatgpt.com/?clf=${id}#clf=${id}` })) },
        storage: { session: { set: vi.fn(async () => { if (++writes === 1) { waiting = true; await held; } }) } } },
      CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
      successorPlacementOwner: () => 'resume:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      commandMarkerForTab: () => id, ownedCommandRootMarker: () => id, commandRootMarkerForTab: () => id,
      conversationFromUrl: () => null, appOpeningMarker: () => id, appOwnedOpeningTabs: {}, scheduleRetry: vi.fn()
    };
    const rearm = vm.runInNewContext(`${backgroundSource.slice(rememberStart, rememberEnd)};
      ${backgroundSource.slice(start, end)}; rearmExistingSuccessorRoot`, context);
    const pending = rearm(id, {}, maintenance ? null : () => admitted);
    await vi.waitFor(() => expect(waiting).toBe(true)); admitted = false; release();
    expect(await pending).toBe(true);
    expect(context.appOwnedOpeningTabs['7']).toMatchObject({ marker: id,
      owner: 'resume:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    expect(context.chrome.storage.session.set).toHaveBeenCalledTimes(maintenance ? 2 : 1);
    expect(Boolean(context.appOwnedOpeningTabs['8'])).toBe(maintenance);
  });

  it('keeps fresh same-binding and truly global controls usable after preservation', async () => {
    const freshConversation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const { local, session } = legacyFirstBindingStorage({ session: { recoveryMonitoring: false, terminalDocuments: {} } });
    const requests: { path: string; body: any }[] = [];
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, { instanceId: 'profile-business', token: 'future-only-token' });
      requests.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      return response(200, { ok: true });
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage,
      tabsGet: async id => ({ id, url: id === 72 ? 'https://chatgpt.com/' : `https://chatgpt.com/c/${freshConversation}` }) });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business', operatorPreservation: offer.operatorPreservation },
      1, undefined, popup)).toEqual({ ok: true });
    await worker.registerTab(71);
    await worker.registerTab(72);
    for (const type of ['activity', 'goal_objective', 'goal_ack', 'settings_set']) {
      expect(await worker.send({ type, conversationId: freshConversation, goal: true, text: 'ordinary fresh objective' }, 71)).toMatchObject({ ok: true });
      // noteTabConversation returns false on this already-registered same binding.
      expect(await worker.send({ type, conversationId: freshConversation, goal: true, text: 'ordinary fresh objective' }, 71)).toMatchObject({ ok: true });
    }
    expect(await worker.send({ type: 'settings_set', goal: false }, 72)).toMatchObject({ ok: true });
    expect(await worker.send({ type: 'settings_get' }, 72)).toMatchObject({ ok: true });
    expect(await worker.send({ type: 'goal_open', text: 'new chat objective' }, 72)).toMatchObject({ ok: true });
    expect(requests.some(row => row.path === '/settings' && row.body?.goal === false && !row.body.conversationId)).toBe(true);
    expect(requests.some(row => row.path === '/goal/open')).toBe(true);
  });

  it('does not compact unassigned original observations when their journal write hits quota', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555557';
    const original = Array.from({ length: 3500 }, (_, index) => ({ conversationId, provisional: null,
      agent: null, agentCommandId: null, project: null, enrollmentHeld: true,
      event: { kind: 'assistant_message', time: 1_700_000_000_000 + index, messageId: `old-${index}`, text: `original-${index}` } }));
    const { local, session } = legacyFirstBindingStorage({ session: { journal: original, recoveryMonitoring: false,
      terminalDocuments: {}, tabDocuments: { '61': 'document-61-0' }, tabEpochs: { '61': 0 }, tabConversations: { '61': conversationId } } });
    const fetch = vi.fn(async (_input: string) => response(503, {}));
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    await worker.send({ type: 'status' });
    session.maxBytes = JSON.stringify(session.data).length - 1;
    const result = await worker.send({ type: 'events', conversationId, entries: [{ conversationId,
      event: { kind: 'assistant_message', time: Date.now(), text: 'new unassigned observation' } }] }, 61);
    expect(result).toMatchObject({ durable: false, pending: 3501 });
    expect(session.data.journal).toEqual(original);
    expect((session.data.journal as { gap?: boolean }[]).some(row => row.gap)).toBe(false);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(String(input)).pathname))).toBe(false);
  });

  it('does not shorten oversized unassigned close custody before an owner persistence or cold restart', async () => {
    const closes = Array.from({ length: 201 }, (_, index) => ({
      conversationId: (index + 1).toString(16).padStart(32, '0'), queuedAt: 1_700_000_000_000 + index,
      unknownScope: { original: null }
    }));
    const { local, session } = legacyFirstBindingStorage({ local: { closeOutbox: closes },
      session: { closeOutbox: closes, recoveryMonitoring: false, terminalDocuments: {} } });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const options = { local, session, fetch, tabsSendMessage: currentPairingPage };
    const worker = loadWorker(options);
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup))
      .toMatchObject({ ok: false, error: 'account_busy' });
    await worker.send({ type: 'bind', conversationId: '11111111-2222-3333-4444-555555555559' }, 62);
    expect(local.data.closeOutbox).toEqual(closes);
    expect(session.data.closeOutbox).toEqual(closes);
    const restarted = loadWorker(options);
    expect(await restarted.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup))
      .toMatchObject({ ok: false, error: 'account_busy' });
    expect(local.data.closeOutbox).toEqual(closes);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it('requires every exact preservation-intent field and rejects hidden or accessor approvals', () => {
    const cloneStart = backgroundSource.indexOf('function cloneUnassignedHistoryData(');
    const cloneEnd = backgroundSource.indexOf('async function unassignedHistoryDigest(', cloneStart);
    const start = backgroundSource.indexOf('function exactOperatorPreservation(');
    const end = backgroundSource.indexOf('function unassignedHistoryConversation(', start);
    const expected = { version: 1, targetInstanceId: 'profile-business', snapshotDigest: 'a'.repeat(64), journalCount: 0, ordinaryCloseCount: 1 };
    const getter = vi.fn(() => 1);
    const read = (value: unknown) => vm.runInNewContext(`${backgroundSource.slice(cloneStart, cloneEnd)};
      ${backgroundSource.slice(start, end)}; exactOperatorPreservation(value, expected);`,
    { value, expected, TextEncoder, stableOperatorAdoptionJson: JSON.stringify });
    expect(read({ ...expected })).toBe(true);
    for (const [field, wrong] of Object.entries({ version: 2, targetInstanceId: 'profile-Epsilon', snapshotDigest: 'b'.repeat(64),
      journalCount: 1, ordinaryCloseCount: 2 })) expect(read({ ...expected, [field]: wrong })).toBe(false);
    expect(read({ ...expected, force: true })).toBe(false);
    expect(read(Object.defineProperty({ ...expected }, 'hidden', { value: true }))).toBe(false);
    expect(read(Object.defineProperty({ ...expected }, 'version', { enumerable: true, get: getter }))).toBe(false);
    expect(read({ ...expected, ordinaryCloseCount: 0 })).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['discovery', 'provision', '401-response', '401-retry'])
  ('keeps the actual correlation/request owners from crossing an archived %s generation', async boundary => {
    const callStart = backgroundSource.indexOf('async function call(');
    const callEnd = backgroundSource.indexOf('function provision(', callStart);
    const ownerStart = backgroundSource.indexOf('async correlate(message,');
    const ownerEnd = backgroundSource.indexOf('async activity(', ownerStart);
    const conversationId = '11111111-2222-3333-4444-555555555557';
    let release!: (value: unknown) => void;
    const held = new Promise(resolve => { release = resolve; });
    let waiting = false;
    let discoveries = 0;
    let requests = 0;
    const persist = vi.fn(async () => undefined);
    const context: Record<string, any> = {
      // Mirror the real connection tuple and incumbent repair registry read by the extracted owner.
      instanceId: 'fixture-instance', port: 8770, browserId: 'fixture-browser', desktopInputReceiverRepairs: new Map(),
      token: boundary === 'provision' ? null : 'old-fixture-token', disconnected: false,
      connectionEpoch: 1, unassignedHistoryGeneration: null, URL, archived: false, unassignedHistoryUncertain: false,
      load: async () => undefined, ownsDocument: () => true,
      cleanConversationId: (value: string) => value,
      unassignedHistoryConversation: (value: string) => context.archived && value === conversationId,
      noteTabConversation: async () => false,
      discover: async () => {
        discoveries++;
        if (boundary === 'discovery' || boundary === '401-retry' && discoveries === 2) { waiting = true; await held; }
        return { port: 8770, compatible: true };
      },
      provision: async () => { waiting = true; await held; return { ok: true }; },
      fetchBounded: vi.fn(async () => {
        requests++;
        if (boundary === '401-response') return { status: 401, ok: false, json: async () => { waiting = true; await held; return {}; } };
        if (boundary === '401-retry' && requests === 1) return response(401, {});
        return response(200, { ok: true });
      }),
      persist, versionHeaders: () => ({}), REQUEST_TIMEOUT_MS: 1000, TIMED_OUT: 'timeout',
      latchAppDisconnect: vi.fn(), connectWakeSocket: () => undefined, forgetPort: () => undefined
    };
    const owner = vm.runInNewContext(`${backgroundSource.slice(backgroundSource.indexOf('function conversationAdmission('), callEnd)};
      ({ ${backgroundSource.slice(ownerStart, ownerEnd)} });`, context);
    const pending = owner.correlate({ conversationId, calls: [{ requestId: 'original-request' }] }, {},
      { tab: 61, documentId: 'same-document', navigationEpoch: 0 });
    await vi.waitFor(() => expect(waiting).toBe(true));
    const ownedOldWrites = persist.mock.calls.length;
    context.archived = true;
    context.connectionEpoch++;
    context.token = 'new-selection-fixture-token';
    release({ ok: true });
    expect(await pending).toMatchObject({ ok: false, error: 'account_history_unassigned' });
    expect(requests).toBe(boundary.startsWith('401') ? 1 : 0);
    expect(context.token).toBe('new-selection-fixture-token');
    expect(persist.mock.calls).toHaveLength(ownedOldWrites);
  });

  it.each(['committed', 'uncertain'])('retains the local history seal when the whole browser session store is cleared (%s)', async state => {
    const { local, session, conversationId } = legacyFirstBindingStorage({ row: { legacyScope: { originalAccount: null, label: 'exact original scope' } },
      event: { unknownLegacyData: [null, { retained: true }] }, session: { recoveryMonitoring: false, terminalDocuments: {} } });
    const published: Array<{ route: string; conversationId: string }> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, { instanceId: 'profile-business', token: 'future-only-token' });
      if (['/events', '/closed', '/correlations'].includes(url.pathname)) {
        const body = JSON.parse(String(init.body));
        published.push({ route: url.pathname, conversationId: body.conversationId });
        return response(url.pathname === '/closed' ? 503 : 200, { ok: true, confirmed: ['fresh-request'] });
      }
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business', operatorPreservation: offer.operatorPreservation },
      1, undefined, popup)).toEqual({ ok: true });
    const sealBefore = structuredClone(local.data.sealedUnassignedHistory);
    const futureClosed = '11111111-2222-3333-4444-555555555560';
    await worker.send({ type: 'bind', conversationId: futureClosed }, 62);
    await worker.closeTab(62);
    await vi.waitFor(() => expect(local.data.closeOutbox).toMatchObject([{ conversationId: futureClosed }]));
    const futureCloses = structuredClone(local.data.closeOutbox);
    if (state === 'uncertain') {
      (local.data.sealedUnassignedHistory as { phase: string }).phase = 'sealed';
      // An interrupted/unknown archive with an already selected tuple must not lose
      // oversized original custody merely because the loader is failing closed.
      local.data.closeOutbox = Array.from({ length: 201 }, (_, index) => ({
        conversationId: (index + 1).toString(16).padStart(32, '0'), queuedAt: 1_700_000_000_000 + index
      }));
    }
    const heldCloses = structuredClone(local.data.closeOutbox);
    const coldSession = new FakeStorageArea();
    const restarted = loadWorker({ local, session: coldSession, fetch, tabsSendMessage: currentPairingPage });
    await restarted.send({ type: 'status' });
    expect(coldSession.data.tabDocuments ?? {}).not.toHaveProperty('51');
    expect(coldSession.data.tabEpochs ?? {}).not.toHaveProperty('51');
    expect(coldSession.data.terminalDocuments ?? {}).toEqual({});
    expect(coldSession.data.appOwnedOpeningTabs ?? {}).toEqual({});
    expect(local.data.closeOutbox).toEqual(heldCloses);
    const archive = local.data.sealedUnassignedHistory as { history: unknown };
    expect(archive.history).toEqual((sealBefore as { history: unknown }).history);
    expect(JSON.stringify(archive.history)).toContain('exact original scope');
    if (state === 'uncertain') {
      expect(await restarted.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup))
        .toMatchObject({ ok: false, error: 'account_history_preservation_uncertain' });
      await restarted.registerTab(63);
      await restarted.send({ type: 'bind', conversationId: futureClosed }, 63);
      expect(local.data.closeOutbox).toHaveLength(201);
      return;
    }
    expect(local.data.sealedUnassignedHistory).toEqual(sealBefore);
    expect(local.data.closeOutbox).toEqual(futureCloses);
    expect(await restarted.send({ type: 'events', conversationId, entries: [{ conversationId,
      event: { kind: 'assistant_message', text: 'old unassigned replay', time: Date.now() } }] }, 51))
      .toMatchObject({ ok: false, error: 'account_history_unassigned', durable: false });
    expect(await restarted.send({ type: 'bind', conversationId }, 51)).toMatchObject({ ok: false, error: 'account_history_unassigned' });
    expect(await restarted.send({ type: 'correlate', conversationId, calls: [{ requestId: 'old-request' }] }, 51))
      .toMatchObject({ ok: false, error: 'account_history_unassigned' });
    await restarted.closeTab(51);
    const future = '11111111-2222-3333-4444-555555555561';
    expect(await restarted.send({ type: 'events', conversationId: future, entries: [{ conversationId: future,
      event: { kind: 'user_message', messageId: 'new-browser-user', time: Date.now(), text: 'new browser work' } }] }, 52))
      .toMatchObject({ ok: true, durable: true });
    expect(await restarted.send({ type: 'correlate', conversationId: future, calls: [{ requestId: 'fresh-request' }] }, 52))
      .toMatchObject({ ok: true, data: { confirmed: ['fresh-request'] } });
    expect(published.some(row => row.conversationId === conversationId)).toBe(false);
    expect(published).toContainEqual({ route: '/events', conversationId: future });
    expect(published).toContainEqual({ route: '/correlations', conversationId: future });
    expect(local.data.sealedUnassignedHistory).toEqual(sealBefore);
  });

  it('requires one exact operator confirmation before associating preserved legacy first-bind history', async () => {
    const { local, session } = legacyFirstBindingStorage();
    const delivered: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, {
        instanceId: 'profile-business', token: 'operator-approved-token'
      });
      if (url.pathname === '/events') { delivered.push('events'); return response(200, { ok: true }); }
      if (url.pathname === '/closed') { delivered.push('closed'); return response(200, { ok: true }); }
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(offer).toMatchObject({
      ok: false,
      error: 'account_history_adoption_required',
      operatorAdoption: {
        version: 1, targetInstanceId: 'profile-business', journalCount: 1, ordinaryCloseCount: 1
      }
    });
    expect(offer.operatorAdoption.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
    // Consent must survive an ordinary MV3 worker restart, but only while the complete raw
    // snapshot is unchanged. The digest is no durable grant by itself.
    const restarted = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    expect(await restarted.send({ type: 'pairTo', instanceId: 'profile-business',
      operatorAdoption: offer.operatorAdoption }, 1, undefined, popup)).toEqual({ ok: true });
    await vi.waitFor(() => expect(delivered).toEqual(['events', 'closed']));
    expect(session.data.journal).toEqual([]);
    expect(local.data.closeOutbox).toEqual([]);
  });

  it('rejects mismatched or stale operator adoption without pairing or publishing preserved history', async () => {
    const { local, session } = legacyFirstBindingStorage();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(offer.error).toBe('account_history_adoption_required');

    const wrong = { ...offer.operatorAdoption, snapshotDigest: '0'.repeat(64) };
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business', operatorAdoption: wrong },
      1, undefined, popup)).toMatchObject({ ok: false, error: 'account_busy' });

    await session.set({ journal: [...session.data.journal as unknown[], {
      conversationId: '11111111-2222-3333-4444-555555555557', provisional: null,
      agent: null, agentCommandId: null, project: null, enrollmentHeld: true,
      event: { kind: 'progress', time: 1_700_000_000_002, text: 'later preserved observation' }
    }] });
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business',
      operatorAdoption: offer.operatorAdoption }, 1, undefined, popup))
      .toMatchObject({ ok: false, error: 'account_busy' });
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
    expect(local.data.closeOutbox).toHaveLength(1);
    expect(session.data.journal).toHaveLength(2);
  });

  it('preserves operator-adoption history when a newer Disconnect supersedes its staged selection', async () => {
    const { local, session } = legacyFirstBindingStorage();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let staging = false;
    const actualSet = local.set.bind(local);
    local.set = async values => {
      await actualSet(values);
      if (!staging && values.instanceId === 'profile-business' && values.token === null && values.disconnected === true) {
        staging = true;
        await held;
      }
    };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, {
        instanceId: 'profile-business', token: 'must-not-be-published'
      });
      return response(503, {});
    });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    const older = worker.send({ type: 'pairTo', instanceId: 'profile-business',
      operatorAdoption: offer.operatorAdoption }, 1, undefined, popup);
    await vi.waitFor(() => expect(staging).toBe(true));
    const newer = worker.send({ type: 'unpair' });
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    release();
    expect(await older).toMatchObject({ ok: false, error: 'connection_intent_superseded' });
    expect(await newer).toEqual({ ok: true });
    expect(local.data).toMatchObject({ token: null, disconnected: true });
    expect(session.data.journal).toHaveLength(1);
    expect(local.data.closeOutbox).toHaveLength(1);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it('does not pair or consume operator-adoption history when the selected tuple cannot be persisted', async () => {
    const { local, session } = legacyFirstBindingStorage();
    const actualSet = local.set.bind(local);
    local.set = async values => {
      if (values.instanceId === 'profile-business' && values.token === null && values.disconnected === true)
        throw new Error('simulated selected tuple failure');
      await actualSet(values);
    };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business',
      operatorAdoption: offer.operatorAdoption }, 1, undefined, popup))
      .toMatchObject({ ok: false, error: 'account_selection_save_failed' });
    expect(session.data.journal).toHaveLength(1);
    expect(local.data.closeOutbox).toHaveLength(1);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it('restores unassigned custody when the approved account does not return a pairing token', async () => {
    const { local, session } = legacyFirstBindingStorage();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(503, { error: 'pair_temporarily_unavailable' });
      return response(503, {});
    });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const offer = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business',
      operatorAdoption: offer.operatorAdoption }, 1, undefined, popup))
      .toMatchObject({ ok: false, error: 'pair_temporarily_unavailable' });
    for (const key of ['instanceId', 'port', 'token', 'disconnected']) expect(local.data).not.toHaveProperty(key);
    expect(session.data.journal).toHaveLength(1);
    expect(local.data.closeOutbox).toHaveLength(1);
    const retry = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    expect(retry).toMatchObject({ ok: false, error: 'account_history_adoption_required' });
    expect(fetch.mock.calls.some(([input]) => ['/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it.each([
    { name: 'a prior raw null tuple', refusal: 'prior_binding', changes: { local: { port: null } } },
    { name: 'a pending input lease', refusal: 'active_custody', changes: { local: { inputOpenings: { private: { tab: null } } } } },
    { name: 'a command receipt', refusal: 'active_custody', changes: { local: { commandAckOutbox: [{ id: 'private-command', status: 'sent' }] } } },
    { name: 'a command tab lease', refusal: 'active_custody', changes: { local: { commandTabLeases: { '51': 'private-command-lease' } } } },
    { name: 'a prior delivery receipt', refusal: 'active_custody', changes: { session: { delivery: { at: 1, total: 1, ok: true } } } },
    { name: 'a retained operation owner', refusal: 'active_custody', changes: { session: { modelCatalogOwner: { nonce: 'private-owner' } } } },
    { name: 'a retired document owner', refusal: 'terminal_mismatch', changes: { session: { retiredDocuments: { old: { private: true } } } } },
    { name: 'worker provenance', refusal: 'observation_shape', changes: { row: { agent: 'worker-owner' } } },
    { name: 'an unknown observation field', refusal: 'observation_shape', changes: { event: { privateOwner: 'not-public' } } },
    { name: 'an extension close', refusal: 'close_shape', changes: { close: { byExtension: true } } },
    { name: 'a retirement close', refusal: 'close_shape', changes: { close: { retirement: { kind: 'superseded-source', receiptId: 'a'.repeat(32) } } } },
    { name: 'different local and session close rows', refusal: 'receipt_mismatch', changes: { sessionClose: { queuedAt: 1_700_000_000_099 } } },
    { name: 'a mismatched terminal document', refusal: 'terminal_mismatch', changes: { session: { terminalDocuments: { '51': 'different-document' } } } }
  ])('does not offer or accept legacy-history adoption across $name', async ({ changes, refusal, name }) => {
    const { local, session } = legacyFirstBindingStorage(changes);
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html');
    expect(result).toMatchObject({ ok: false, error: name === 'a mismatched terminal document'
      ? 'account_history_preservation_required' : 'account_busy' });
    expect(result.historyEligibility).toBe(refusal);
    expect(result.message).toContain(`History eligibility diagnostic: ${refusal}`);
    expect(result.message).toContain('not permission or a delivery retry grant');
    expect(result.message).toContain('Recovery protocol 1.');
    expect(result).not.toHaveProperty('operatorAdoption');
    expect(JSON.stringify(result)).not.toMatch(/preserved unassigned history|private-command|private-owner|different-document|not-public|11111111/);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it('keeps history refusal metadata fixed and never reads a diagnostic accessor or inherited reason', () => {
    const start = backgroundSource.indexOf('function accountBusyError(');
    const end = backgroundSource.indexOf('/** Reprove the exact isolated document', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const getter = vi.fn(() => 'private body');
    const scenarios = [
      { value: { refusal: 'observation_shape', body: 'private body', token: 'private token' }, expected: 'observation_shape' },
      { value: { refusal: 'private body' }, expected: undefined },
      { value: Object.create({ refusal: 'prior_binding' }), expected: undefined },
      { value: Object.defineProperty({}, 'refusal', { get: getter }), expected: undefined }
    ];
    for (const scenario of scenarios) {
      const result = vm.runInNewContext(`${backgroundSource.slice(start, end)}; accountBusyError({ journal: 99999 }, diagnostic);`,
        { diagnostic: scenario.value });
      expect(result.historyEligibility).toBe(scenario.expected);
      expect(result.pendingWork).toEqual({ journal: 4000 });
      expect(result.message.length).toBeLessThanOrEqual(2400);
      expect(result.message.match(/Recovery protocol 1\./g)).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(/private body|private token/);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'monitoring off before another invalid map', reason: 'monitoring_off', changes: {
      recoveryMonitoring: false, terminalDocuments: [] }, counts: { terminalEntries: null } },
    { name: 'missing monitoring proof', reason: 'monitoring_unproven', changes: {
      recoveryMonitoring: undefined }, counts: {} },
    { name: 'malformed monitoring proof', reason: 'monitoring_unproven', changes: {
      recoveryMonitoring: 'private monitoring value' }, counts: {} },
    { name: 'invalid terminal map', reason: 'terminal_map_invalid', changes: {
      terminalDocuments: [] }, counts: { terminalEntries: null } },
    { name: 'terminal and close key-count mismatch', reason: 'terminal_count_mismatch', changes: {
      terminalDocuments: {} }, counts: { terminalEntries: 0 } },
    { name: 'invalid document map', reason: 'document_map_invalid', changes: {
      tabDocuments: [] }, counts: { documentEntries: null } },
    { name: 'invalid epoch map', reason: 'epoch_map_invalid', changes: {
      tabEpochs: [] }, counts: { epochEntries: null } },
    { name: 'invalid conversation map', reason: 'conversation_map_invalid', changes: {
      tabConversations: [] }, counts: { conversationEntries: null } },
    { name: 'invalid retired-owner map', reason: 'retired_map_invalid', changes: {
      retiredDocuments: [] }, counts: { retiredEntries: null } },
    { name: 'retired ownership before a registered conversation', reason: 'retired_ownership', changes: {
      retiredDocuments: { '51': ['private-retired-document'] },
      tabConversations: { '51': '11111111-2222-3333-4444-555555555557' }
    }, counts: { retiredEntries: 1, conversationEntries: 1 } },
    { name: 'invalid registered document', reason: 'document_invalid', changes: {
      tabDocuments: { '51': '' } }, counts: {} },
    { name: 'missing document epoch', reason: 'epoch_map_mismatch', changes: {
      tabEpochs: {} }, counts: { epochEntries: 0 } },
    { name: 'invalid document epoch', reason: 'epoch_invalid', changes: {
      tabEpochs: { '51': -1 } }, counts: {} },
    { name: 'live registered conversation', reason: 'registered_conversation_entry', changes: {
      tabConversations: { '51': '11111111-2222-3333-4444-555555555557' }
    }, counts: { conversationEntries: 1 } },
    { name: 'extra epoch-map entry', reason: 'epoch_map_mismatch', changes: {
      tabEpochs: { '51': 4, '52': 0 } }, counts: { epochEntries: 2 } },
    { name: 'different terminal and registered document', reason: 'terminal_document_mismatch', changes: {
      terminalDocuments: { '51': 'private-different-document' } }, counts: {} }
  ])('diagnoses the earliest terminal custody invariant without granting adoption: $name', async ({ reason, changes, counts }) => {
    const { local, session } = legacyFirstBindingStorage({ session: changes });
    const retainedJournal = structuredClone(session.data.journal);
    const retainedCloses = structuredClone(local.data.closeOutbox);
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html');
    expect(result).toMatchObject({ ok: false, error: ['terminal_count_mismatch', 'registered_conversation_entry', 'terminal_document_mismatch'].includes(reason)
      ? 'account_history_preservation_required' : 'account_busy', historyEligibility: 'terminal_mismatch',
      historyTerminalReason: reason,
      historyTerminalCounts: { terminalEntries: 1, closeReceipts: 1, documentEntries: 1, epochEntries: 1,
        conversationEntries: 0, retiredEntries: 0, ...counts } });
    expect(result.message).toContain(`Terminal custody diagnostic: ${reason}`);
    expect(result.message).toContain('not permission or a delivery retry grant');
    expect(result.message.length).toBeLessThanOrEqual(2400);
    expect(result).not.toHaveProperty('operatorAdoption');
    expect(JSON.stringify(result)).not.toMatch(/private-|11111111|legacy-first-bind-document/);
    expect(session.data.journal).toEqual(['retired_map_invalid', 'retired_ownership'].includes(reason)
      ? (retainedJournal as Record<string, unknown>[]).map(row => ({ ...row, enrollmentCustodyUncertain: true })) : retainedJournal);
    expect(local.data.closeOutbox).toEqual(retainedCloses);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it('publishes only bounded own-data terminal diagnostics without invoking accessors', () => {
    const start = backgroundSource.indexOf('function accountBusyError(');
    const end = backgroundSource.indexOf('/** Reprove the exact isolated document', start);
    const getter = vi.fn(() => 'private diagnostic');
    const counts = { terminalEntries: 99999, closeReceipts: 1, documentEntries: null, epochEntries: 1,
      conversationEntries: 0, retiredEntries: 0, privateKey: 'private value' };
    const scenarios = [
      { value: { refusal: 'terminal_mismatch', terminalReason: 'retired_ownership', terminalCounts: counts },
        expected: { historyTerminalReason: 'retired_ownership', historyTerminalCounts: {
          terminalEntries: 4000, closeReceipts: 1, documentEntries: null, epochEntries: 1,
          conversationEntries: 0, retiredEntries: 0 } } },
      { value: { refusal: 'active_custody', terminalReason: 'retired_ownership', terminalCounts: counts }, expected: {} },
      { value: { refusal: 'terminal_mismatch', terminalReason: 'private diagnostic', terminalCounts: counts }, expected: {} },
      { value: Object.assign(Object.create({ terminalReason: 'retired_ownership' }), {
        refusal: 'terminal_mismatch', terminalCounts: counts }), expected: {} },
      { value: Object.defineProperty({ refusal: 'terminal_mismatch', terminalCounts: counts },
        'terminalReason', { get: getter }), expected: {} },
      { value: { refusal: 'terminal_mismatch', terminalReason: 'retired_ownership',
        terminalCounts: Object.defineProperty({ ...counts }, 'epochEntries', { get: getter }) },
        expected: { historyTerminalReason: 'retired_ownership' } },
      { value: Object.defineProperty({ refusal: 'terminal_mismatch', terminalReason: 'retired_ownership' },
        'terminalCounts', { get: getter }), expected: { historyTerminalReason: 'retired_ownership' } },
      { value: { refusal: 'terminal_mismatch', terminalReason: 'retired_ownership',
        terminalCounts: Object.create(counts) }, expected: { historyTerminalReason: 'retired_ownership' } },
      ...[-1, 0.5, Infinity, 'private count'].map(value => ({
        value: { refusal: 'terminal_mismatch', terminalReason: 'retired_ownership',
          terminalCounts: { ...counts, epochEntries: value } }, expected: { historyTerminalReason: 'retired_ownership' }
      }))
    ];
    for (const scenario of scenarios) {
      const result = vm.runInNewContext(`${backgroundSource.slice(start, end)}; accountBusyError({ journal: 1 }, diagnostic);`,
        { diagnostic: scenario.value });
      expect(result).toMatchObject(scenario.expected);
      for (const key of ['historyTerminalReason', 'historyTerminalCounts']) {
        if (!(key in scenario.expected)) expect(result).not.toHaveProperty(key);
      }
      expect(JSON.stringify(result)).not.toMatch(/private diagnostic|private value|privateKey/);
      expect(result).not.toHaveProperty('operatorAdoption');
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('keeps terminal eligibility exactly equivalent with or without per-call diagnosis', () => {
    const start = backgroundSource.indexOf('function operatorAdoptionTerminalState(');
    const end = backgroundSource.indexOf('function operatorAdoptionState(', start);
    const predicate = vm.runInNewContext(`${backgroundSource.slice(start, end)}; operatorAdoptionTerminalState;`);
    // Exact predecessor predicate, including its incumbent caller's monitoring check.
    // These diagnostics must not silently change even an unusual existing ownership verdict.
    const previous = vm.runInNewContext(`(live, closes) => {
      if (live?.recoveryMonitoring !== true) return false;
      const plain = value => value && typeof value === 'object' && !Array.isArray(value);
      const terminal = live?.terminalDocuments, documents = live?.tabDocuments, epochs = live?.tabEpochs;
      const conversations = live?.tabConversations, retired = live?.retiredDocuments;
      if (!plain(terminal) || Object.keys(terminal).length !== closes.length || !plain(documents) || !plain(epochs) ||
          conversations !== undefined && !plain(conversations) || retired !== undefined &&
          (!plain(retired) || Object.keys(retired).length > 0)) return false;
      if (!Object.keys(documents).every(key => /^\\d+$/.test(key) && typeof documents[key] === 'string' &&
          documents[key].length > 0 && documents[key].length <= 200 && Number.isSafeInteger(epochs[key]) &&
          epochs[key] >= 0 && !Object.prototype.hasOwnProperty.call(conversations || {}, key))) return false;
      if (!Object.keys(epochs).every(key => Object.prototype.hasOwnProperty.call(documents, key))) return false;
      return Object.entries(terminal).every(([key, documentId]) => /^\\d+$/.test(key) && documents[key] === documentId &&
        typeof documentId === 'string' && documentId.length > 0 && documentId.length <= 200);
    }`);
    const base = { recoveryMonitoring: true, terminalDocuments: { '51': 'document' },
      tabDocuments: { '51': 'document' }, tabEpochs: { '51': 4 }, tabConversations: {}, retiredDocuments: {} };
    const changes = [
      {}, { recoveryMonitoring: false }, { recoveryMonitoring: undefined }, { recoveryMonitoring: 'true' },
      { terminalDocuments: null }, { terminalDocuments: [] }, { terminalDocuments: {} },
      { terminalDocuments: { '51': 'different', '52': 'document' } }, { tabDocuments: [] },
      { tabDocuments: { '51': '' } }, { tabDocuments: { '51': 'd'.repeat(201) } },
      { tabDocuments: { invalid: 'document' } }, { tabEpochs: [] }, { tabEpochs: {} },
      { tabEpochs: { '51': -1 } }, { tabEpochs: { '51': 0.5 } }, { tabEpochs: { '51': 4, '52': 0 } },
      { tabEpochs: Object.create({ '51': 4 }) }, { tabConversations: undefined },
      { tabConversations: [] }, { tabConversations: { '51': null } }, { tabConversations: { '52': 'other' } },
      { retiredDocuments: undefined }, { retiredDocuments: [] }, { retiredDocuments: { '51': [] } }
    ];
    for (const change of changes) {
      for (const closes of [[], [{}], [{}, {}]]) {
        const live = { ...base, ...change };
        const expected = previous(live, closes);
        expect(predicate(live, closes)).toBe(expected);
        expect(predicate(live, closes, { refusal: null })).toBe(expected);
      }
    }
    const diagnostic = { refusal: null };
    expect(predicate({ ...base, retiredDocuments: { '51': [] } }, [{}], diagnostic)).toBe(false);
    const first = structuredClone(diagnostic);
    expect(predicate({ ...base, recoveryMonitoring: false }, [{}], diagnostic)).toBe(false);
    expect(diagnostic).toEqual(first);
  });

  it.each([
    { name: 'close-only custody', refusal: 'observation_shape', changes: { session: { journal: [] } } },
    { name: 'observation-only custody', refusal: 'close_shape', changes: { local: { closeOutbox: [] }, session: { closeOutbox: [] } } },
    { name: 'different observation and close conversations', refusal: 'conversation_mismatch', changes: {
      row: { conversationId: '11111111-2222-3333-4444-555555555559' }
    } }
  ])('diagnoses $name without weakening history corroboration', async ({ changes, refusal }) => {
    const { local, session } = legacyFirstBindingStorage(changes);
    const retainedLocal = structuredClone(local.data), retainedSession = structuredClone(session.data);
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html');
    expect(result).toMatchObject({ ok: false, error: ['conversation_mismatch', 'observation_shape'].includes(refusal)
      ? 'account_history_preservation_required' : 'account_busy', historyEligibility: refusal });
    expect(result).not.toHaveProperty('operatorAdoption');
    expect(local.data.closeOutbox).toEqual(retainedLocal.closeOutbox);
    expect(session.data.journal).toEqual(retainedSession.journal);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events', '/closed'].includes(new URL(input).pathname))).toBe(false);
  });

  it.each(['timeout', 'snapshot_read_failed', 'snapshot_changed', 'invalid_snapshot', 'active_custody', 'prior_binding'] as const)
  ('keeps the first %s snapshot refusal per call without leaking errors or granting adoption', async scenario => {
    const start = backgroundSource.indexOf('function stableOperatorAdoptionJson(');
    const end = backgroundSource.indexOf('/** Copy only bounded ordinary data', start);
    const journal = [{ privateText: 'private retained body' }];
    const closeOutbox = [{ privateClose: 'private close identity' }];
    let reads = 0;
    const context = {
      instanceId: scenario === 'prior_binding' ? 'private foreign instance' : null,
      port: null, token: null, disconnected: false, pairing: false, pairingEpoch: 0, connectionEpoch: 1,
      journalWorkers: new Set(), maintenanceFlight: scenario === 'active_custody' ? {} : null,
      modelCatalogFlight: null, pluginRefreshFlight: null, projectCreateFlight: null, deferredRecoveryWork: null,
      journal, closeOutbox, HELLO_TIMEOUT_MS: 1, TextEncoder, crypto: webcrypto,
      setTimeout, clearTimeout,
      chrome: { storage: {
        local: { get: async () => ({ closeOutbox }) },
        session: { get: async () => {
          if (scenario === 'snapshot_read_failed') throw new Error('private read error /private/path token');
          if (scenario === 'timeout') return new Promise(() => undefined);
          return { journal: scenario === 'snapshot_changed' && ++reads > 1 ? [{ privateText: 'later private body' }] : journal };
        } }
      } },
      // This test isolates the production snapshot orchestration; state predicate refusals and
      // real successful confirmations run through the complete worker fixtures above.
      operatorAdoptionState: (_stored: unknown, live: { journal: unknown[] }) => {
        if (scenario === 'invalid_snapshot') throw new Error('private malformed snapshot');
        return { journal: live.journal, closeOutbox };
      },
      diagnostic: { refusal: null as string | null }
    };
    const result = await vm.runInNewContext(`${backgroundSource.slice(start, end)};
      operatorAdoptionSnapshot('profile-business', null, diagnostic);`, context);
    expect(result).toBeNull();
    expect(context.diagnostic).toEqual({ refusal: scenario });
    const publicationStart = backgroundSource.indexOf('function accountBusyError(');
    const publicationEnd = backgroundSource.indexOf('/** Reprove the exact isolated document', publicationStart);
    expect(publicationStart).toBeGreaterThanOrEqual(0);
    expect(publicationEnd).toBeGreaterThan(publicationStart);
    const publication = vm.runInNewContext(`${backgroundSource.slice(publicationStart, publicationEnd)};
      accountBusyError({ journal: 1 }, diagnostic);`, context);
    expect(publication.historyEligibility).toBe(scenario);
    expect(JSON.stringify(publication)).not.toMatch(/private retained|private close|private foreign|private read|private malformed|private\/path|token/);
    expect(publication).not.toHaveProperty('operatorAdoption');
    // A later error cannot turn the first reason into a shared mutable last-error slot.
    context.chrome.storage.session.get = async () => { throw new Error('later private read failure'); };
    await vm.runInNewContext(`${backgroundSource.slice(start, end)};
      operatorAdoptionSnapshot('profile-business', null, diagnostic);`, context);
    expect(context.diagnostic).toEqual({ refusal: scenario });
  });

  it('preserves valid current producer shapes through first enrollment without inventing a native Send', async () => {
    const time = Date.now(), conversationId = '11111111-2222-3333-4444-555555555555';
    const events = [
      { kind: 'user_message', time, text: 'original user text', messageId: 'user-1', authoredTime: true, authoredNow: true,
        textOrigin: 'provider', model: 'gpt-6-thinking', reaction: null,
        attachments: [{ id: 'file-1', name: 'reference.png', mimeType: 'image/png', size: 123 }] },
      { kind: 'assistant_message', time, text: 'original native answer', messageId: 'assistant-1', providerMessageId: conversationId,
        inputSourceUserMessageId: 'user-1', fiberConversationId: conversationId, turnId: 'native-turn', renderedHtml: '<p>answer</p>',
        state: 'final', final: true, goalEligible: true, activeNow: true },
      { kind: 'tool_evidence', time, turnId: 'native-turn', fiberConversationId: conversationId,
        calls: [{ messageId: 'call-1', tool: 'read', requestId: 'request-1', order: 0, answered: true, createTime: time }] },
      { kind: 'app_sightings', time, apps: [{ appId: 'core-app', requestId: 'request-1', appName: 'Core', linkId: null }] },
      { kind: 'model_selection', time, model: 'GPT-6 Thinking', reasoningEffort: 'high' },
      { kind: 'conversation_title', time, text: 'Original title' },
      { kind: 'page_tool', time, text: 'Read workspace', messageId: 'activity-1', turnId: 'native-turn' },
      { kind: 'turn_start', time, turnId: 'native-turn' },
      { kind: 'turn_end', time, turnId: 'native-turn', outcome: 'completed' },
      { kind: 'chat_error', time, text: 'Original transport error', reason: 'stream_gone', recoverable: true, retryAvailable: false },
      { kind: 'progress', time, text: 'Retained journal gap' }
    ];
    const observations = events.map(event => ({ conversationId, provisional: null, agent: null, agentCommandId: null, project: null, event }));
    const local = new FakeStorageArea(), session = new FakeStorageArea({ journal: observations });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, { instanceId: 'profile-business', token: 'exact-enrollment-token' });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'settings-document', 'https://chatgpt.com/'))
      .toEqual({ ok: true });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/events')).toBe(true));
    expect(session.data.journal).toEqual(observations);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsSendMessage.mock.calls.every(([, message]) => message.type === 'clf-page-status')).toBe(true);
    expect(local.data).toMatchObject({ instanceId: 'profile-business', port: 8770, token: 'exact-enrollment-token', disconnected: false });
  });

  const enrollmentHolds: Array<{ name: string; local?: Record<string, unknown>; session?: Record<string, unknown>; row?: Record<string, unknown> }> = [
    { name: 'prior exact account', local: { port: 8765, instanceId: 'local-instance', token: 'old-account-token' } },
    { name: 'legacy port only', local: { port: 8765 } },
    { name: 'saved null port', local: { port: null } },
    { name: 'saved null token', local: { token: null } },
    { name: 'malformed token', local: { token: 123 } },
    { name: 'saved null instance', local: { instanceId: null } },
    { name: 'malformed instance', local: { instanceId: 'invalid identity' } },
    { name: 'deliberate disconnect', local: { disconnected: true } },
    { name: 'saved prior connection flag', local: { disconnected: false } },
    { name: 'command ACK custody', local: { commandAckOutbox: [{ id: 'private-command', status: 'sent' }] } },
    { name: 'malformed revival custody', local: { deferredRevivals: 'not-an-array' } },
    { name: 'malformed opening custody', local: { inputOpenings: [] } },
    { name: 'settled command history', session: { settled: ['private-command'] } },
    { name: 'malformed ambiguous native receipt', session: { pendingInputReceipts: { 'opaque-id': { private: 'receipt' } } } },
    { name: 'malformed opening history', session: { appOwnedOpeningTabs: 'private-old-opening' } },
    { name: 'native terminal lease', session: { terminalDocuments: { '3': 'old-document' } } },
    { name: 'prior successful recorder delivery', session: { delivery: { at: 1, total: 1, ok: true } } },
    { name: 'partial unknown delivery history', session: { delivery: { total: 0 } } },
    { name: 'retained model-catalog owner', session: { modelCatalogOwner: { nonce: 'private-owner' } } },
    { name: 'worker observation provenance', row: { agent: 'worker-1' } },
    { name: 'command observation provenance', row: { agentCommandId: 'private-command' } },
    { name: 'foreign observation identity', row: { instanceId: 'old-account' } },
    { name: 'non-observation event', row: { event: { kind: 'tool_call', call: { private: 'old local result' } } } }
  ];
  it.each(enrollmentHolds)('does not enroll journal across $name', async ({ local: localData = {}, session: sessionData = {}, row = {} }) => {
    const observation = { conversationId: '11111111-2222-3333-4444-555555555555',
      event: { kind: 'assistant_message', text: 'private recorded answer' }, ...row };
    const local = new FakeStorageArea(localData);
    const session = new FakeStorageArea({ journal: [observation], ...sessionData });
    const beforeJournal = structuredClone(session.data.journal);
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && ['8765', '8770'].includes(url.port)) return response(200, {
        app: 'chat-on-steroids', instanceId: url.port === '8765' ? 'local-instance' : 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'settings-document', 'https://chatgpt.com/');
    expect(result).toMatchObject({ ok: false, error: 'account_busy' });
    expect((session.data.journal as unknown[]).length).toBe((beforeJournal as unknown[]).length);
    expect(session.data.journal).toMatchObject(beforeJournal as object);
    // The legacy cold loader normalizes auxiliary recovery fields; enrollment cannot use
    // those parsed-empty values as proof. It must not change the original connection tuple.
    for (const key of ['port', 'token', 'instanceId', 'disconnected']) {
      if (Object.hasOwn(localData, key)) expect(local.data[key]).toEqual(localData[key]);
    }
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/pair' || new URL(input).pathname === '/events')).toBe(false);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private recorded answer');
  });

  it('restores exact never-bound connection absence after a first-selection custody race without clearing the owner or journal', async () => {
    const observation = { conversationId: '11111111-2222-3333-4444-555555555555',
      event: { kind: 'assistant_message', text: 'private first observation' } };
    const owner = { nonce: '11111111-1111-4111-8111-111111111111', tab: 8 };
    const local = new FakeStorageArea();
    const session = new FakeStorageArea({ journal: [observation] });
    const actualSet = local.set.bind(local);
    local.set = async values => {
      await actualSet(values);
      if (values.instanceId === 'profile-business') await session.set({ modelCatalogOwner: owner });
    };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'settings-document', 'https://chatgpt.com/');
    expect(result).toMatchObject({ ok: false, error: 'account_busy', pendingWork: { modelCatalogOwner: 1 } });
    for (const key of ['port', 'token', 'instanceId', 'disconnected']) expect(Object.hasOwn(local.data, key)).toBe(false);
    expect(session.data.modelCatalogOwner).toEqual(owner);
    expect(session.data.journal).toEqual([observation]);
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/pair' || new URL(input).pathname === '/events')).toBe(false);
  });

  it.each([
    { name: 'late raw null port', local: { port: null } },
    { name: 'late raw prior tuple', local: { instanceId: 'profile-Epsilon', port: 8771, token: 'private-prior-token', disconnected: false } },
    { name: 'late raw native receipt', session: { pendingInputReceipts: { foreign: { private: 'unchanged native receipt' } } } }
  ])('rechecks $name at serialized first-enrollment acceptance without compensating an unwritten selection', async (late) => {
    const observation = { conversationId: '11111111-2222-3333-4444-555555555555',
      event: { kind: 'assistant_message', text: 'original never-bound observation' } };
    const local = new FakeStorageArea();
    const session = new FakeStorageArea({ journal: [observation] });
    const remove = vi.spyOn(local, 'remove');
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, { instanceId: 'profile-business', token: 'must-not-pair' });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage,
      browserController: { revoke: async () => {
        if (late.local) await local.set(late.local);
        if (late.session) await session.set(late.session);
      } } });
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'settings-document', 'https://chatgpt.com/'))
      .toMatchObject({ ok: false, error: 'account_busy', pendingWork: { journal: 1 } });
    if (late.local) expect(local.data).toMatchObject(late.local);
    if (late.session) expect(session.data).toMatchObject(late.session);
    expect(session.data.journal).toEqual([observation]);
    expect(remove).not.toHaveBeenCalled();
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events'].includes(new URL(input).pathname))).toBe(false);
  });

  it('does not erase a foreign raw selection appearing before first-enrollment absence compensation', async () => {
    const observation = { conversationId: '11111111-2222-3333-4444-555555555555',
      event: { kind: 'assistant_message', text: 'retain private observation' } };
    const selected = { instanceId: 'profile-Epsilon', port: 8771, token: 'foreign-selection-token', disconnected: false };
    const local = new FakeStorageArea();
    const session = new FakeStorageArea({ journal: [observation] });
    const remove = vi.spyOn(local, 'remove');
    const actualSet = local.set.bind(local);
    local.set = async values => {
      await actualSet(values);
      if (values.instanceId === 'profile-business') {
        await actualSet(selected);
        await session.set({ modelCatalogOwner: { nonce: 'private-retained-owner', tab: 8 } });
      }
    };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'settings-document', 'https://chatgpt.com/'))
      .toMatchObject({ ok: false, error: 'account_selection_uncertain' });
    expect(local.data).toMatchObject(selected);
    expect(remove).not.toHaveBeenCalled();
    expect(session.data.journal).toEqual([observation]);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events'].includes(new URL(input).pathname))).toBe(false);
  });

  it('preserves a newer Disconnect while first-enrollment absence compensation is pending', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let removing = false;
    const observation = { conversationId: '11111111-2222-3333-4444-555555555555',
      event: { kind: 'assistant_message', text: 'retain private first observation' } };
    const local = new FakeStorageArea();
    const session = new FakeStorageArea({ journal: [observation] });
    const actualSet = local.set.bind(local), actualRemove = local.remove.bind(local);
    local.set = async values => {
      await actualSet(values);
      if (values.instanceId === 'profile-business') await session.set({ modelCatalogOwner: { nonce: 'private-owner', tab: 8 } });
    };
    local.remove = async keys => { removing = true; await held; await actualRemove(keys); };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const older = worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'settings-document', 'https://chatgpt.com/');
    await vi.waitFor(() => expect(removing).toBe(true));
    const newer = worker.send({ type: 'unpair' });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    release();
    expect(await older).toMatchObject({ ok: false });
    expect(await newer).toMatchObject({ ok: true });
    expect(local.data).toMatchObject({ token: null, disconnected: true });
    const restarted = loadWorker({ local, session, fetch });
    expect(await restarted.send({ type: 'status' })).toMatchObject({ paired: false, disconnected: true });
    expect(session.data.journal).toEqual([observation]);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events'].includes(new URL(input).pathname))).toBe(false);
  });

  it('serializes a newer committed selection before an older first-enrollment absence compensation', async () => {
    const start = backgroundSource.indexOf('let connectionPersistTail =');
    const end = backgroundSource.indexOf('let liveWriteQueue =', start);
    const local = new FakeStorageArea();
    const selected = { instanceId: 'profile-Epsilon', port: 8771, token: 'newer-exact-token', disconnected: false };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let writing = false;
    const actualSet = local.set.bind(local);
    local.set = async values => { writing = true; await held; await actualSet(values); };
    const context = { chrome: { storage: { local } }, persistedConnection: null,
      port: null, token: null, instanceId: null, disconnected: false, selected };
    const result = vm.runInNewContext(`${backgroundSource.slice(start, end)};
      const newer = persist(selected, () => {
        ({ port, token, instanceId, disconnected } = selected); return true;
      });
      const olderCompensation = persist(undefined, null, null,
        { instanceId: 'profile-business', port: 8770, token: null, disconnected: true });
      Promise.all([newer, olderCompensation]);`, context);
    await vi.waitFor(() => expect(writing).toBe(true));
    release();
    expect(await result).toEqual([true, true]);
    expect(local.data).toMatchObject(selected);
  });

  it.each([
    { name: 'unknown nested private owner', row: { event: { kind: 'assistant_message', text: 'x', privateOwner: { secret: 'never publish' } } } },
    { name: 'malformed calls', row: { event: { kind: 'assistant_message', text: 'x', calls: 'not-array' } } },
    { name: 'invalid conversation routing', row: { conversationId: 'https://private.example/owner' } },
    { name: 'invalid observation time', row: { event: { kind: 'assistant_message', text: 'x', time: 'not-a-time' } } }
  ])('does not exempt a never-bound journal with $name', async ({ row }) => {
    const observation = { conversationId: '11111111-2222-3333-4444-555555555555',
      event: { kind: 'assistant_message', text: 'original private body' }, ...row };
    const local = new FakeStorageArea();
    const session = new FakeStorageArea({ journal: [observation] });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, { instanceId: 'profile-business', token: 'must-not-pair' });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'settings-document', 'https://chatgpt.com/'))
      .toMatchObject({ ok: false, error: 'account_busy', pendingWork: { journal: 1 } });
    expect(session.data.journal).toEqual([observation]);
    expect(fetch.mock.calls.some(([input]) => ['/pair', '/events'].includes(new URL(input).pathname))).toBe(false);
  });

  it('does not turn normalized unknown custody into enrollment proof after a worker restart', async () => {
    const observation = { conversationId: '11111111-2222-3333-4444-555555555555',
      event: { kind: 'assistant_message', text: 'preserve exact private native answer' } };
    const local = new FakeStorageArea();
    const session = new FakeStorageArea({ journal: [observation], pendingInputReceipts: { unknown: { private: 'old receipt' } } });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const before = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    expect(await before.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'old-settings', 'https://chatgpt.com/'))
      .toMatchObject({ ok: false, error: 'account_busy' });
    const restarted = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    expect(await restarted.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'new-settings', 'https://chatgpt.com/'))
      .toMatchObject({ ok: false, error: 'account_busy' });
    expect(session.data.journal).toMatchObject([observation]);
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/pair' || new URL(input).pathname === '/events')).toBe(false);
  });

  it('diagnoses an unpaired observation journal with unproven prior connection without clearing or reassigning it', async () => {
    const observation = { conversationId: '11111111-2222-3333-4444-555555555555',
      event: { kind: 'assistant_message', time: Date.now(), text: 'private recorded text' } };
    const local = new FakeStorageArea({ port: null });
    const session = new FakeStorageArea({ journal: [observation, observation] });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'document-business', 'https://chatgpt.com/');
    expect(result).toMatchObject({ ok: false, error: 'account_busy', pendingWork: { journal: 2 } });
    expect(result.message).toContain('recorded observations');
    expect(JSON.stringify(result)).not.toContain('private recorded text');
    expect(JSON.stringify(result)).not.toContain(observation.conversationId);
    expect(session.data.journal).toEqual([observation, observation]);
    expect(local.data.instanceId).toBeUndefined();
    expect(local.data.token).toBeUndefined();
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname !== '/hello')).toBe(false);
  });

  it('diagnoses pairing owner-read failure without exposing the storage exception', async () => {
    const session = new FakeStorageArea();
    const actualGet = session.get.bind(session);
    session.get = async keys => {
      if (Array.isArray(keys) && keys.includes('projectCreateOwner')) throw new Error('private-secret/storage-path');
      return actualGet(keys);
    };
    const local = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: currentPairingPage });
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'document-business', 'https://chatgpt.com/');
    expect(result).toMatchObject({ ok: false, error: 'account_busy', pendingWork: { ownerReadFailed: 1 } });
    expect(JSON.stringify(result)).not.toContain('private-secret');
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/pair')).toBe(false);
  });

  it('keeps pairing diagnostics bounded and takes live custody acquired during owner reads into account', async () => {
    const start = backgroundSource.indexOf('function companionPendingWork(');
    const end = backgroundSource.indexOf('let companionReloadFlight', start);
    const context = { journal: Array.from({ length: 5000 }, () => ({ privateText: 'not a diagnostic' })),
      journalWorkers: new Set(), closeOutbox: [], commandAckOutbox: [], deferredRevivals: [],
      inputOpenings: {}, stopOpenings: {}, commandTabLeases: {}, maintenanceFlight: null,
      modelCatalogFlight: null, pluginRefreshFlight: null, projectCreateFlight: null, deferredRecoveryWork: null,
      chrome: { storage: { session: { get: async () => ({ privateUnknownOwner: 'not a diagnostic' }) } } },
      HELLO_TIMEOUT_MS: 1200, setTimeout, clearTimeout };
    const read = () => vm.runInNewContext(`${backgroundSource.slice(start, end)}; accountPairingBusy();`, context);
    expect(await read()).toEqual({ journal: 4000 });
    context.journal = [];
    context.chrome.storage.session.get = async () => {
      context.commandTabLeases = { '8': 'private lease' };
      return { modelCatalogOwner: { nonce: 'private nonce' }, privateUnknownOwner: 'not a diagnostic' };
    };
    expect(await read()).toEqual({ commandTabLeases: 1, modelCatalogOwner: 1 });
  });

  it('publishes only fixed pairing custody categories and bounded counts', () => {
    const start = backgroundSource.indexOf('function accountBusyError(');
    const end = backgroundSource.indexOf('/** Reprove the exact isolated document', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const context = { pendingWork: { journal: 99999, maintenanceFlight: 1, commandAckOutbox: -1,
      inputOpenings: 1.5, ownerReadFailed: 'private error', unknownOwner: 'private body', __proto__: { modelCatalogOwner: 1 } } };
    const result = vm.runInNewContext(`${backgroundSource.slice(start, end)}; accountBusyError(pendingWork);`, context);
    expect(result).toMatchObject({ ok: false, error: 'account_busy', pendingWork: { journal: 4000, maintenanceFlight: 1 } });
    expect(Object.keys(result.pendingWork)).toEqual(['journal', 'maintenanceFlight']);
    expect(result.message).toMatch(/^This Chrome profile still has pending CoS work:/);
    expect(result.message).toContain('Recovery protocol 1.');
    expect(result.message.match(/Recovery protocol 1\./g)).toHaveLength(1);
    expect(result.message.length).toBeLessThanOrEqual(2400);
    expect(JSON.stringify(result)).not.toMatch(/private|unknownOwner|modelCatalogOwner/);
  });

  it('pairs only the explicitly selected account from a current ChatGPT settings document', async () => {
    const pairPorts: number[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input), candidate = Number(url.port);
      if (url.pathname === '/hello' && [8770, 8771].includes(candidate)) return response(200, {
        app: 'chat-on-steroids', instanceId: candidate === 8770 ? 'profile-business' : 'profile-Epsilon',
        displayName: candidate === 8770 ? 'Business' : 'Epsilon', bridge: BRIDGE_PROTOCOL, paired: false
      });
      if (url.pathname === '/pair') {
        pairPorts.push(candidate);
        expect(JSON.parse(String(init.body))).toEqual({ reconnect: true, instanceId: 'profile-business' });
        return response(200, { token: 'business-token', instanceId: 'profile-business' });
      }
      return response(503, {});
    });
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsSendMessage: currentPairingPage });
    const page = 'https://chatgpt.com/c/business';
    const choices = await worker.send({ type: 'accountChoices', navigationEpoch: 0 }, 1, 'document-business', page);
    expect(choices.accounts.map((row: any) => row.instanceId)).toEqual(['profile-business', 'profile-Epsilon']);
    expect(pairPorts).toEqual([]);
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business', navigationEpoch: 0 }, 1, 'document-business', page))
      .toEqual({ ok: true });
    expect(pairPorts).toEqual([8770]);
    expect(local.data).toMatchObject({ instanceId: 'profile-business', port: 8770, token: 'business-token' });
  });

  it('refuses foreign or documentless account selection before discovery', async () => {
    const local = new FakeStorageArea();
    const fetch = vi.fn(async (_input: string) => response(503, {}));
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsSendMessage: currentPairingPage });
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-Zeta' }, 1, undefined, 'https://example.com/'))
      .toMatchObject({ ok: false, error: 'popup_required' });
    expect(await worker.send({ type: 'accountChoices' }, 1, '', 'https://chatgpt.com/'))
      .toMatchObject({ ok: false, error: 'document_identity_missing' });
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-Zeta' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html-other'))
      .toMatchObject({ ok: false, error: 'popup_required' });
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname !== '/hello')).toBe(false);
    expect(local.data.instanceId).toBeUndefined();
    expect(local.data.token).toBeUndefined();
  });

  it('does not retarget when the settings document changes during account discovery', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let discoveryStarted = false;
    let pageEpoch = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') {
        discoveryStarted = true; await held;
        return response(200, { app: 'chat-on-steroids', instanceId: 'profile-business', displayName: 'Business', bridge: BRIDGE_PROTOCOL });
      }
      return response(503, {});
    });
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsSendMessage: async () => ({ ok: true, epoch: pageEpoch }) });
    const pair = worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'old-document', 'https://chatgpt.com/');
    await vi.waitFor(() => expect(discoveryStarted).toBe(true));
    pageEpoch = 1;
    release();
    expect(await pair).toMatchObject({ ok: false, error: 'stale_document' });
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/pair')).toBe(false);
    expect(local.data.instanceId).toBeUndefined();
    expect(local.data.token).toBeUndefined();
  });

  it('preserves pending browser command custody when settings requests another account', async () => {
    const local = new FakeStorageArea({ instanceId: 'local-instance', port: 8765, token: 'existing-token',
      commandTabLeases: { '3': 'existing-command-lease' } });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && url.port === '8770') return response(200, {
        app: 'chat-on-steroids', instanceId: 'profile-business', displayName: 'Business', bridge: BRIDGE_PROTOCOL
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsSendMessage: currentPairingPage });
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'document-business', 'https://chatgpt.com/'))
      .toMatchObject({ ok: false, error: 'account_busy', pendingWork: { commandTabLeases: 1 } });
    expect(local.data).toMatchObject({ instanceId: 'local-instance', port: 8765, token: 'existing-token',
      commandTabLeases: { '3': 'existing-command-lease' } });
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/pair')).toBe(false);
  });

  it('waits for a held same-tab settings handler before accepting in-page pairing', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let settingsStarted = false, pairDiscoveryStarted = false;
    const local = new FakeStorageArea({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/settings') { settingsStarted = true; await held; return response(200, {}); }
      if (url.pathname === '/hello') {
        if (url.port === '8770') pairDiscoveryStarted = true;
        return response(200, { app: 'chat-on-steroids', instanceId: url.port === '8765' ? 'local-instance' : 'profile-business',
          displayName: 'Business', bridge: BRIDGE_PROTOCOL, legacyInstance: url.port === '8765' });
      }
      if (url.pathname === '/pair') return response(200, { token: 'business-token', instanceId: 'profile-business' });
      return response(503, {});
    });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsSendMessage: currentPairingPage });
    const read = worker.send({ type: 'settings_get' }, 1, 'document-business', 'https://chatgpt.com/');
    await vi.waitFor(() => expect(settingsStarted).toBe(true));
    const pair = worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'document-business', 'https://chatgpt.com/');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(pairDiscoveryStarted).toBe(false);
    release(); await read;
    expect(await pair).toMatchObject({ ok: true });
  });

  it('refuses retargeting when a new command lease arrives during browser controller cleanup', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const revoke = vi.fn(() => held);
    const local = new FakeStorageArea({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && ['8765', '8770'].includes(url.port)) return response(200, {
        app: 'chat-on-steroids', instanceId: url.port === '8765' ? 'local-instance' : 'profile-business',
        displayName: 'Business', bridge: BRIDGE_PROTOCOL, legacyInstance: url.port === '8765'
      });
      if (url.pathname === '/pair') return response(200, { token: 'business-token', instanceId: 'profile-business' });
      return response(503, {});
    });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsSendMessage: currentPairingPage, browserController: { revoke } });
    const pair = worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'document-business', 'https://chatgpt.com/');
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    await worker.send({ type: 'redeem', id: 'pending-command', client: 'test' }, 2, 'document-command', 'https://chatgpt.com/');
    expect(Object.keys(local.data.commandTabLeases as object)).toContain('2');
    release();
    expect(await pair).toMatchObject({ ok: false, error: 'account_busy', pendingWork: { commandTabLeases: 1 } });
    expect(local.data).toMatchObject({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/pair')).toBe(false);
  });

  it('keeps the original in-memory and stored account when selection storage rejects', async () => {
    class SelectionRejectingStorage extends FakeStorageArea {
      override async set(values: Record<string, unknown>) {
        if (values.instanceId === 'profile-business') throw new Error('synthetic selection storage write failure');
        return super.set(values);
      }
    }
    const local = new SelectionRejectingStorage({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && ['8765', '8770'].includes(url.port)) return response(200, {
        app: 'chat-on-steroids', instanceId: url.port === '8765' ? 'local-instance' : 'profile-business',
        displayName: 'Business', bridge: BRIDGE_PROTOCOL, legacyInstance: url.port === '8765'
      });
      return response(503, {});
    });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsSendMessage: currentPairingPage });
    await worker.send({ type: 'status' });
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'document-business', 'https://chatgpt.com/'))
      .toMatchObject({ ok: false, error: 'account_selection_save_failed' });
    expect(local.data).toMatchObject({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    expect(await worker.send({ type: 'status' })).toMatchObject({ instanceId: 'local-instance', port: 8765, paired: true });
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/pair')).toBe(false);
  });

  it.each(['projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner'])
  ('retains %s custody after its flight has settled when the popup selects another account', async (key) => {
    const owner = key === 'modelCatalogOwner'
      ? { nonce: '11111111-1111-4111-8111-111111111111', tab: 8 }
      : { id: '11111111-1111-4111-8111-111111111111', tab: 8, documentId: 'retained-helper', navigationEpoch: 0 };
    const session = new FakeStorageArea({ [key]: owner });
    const local = new FakeStorageArea({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && ['8765', '8770'].includes(url.port)) return response(200, {
        app: 'chat-on-steroids', instanceId: url.port === '8765' ? 'local-instance' : 'profile-business',
        displayName: 'Business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, { token: 'business-token', instanceId: 'profile-business' });
      return response(503, {});
    });
    const revoke = vi.fn(async () => {});
    const worker = loadWorker({ local, session, fetch, browserController: { revoke } });
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html'))
      .toMatchObject({ ok: false, error: 'account_busy' });
    expect(revoke).not.toHaveBeenCalled();
    expect(session.data[key]).toEqual(owner);
    expect(local.data).toMatchObject({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/pair')).toBe(false);
  });

  it('does not let a cross-tab status write restore the old account during selection acceptance', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let proofCount = 0;
    let heldProof = false;
    let oldStatusProbed = false;
    class TrackingConnectionStorage extends FakeStorageArea {
      selectedWritten = false;
      staleAccountWrite = false;
      override async set(values: Record<string, unknown>) {
        if (this.selectedWritten && values.instanceId === 'local-instance') this.staleAccountWrite = true;
        await super.set(values);
        if (values.instanceId === 'profile-business') this.selectedWritten = true;
      }
    }
    const local = new TrackingConnectionStorage({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && ['8765', '8770'].includes(url.port)) {
        if (heldProof && url.port === '8765') oldStatusProbed = true;
        return response(200, { app: 'chat-on-steroids',
          instanceId: url.port === '8765' ? 'local-instance' : 'profile-business',
          displayName: 'Business', bridge: BRIDGE_PROTOCOL });
      }
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, tabsSendMessage: async () => {
      if (++proofCount === 2) { heldProof = true; await held; }
      return { ok: true, epoch: 0 };
    } });
    const pairing = worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'settings-document', 'https://chatgpt.com/');
    await vi.waitFor(() => expect(heldProof).toBe(true));
    const status = worker.send({ type: 'status' }, 2, 'status-document', 'https://chatgpt.com/');
    await vi.waitFor(() => expect(oldStatusProbed).toBe(true));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    release();
    await pairing; await status;
    expect(local.staleAccountWrite).toBe(false);
    expect(local.data).toMatchObject({ instanceId: 'profile-business', port: 8770, token: null, disconnected: true });
    const restarted = loadWorker({ local, session: new FakeStorageArea(), fetch });
    expect(await restarted.send({ type: 'status' })).toMatchObject({ instanceId: 'profile-business', paired: false, disconnected: true });
  });

  it.each(['projectCreateOwner', 'pluginRefreshOwner', 'modelCatalogOwner'].flatMap(key =>
    ['revoke', 'write'].map(phase => ({ key, phase }))))
  ('retains $key custody newly saved during $phase before confirming an account change', async ({ key, phase }) => {
    const owner = key === 'modelCatalogOwner'
      ? { nonce: '11111111-1111-4111-8111-111111111111', opening: true }
      : { id: '11111111-1111-4111-8111-111111111111', tab: 8 };
    const session = new FakeStorageArea();
    const local = new FakeStorageArea({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    const actualSet = local.set.bind(local);
    local.set = async values => {
      await actualSet(values);
      if (phase === 'write' && values.instanceId === 'profile-business') await session.set({ [key]: owner });
    };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && ['8765', '8770'].includes(url.port)) return response(200, {
        app: 'chat-on-steroids', instanceId: url.port === '8765' ? 'local-instance' : 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, { token: 'business-token', instanceId: 'profile-business' });
      return response(503, {});
    });
    const worker = loadWorker({ local, session, fetch, browserController: {
      revoke: async () => { if (phase === 'revoke') await session.set({ [key]: owner }); }
    } });
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html'))
      .toMatchObject({ ok: false, error: 'account_busy' });
    expect(local.data).toMatchObject({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    expect(local.data.disconnected).not.toBe(true);
    expect(session.data[key]).toEqual(owner);
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/pair')).toBe(false);
  });

  it('holds pairing visibly disconnected after post-write revocation and a failed rollback save', async () => {
    class RollbackRejectingStorage extends FakeStorageArea {
      selectedWritten = false;
      override async set(values: Record<string, unknown>) {
        if (this.selectedWritten && values.instanceId === 'local-instance') throw new Error('synthetic rollback storage failure');
        await super.set(values);
        if (values.instanceId === 'profile-business') this.selectedWritten = true;
      }
    }
    const local = new RollbackRejectingStorage({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && ['8765', '8770'].includes(url.port)) return response(200, {
        app: 'chat-on-steroids', instanceId: url.port === '8765' ? 'local-instance' : 'profile-business',
        displayName: 'Business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, { token: 'business-token', instanceId: 'profile-business' });
      return response(503, {});
    });
    let proofCount = 0;
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch,
      tabsSendMessage: async () => ({ ok: true, epoch: ++proofCount < 2 ? 0 : 1 }) });
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'settings-document', 'https://chatgpt.com/'))
      .toMatchObject({ ok: false, error: 'account_selection_uncertain' });
    expect(await worker.send({ type: 'status' })).toMatchObject({ paired: false, disconnected: true });
    expect(local.data).toMatchObject({ token: null, disconnected: true });
    const restarted = loadWorker({ local, session: new FakeStorageArea(), fetch });
    expect(await restarted.send({ type: 'status' })).toMatchObject({ paired: false, disconnected: true });
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/pair')).toBe(false);
  });

  it.each(['projectCreateBusy', 'pluginRefreshBusy', 'modelCatalogBusy', 'desktopInputBusy'])
  ('retains an irreversible content operation reported as %s during account selection', async (busyFlag) => {
    const local = new FakeStorageArea({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && ['8765', '8770'].includes(url.port)) return response(200, {
        app: 'chat-on-steroids', instanceId: url.port === '8765' ? 'local-instance' : 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, { token: 'business-token', instanceId: 'profile-business' });
      return response(503, {});
    });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch,
      tabsSendMessage: async () => ({ ok: true, epoch: 0, [busyFlag]: true }) });
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'settings-document', 'https://chatgpt.com/'))
      .toMatchObject({ ok: false, error: 'account_busy', pendingWork: { [busyFlag]: 1 } });
    expect(local.data).toMatchObject({ instanceId: 'local-instance', token: 'existing-token' });
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/pair')).toBe(false);
  });

  it('retains the account while an old maintenance status read is still pending', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let statusStarted = false;
    const local = new FakeStorageArea({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && ['8765', '8770'].includes(url.port)) return response(200, {
        app: 'chat-on-steroids', instanceId: url.port === '8765' ? 'local-instance' : 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/status') { statusStarted = true; await held; }
      if (url.pathname === '/pair') return response(200, { token: 'business-token', instanceId: 'profile-business' });
      return response(503, {});
    });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });
    const maintenance = worker.fireAlarm();
    await vi.waitFor(() => expect(statusStarted).toBe(true));
    const result = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined,
      'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html');
    release(); await maintenance;
    expect(result).toMatchObject({ ok: false, error: 'account_busy' });
    expect(local.data).toMatchObject({ instanceId: 'local-instance', token: 'existing-token' });
  });

  it('never publishes paired after the final token storage write rejects', async () => {
    class TokenRejectingStorage extends FakeStorageArea {
      override async set(values: Record<string, unknown>) {
        if (values.token === 'business-token') throw new Error('synthetic final token storage failure');
        return super.set(values);
      }
    }
    const local = new TokenRejectingStorage({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello' && ['8765', '8770'].includes(url.port)) return response(200, {
        app: 'chat-on-steroids', instanceId: url.port === '8765' ? 'local-instance' : 'profile-business', bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, { token: 'business-token', instanceId: 'profile-business' });
      return response(503, {});
    });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsSendMessage: currentPairingPage });
    const reply = await worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, 'settings-document', 'https://chatgpt.com/');
    expect(await worker.send({ type: 'status' })).toMatchObject({ instanceId: 'profile-business', paired: false, disconnected: true });
    expect(reply).toMatchObject({ ok: false, error: 'account_pairing_save_failed' });
    expect(local.data).toMatchObject({ instanceId: 'profile-business', token: null, disconnected: true });
    const restarted = loadWorker({ local, session: new FakeStorageArea(), fetch });
    expect(await restarted.send({ type: 'status' })).toMatchObject({ paired: false, disconnected: true });
    expect(fetch.mock.calls.filter(([input]) => new URL(input).pathname === '/pair')).toHaveLength(1);
  });

  it.each(['disconnect', 'selection'] as const)
  ('never returns stale pairing success after a newer %s during final token persistence', async (action) => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let writingToken = false;
    const local = new FakeStorageArea({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    const actualSet = local.set.bind(local);
    local.set = async values => {
      if (values.token === 'business-token') { writingToken = true; await held; }
      await actualSet(values);
    };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      const instance = url.port === '8765' ? 'local-instance' : url.port === '8770' ? 'profile-business' : 'profile-Epsilon';
      if (url.pathname === '/hello' && ['8765', '8770', '8771'].includes(url.port)) return response(200, {
        app: 'chat-on-steroids', instanceId: instance, bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') return response(200, { token: url.port === '8770' ? 'business-token' : 'Epsilon-token', instanceId: instance });
      return response(503, {});
    });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsSendMessage: currentPairingPage });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const older = worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    await vi.waitFor(() => expect(writingToken).toBe(true));
    const newer = action === 'disconnect' ? worker.send({ type: 'unpair' })
      : worker.send({ type: 'pairTo', instanceId: 'profile-Epsilon' }, 1, undefined, popup);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    release();
    expect(await older).toMatchObject({ ok: false });
    expect(await newer).toMatchObject({ ok: true });
    expect(local.data).toMatchObject(action === 'disconnect'
      ? { instanceId: 'profile-business', token: null, disconnected: true }
      : { instanceId: 'profile-Epsilon', port: 8771, token: 'Epsilon-token', disconnected: false });
    const restarted = loadWorker({ local, session: new FakeStorageArea(), fetch });
    expect(await restarted.send({ type: 'status' })).toMatchObject(action === 'disconnect'
      ? { paired: false, disconnected: true } : { instanceId: 'profile-Epsilon', paired: true });
  });

  it('does not overwrite the newer account pairing diagnostic with an old network result', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let oldPairStarted = false;
    const local = new FakeStorageArea({ instanceId: 'local-instance', port: 8765, token: 'existing-token' });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      const instance = url.port === '8765' ? 'local-instance' : url.port === '8770' ? 'profile-business' : 'profile-Epsilon';
      if (url.pathname === '/hello' && ['8765', '8770', '8771'].includes(url.port)) return response(200, {
        app: 'chat-on-steroids', instanceId: instance, bridge: BRIDGE_PROTOCOL
      });
      if (url.pathname === '/pair') {
        if (url.port === '8770') { oldPairStarted = true; await held; }
        return response(200, { token: url.port === '8770' ? 'business-token' : 'Epsilon-token', instanceId: instance });
      }
      return response(503, {});
    });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });
    const popup = 'chrome-extension://fcckeonnadegkheflpbppbddkpkdhjip/popup.html';
    const older = worker.send({ type: 'pairTo', instanceId: 'profile-business' }, 1, undefined, popup);
    await vi.waitFor(() => expect(oldPairStarted).toBe(true));
    expect(await worker.send({ type: 'pairTo', instanceId: 'profile-Epsilon' }, 1, undefined, popup)).toMatchObject({ ok: true });
    release();
    expect(await older).toMatchObject({ ok: false });
    const status = await worker.send({ type: 'status' });
    expect(status).toMatchObject({ instanceId: 'profile-Epsilon', paired: true });
    expect(status).not.toHaveProperty('pairError');
  });

  it('skips a wrong instance and pairs only with the stored browser-profile binding', async () => {
    const wanted = 'wanted-instance';
    const pairPorts: number[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      const candidate = Number(url.port);
      if (url.pathname === '/hello') {
        return response(200, {
          app: 'chat-on-steroids',
          instanceId: candidate === 8766 ? wanted : 'wrong-instance',
          legacyInstance: false,
          paired: false
        });
      }
      if (url.pathname === '/pair') {
        pairPorts.push(candidate);
        expect(JSON.parse(String(init.body))).toEqual({ reuse: true, instanceId: wanted });
        return response(200, { token: 'wanted-token', instanceId: wanted });
      }
      return response(404, {});
    });
    const local = new FakeStorageArea({ instanceId: wanted });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });

    expect(await worker.send({ type: 'status' })).toMatchObject({
      connected: true,
      port: 8766,
      paired: true,
      instanceId: wanted,
      instanceError: null
    });
    expect(pairPorts).toEqual([8766]);
  });

  it('fails closed on a malformed copied instance binding without contacting an app', async () => {
    const fetch = vi.fn(async () => response(200, { app: 'chat-on-steroids', instanceId: 'some-instance' }));
    const worker = loadWorker({
      local: new FakeStorageArea({ instanceId: 'NOT A VALID INSTANCE' }),
      session: new FakeStorageArea(),
      fetch
    });

    expect(await worker.send({ type: 'status' })).toMatchObject({
      connected: false,
      paired: false,
      instanceId: null,
      instanceError: 'invalid_instance_binding'
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not silently adopt an instance before explicit browser-profile routing (legacy=%s)', async (legacy) => {
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') {
        return response(200, {
          app: 'chat-on-steroids',
          instanceId: 'isolated-instance',
          legacyInstance: legacy,
          paired: false
        });
      }
      throw new Error('pair must not run without an explicit instance binding');
    });
    const worker = loadWorker({ local: new FakeStorageArea(), session: new FakeStorageArea(), fetch });

    expect(await worker.send({ type: 'status' })).toMatchObject({
      connected: false,
      paired: false,
      instanceId: null,
      instanceError: 'instance_binding_required'
    });
    expect(fetch).toHaveBeenCalledTimes(32);
    expect(fetch.mock.calls.every(([url]) => new URL(String(url)).pathname === '/hello')).toBe(true);
  });

  it('binds a fresh isolated instance only after the popup explicitly connects this browser profile', async () => {
    const isolatedInstanceId = 'isolated-instance';
    let pairBody: Record<string, unknown> | null = null;
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') {
        return response(200, {
          app: 'chat-on-steroids',
          instanceId: isolatedInstanceId,
          legacyInstance: false,
          paired: false
        });
      }
      if (url.pathname === '/pair') {
        pairBody = JSON.parse(String(init.body));
        return response(200, { token: 'isolated-token', instanceId: isolatedInstanceId });
      }
      return response(404, {});
    });
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });

    expect(await worker.send({ type: 'status' })).toMatchObject({
      connected: false,
      paired: false,
      instanceId: null,
      instanceError: 'instance_binding_required'
    });
    expect(await worker.send({ type: 'pair' })).toMatchObject({ ok: true });
    expect(pairBody).toEqual({ reconnect: true, instanceId: isolatedInstanceId });
    expect(local.data).toMatchObject({
      instanceId: isolatedInstanceId,
      token: 'isolated-token'
    });
  });

  it('keeps two independent browser-profile stores bound to separate instance ports and tokens', async () => {
    const accountA = { instanceId: 'account-a', port: 8765, token: 'token-account-a' };
    const accountB = { instanceId: 'account-b', port: 8766, token: 'token-account-b' };
    let active = accountA;
    const paired: Array<{ port: number; instanceId: string; token: string }> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      const candidate = Number(url.port);
      if (url.pathname === '/hello') {
        if (candidate !== active.port) return response(503, {});
        return response(200, {
          app: 'chat-on-steroids',
          instanceId: active.instanceId,
          legacyInstance: false,
          paired: false
        });
      }
      if (url.pathname === '/pair') {
        if (candidate !== active.port) return response(503, {});
        const body = JSON.parse(String(init.body)) as { reconnect?: boolean; instanceId?: string };
        expect(body).toEqual({ reconnect: true, instanceId: active.instanceId });
        paired.push({ port: candidate, instanceId: active.instanceId, token: active.token });
        return response(200, { token: active.token, instanceId: active.instanceId });
      }
      return response(404, {});
    });

    // Profile A explicitly pairs while A is the one active app instance. Its Chrome profile owns
    // this storage area; profile B gets an entirely separate storage area after the app switches.
    const localA = new FakeStorageArea();
    const workerA = loadWorker({ local: localA, session: new FakeStorageArea(), fetch });
    expect(await workerA.send({ type: 'pair' })).toMatchObject({ ok: true });
    expect(localA.data).toMatchObject(accountA);

    active = accountB;
    const localB = new FakeStorageArea();
    const workerB = loadWorker({ local: localB, session: new FakeStorageArea(), fetch });
    expect(await workerB.send({ type: 'pair' })).toMatchObject({ ok: true });
    expect(localB.data).toMatchObject(accountB);
    expect(paired).toEqual([
      { port: accountA.port, instanceId: accountA.instanceId, token: accountA.token },
      { port: accountB.port, instanceId: accountB.instanceId, token: accountB.token }
    ]);

    // A service-worker restart must honor the browser profile's durable instance binding. With B
    // active, A refuses every B hello rather than learning B's port or token. The inverse holds
    // after switching back to A. Losing a stale port is safe; crossing account identity is not.
    const restartedA = loadWorker({ local: localA, session: new FakeStorageArea(), fetch });
    expect(await restartedA.send({ type: 'status' })).toMatchObject({
      connected: false,
      paired: true,
      instanceId: accountA.instanceId
    });
    expect(localA.data).toMatchObject({ instanceId: accountA.instanceId, token: accountA.token, port: null });
    expect(localA.data.token).not.toBe(accountB.token);
    expect(localA.data.port).not.toBe(accountB.port);

    active = accountA;
    const restartedB = loadWorker({ local: localB, session: new FakeStorageArea(), fetch });
    expect(await restartedB.send({ type: 'status' })).toMatchObject({
      connected: false,
      paired: true,
      instanceId: accountB.instanceId
    });
    expect(localB.data).toMatchObject({ instanceId: accountB.instanceId, token: accountB.token, port: null });
    expect(localB.data.token).not.toBe(accountA.token);
    expect(localB.data.port).not.toBe(accountA.port);
  });

  /**
   * A `/hello` in front of every authenticated request doubled the traffic of a poll that
   * already runs every two seconds in every open tab, against a 900/min budget.
   */
  it('forwards an exact live request ownership handshake and returns the app read-back', async () => {
    const conversationId = 'abababab-cdcd-efef-1212-343434343434';
    const requestId = 'f0f00009-1111-4111-8111-111111111111';
    let body: any = null;
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/correlations') {
        body = JSON.parse(String(init.body));
        return response(200, {
          ok: true,
          conversationId,
          sessionId: '2026-08-21-live',
          requestIds: [requestId],
          confirmed: [requestId],
          complete: true
        });
      }
      return response(404, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea(),
      fetch
    });

    const reply = await worker.send({
      type: 'correlate',
      conversationId,
      calls: [{ messageId: 'request-message', tool: 'exec_command', order: 0, answered: false, requestId }]
    });

    expect(body).toMatchObject({
      conversationId,
      calls: [expect.objectContaining({ requestId, messageId: 'request-message' })]
    });
    expect(reply).toMatchObject({
      ok: true,
      status: 200,
      data: { conversationId, confirmed: [requestId], complete: true }
    });
  });

  it('forwards a document-scoped exact local-turn claim without widening correlation or native completion authority', async () => {
    const conversationId = 'cbcbcbcb-cdcd-4fef-9212-343434343434';
    const turnId = 'g-scoped-native-final';
    const requestId = 'wfr_scoped_native_final';
    let posted: Record<string, unknown> | null = null;
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/correlations') {
        posted = JSON.parse(String(init.body));
        return response(200, {
          ok: true, conversationId, confirmed: [requestId],
          confirmedTurnIds: [requestId], complete: true
        });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea(), fetch });
    const result = await worker.send({ type: 'correlate', conversationId, turnId,
      calls: [{ messageId: 'native-scope-call', tool: 'read', requestId, answered: false }] });
    expect(posted).toMatchObject({ conversationId, turnId,
      calls: [expect.objectContaining({ requestId, answered: false })] });
    expect(result).toMatchObject({ ok: true, status: 200,
      data: { confirmed: [requestId], confirmedTurnIds: [requestId] } });
    expect((await worker.send({ type: 'correlate', conversationId,
      turnId: 'foreign-page-turn', calls: [{ requestId: 'wfr_invalid_turn' }] })).ok).toBe(true);
    expect(posted).not.toHaveProperty('turnId');
    // A correlation ACK never reports provider Send or a finished Core result.
    expect(result.data).not.toHaveProperty('nativeFinalConfirmed');
  });

  it('does not re-ask where the app is before every single request', async () => {
    const server = app();
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });

    for (let n = 0; n < 5; n++) {
      await worker.send({ type: 'activity', conversationId: 'abababab-cdcd-efef-1212-343434343434', since: 0 });
    }
    const hellos = server.calls.filter((url) => url.endsWith('/hello'));
    expect(hellos.length).toBeLessThanOrEqual(1);
    expect(server.calls.filter((url) => url.includes('/activity'))).toHaveLength(5);
  });

  it('persists an authenticated app-side wake disconnect before acknowledging it', async () => {
    const sockets: WakeSocket[] = [];
    class WakeSocket {
      static OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      sent: string[] = [];
      constructor(readonly url: string) { sockets.push(this); }
      send(value: string) { this.sent.push(value); }
      close() { this.readyState = 3; this.onclose?.(); }
      open() { this.readyState = WakeSocket.OPEN; this.onopen?.(); }
      receive(value: string) { this.onmessage?.({ data: value }); }
    }
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({
      local,
      session: new FakeStorageArea(),
      WebSocket: WakeSocket,
      fetch: async (input) => new URL(input).pathname === '/hello'
        ? response(200, { app: 'chat-on-steroids', paired: true })
        : response(200, {})
    });

    await worker.fireAlarm();
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    socket.open();
    expect(socket.sent).toEqual(['paired-token']);
    socket.receive('disconnect');
    for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 0));

    expect(socket.sent).toEqual(['paired-token', 'disconnected']);
    expect(socket.readyState).toBe(3);
    expect(local.data.token).toBeNull();
    expect(local.data.disconnected).toBe(true);
    expect(await worker.send({ type: 'status' })).toMatchObject({ paired: false, disconnected: true });
  });

  it('stays disconnected once it has been disconnected', async () => {
    const server = app();
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });

    await worker.send({ type: 'status' });
    expect(server.tokens).toBe(1);

    await worker.send({ type: 'unpair' });
    expect(local.data.disconnected).toBe(true);

    // The two things that used to undo it: the next poll from a tab, and opening the
    // popup to check. Neither is a request to connect.
    const activity = await worker.send({
      type: 'activity',
      conversationId: 'abababab-cdcd-efef-1212-343434343434',
      since: 0
    });
    expect(activity.ok).toBe(false);
    expect(activity.error).toBe('disconnected');
    const status = await worker.send({ type: 'status' });
    expect(status.paired).toBe(false);
    expect(status.disconnected).toBe(true);
    expect(server.tokens).toBe(1);
  });

  it('still runs proven idle-root hygiene while explicitly disconnected', async () => {
    const now = Date.now();
    const root = { id: 6208, windowId: 7, url: 'https://chatgpt.com/', active: false, pinned: false,
      lastAccessed: now - 20 * 60_000 };
    const other = { id: 6209, windowId: 8, url: 'https://example.com/', active: false };
    const local = new FakeStorageArea({ port: null, token: null, disconnected: true });
    const session = new FakeStorageArea({
      idleRootTabs: { '6208': { appOwned: true, seenAt: now - 61_000, lastAccessedAt: root.lastAccessed,
        documentId: 'doc-6208', navigationEpoch: 0, url: root.url } },
      tabDocuments: { '6208': 'doc-6208' },
      tabEpochs: { '6208': 0 }
    });
    const fetch = vi.fn(async () => response(500, {}));
    const worker = loadWorker({
      local, session, fetch,
      tabsQuery: async query => Array.isArray(query?.url) && query.url.includes('https://chatgpt.com/')
        ? [root]
        : [root, other],
      tabsGet: async () => root,
      tabsSendMessage: async () => ({ safe: true, conversationId: null, navigationEpoch: 0 })
    });

    await worker.fireAlarm();

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(root.id,
      { type: 'clf-tab-close-check', conversationId: null },
      expect.objectContaining({ documentId: 'doc-6208' }));
    expect(fetch).not.toHaveBeenCalled();
    expect(local.data.disconnected).toBe(true);
  });

  it('does not silently re-pair after the app explicitly disconnects this browser', async () => {
    let pairCalls = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/pair') {
        pairCalls++;
        return response(200, { token: 'should-never-be-minted' });
      }
      if (url.pathname === '/activity') return response(401, { error: 'browser_disconnected' });
      return response(404, {});
    });
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });

    const activity = await worker.send({
      type: 'activity',
      conversationId: 'abababab-cdcd-efef-1212-343434343434',
      since: 0
    });

    expect(activity).toMatchObject({ ok: false, status: 401, error: 'disconnected' });
    expect(local.data.token).toBeNull();
    expect(local.data.disconnected).toBe(true);
    expect(pairCalls).toBe(0);

    // Opening the popup after the failed poll is observation, not reconnect intent.
    expect(await worker.send({ type: 'status' })).toMatchObject({ paired: false, disconnected: true });
    expect(pairCalls).toBe(0);
  });

  it('mirrors an app-side disconnect from hello before the popup can report a stale pair', async () => {
    let pairCalls = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') {
        return response(200, { app: 'chat-on-steroids', paired: false, disconnected: true });
      }
      if (url.pathname === '/pair') {
        pairCalls++;
        return response(200, { token: 'must-not-auto-pair' });
      }
      return response(404, {});
    });
    const local = new FakeStorageArea({ port: 8765, token: 'old-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });

    expect(await worker.send({ type: 'status' })).toMatchObject({
      connected: true,
      paired: false,
      disconnected: true
    });
    expect(local.data.token).toBeNull();
    expect(local.data.disconnected).toBe(true);
    expect(pairCalls).toBe(0);
  });

  it('does not let an older in-flight connect undo a later Disconnect', async () => {
    let releasePair!: () => void;
    let pairStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      pairStarted = resolve;
    });
    const pairGate = new Promise<void>((resolve) => {
      releasePair = resolve;
    });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: false });
      if (url.pathname === '/pair') {
        pairStarted();
        await pairGate;
        return response(200, { token: 'late-token' });
      }
      return response(200, {});
    });
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });

    // Status auto-connects a never-paired browser. Disconnect wins when the user clicks it
    // after that request has already left, even if the old /pair answer arrives afterwards.
    const connecting = worker.send({ type: 'status' });
    await started;
    expect(await worker.send({ type: 'unpair' })).toMatchObject({ ok: true });
    expect(local.data.disconnected).toBe(true);
    releasePair();
    await connecting;

    expect(local.data.token).toBeNull();
    expect(local.data.disconnected).toBe(true);
    expect(await worker.send({ type: 'status' })).toMatchObject({ paired: false, disconnected: true });
  });

  /** Persisted in `local`, not `session`: a choice a restart undoes is not a choice. */
  it('is still disconnected after the worker has been shut down and restarted', async () => {
    const server = app();
    const local = new FakeStorageArea();
    const first = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });
    await first.send({ type: 'status' });
    await first.send({ type: 'unpair' });

    const second = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });
    expect((await second.send({ type: 'status' })).disconnected).toBe(true);
    expect(server.tokens).toBe(1);
  });

  it('connects again when the user asks it to, and only then', async () => {
    const pairBodies: unknown[] = [];
    const server = app();
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      if (input.endsWith('/pair')) pairBodies.push(JSON.parse(String(init.body ?? '{}')));
      return server.fetch(input, init);
    });
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });
    await worker.send({ type: 'status' });
    await worker.send({ type: 'unpair' });

    expect(await worker.send({ type: 'pair' })).toMatchObject({ ok: true });
    const status = await worker.send({ type: 'status' });
    expect(status.paired).toBe(true);
    expect(status.disconnected).toBe(false);
    expect(local.data.disconnected).toBe(false);
    expect(pairBodies).toEqual([{ reuse: true }, { reconnect: true }]);
  });

  it('forces an immediate overwrite in known and newly discovered ChatGPT tabs', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: app().fetch });
    await worker.send({ type: 'bind', conversationId: '11111111-2222-3333-4444-555555555555' }, 11);
    await worker.send({ type: 'bind', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, 12);
    worker.tabsQuery.mockResolvedValueOnce([{ id: 12 }, { id: 13 }]);

    const result = await worker.send({ type: 'overwriteNow' });

    expect(result).toMatchObject({ ok: true, tabs: 3, attempted: 3 });
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(3);
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(11, { type: 'clf-overwrite-now' });
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(12, { type: 'clf-overwrite-now' });
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(13, { type: 'clf-overwrite-now' });
  });
});

/**
 * A CSS `animation` naming keyframes nobody wrote is not an error. The declaration parses,
 * the name resolves to nothing, and the element simply appears — which is how the settings
 * menu and the hover bubble both shipped with `clf-pop-in` on them and no fade at all,
 * beside a page whose own popovers fade. Nothing in the browser will ever say so, so this
 * asks the stylesheet the question instead: everything it animates, it defines.
 */
describe('the overlay stylesheet', () => {
  it('keeps the selected compact Goal and Loop mode words legible against their slider fill', async () => {
    const css = await fs.readFile(path.join(process.cwd(), 'extension', 'overlay.css'), 'utf8');
    const fill = /\.clf-menu-mode-track\[data-clf-value='goal'\] \.clf-menu-mode-fill,\s*\.clf-menu-mode-track\[data-clf-value='loop'\] \.clf-menu-mode-fill\s*\{[^}]*background:\s*(#[0-9a-f]{3,8})/i.exec(css)?.[1];
    const foreground = /\.clf-menu-mode-track\[data-clf-value='goal'\] \.clf-menu-mode-option\[aria-checked='true'\],\s*\.clf-menu-mode-track\[data-clf-value='loop'\] \.clf-menu-mode-option\[aria-checked='true'\]\s*\{[^}]*color:\s*(#[0-9a-f]{3,8})/i.exec(css)?.[1];
    expect(fill).toBeTruthy();
    expect(foreground).toBeTruthy();
    // These radios have normal 13px text; their two color stops share one
    // foreground/background pair in either ChatGPT theme.
    const luminance = (hex: string): number => {
      const digits = hex.slice(1).length === 3
        ? [...hex.slice(1)].map(value => value + value)
        : hex.slice(1).match(/.{2}/g)!.slice(0, 3);
      const channels = digits.map(value => {
        const x = Number.parseInt(value, 16) / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    const a = luminance(fill!);
    const b = luminance(foreground!);
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05))
      .toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the overlapping status field opaque in both ChatGPT themes', async () => {
    const css = await fs.readFile(path.join(process.cwd(), 'extension', 'overlay.css'), 'utf8');
    const stage = /\.clf-stage\s*\{([^}]+)\}/.exec(css)?.[1] ?? '';
    const light = /\[data-clf-theme='light'\]\s+\.clf-stage\s*\{([^}]+)\}/.exec(css)?.[1] ?? '';

    expect(stage).toContain('--clf-stage-bg: #212121');
    expect(stage).toContain('background: var(--clf-stage-bg)');
    expect(stage).not.toMatch(/background:[^;]*transparent/);
    expect(light).toContain('--clf-stage-bg: #fff');
  });

  it('defines every animation it asks for', async () => {
    const css = await fs.readFile(path.join(process.cwd(), 'extension', 'overlay.css'), 'utf8');
    const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]!));
    // Every animation this stylesheet owns is namespaced, so the name is the one token in
    // the shorthand that starts with `clf-`; durations, easings and `none` are not.
    const used = new Set(
      [...css.matchAll(/^[ 	]*animation(?:-name)?[ 	]*:([^;]+);/gm)]
        .flatMap((match) => match[1]!.split(/[\s,]+/))
        .filter((token) => token.startsWith('clf-'))
    );

    expect(used.size, 'the stylesheet animates nothing — has the namespace changed?').toBeGreaterThan(0);
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });
});

/**
 * The one request this worker makes that waits on a model rather than on the app.
 *
 * A goal written on a New Chat has no conversation to stream a draft onto, so `/goal/open`
 * holds the connection open for a whole OpenRouter completion — which the app allows 180s
 * for. This worker allowed every request ten seconds. A completion that took longer was
 * therefore abandoned here while the app went on to finish it: the account was billed for an
 * answer, the reply arrived with nobody left to receive it, and the page reported the
 * platform's opaque "signal is aborted without reason" and stopped. That is the shape these
 * tests pin — the deadline, and what a deadline is allowed to mean.
 */
describe('the goal opening, which waits on a model', () => {
  const paired = { port: 8765, token: 'paired-token' };

  /** A worker whose `/goal/open` never answers on its own, and the signal it was handed. */
  function hangingApp() {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/goal/open') {
        const signal = init.signal as AbortSignal;
        seen.signal = signal;
        return await new Promise<ReturnType<typeof response>>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return response(404, {});
    });
    return { fetch, seen };
  }

  it('waits past the ordinary request deadline, because the app is still allowed to answer', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, seen } = hangingApp();
      const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
      await worker.registerTab(5);
      const pending = worker.send({ type: 'goal_open', text: 'ship the release' }, 5);

      // Comfortably past the ten seconds every other route gets, and still inside the 180s
      // the app itself allows the model. Giving up here is the whole bug.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(seen.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(120_000);
      const reply = await pending;
      // Past the app's own deadline it does end — but as a deadline, not as prose, and as
      // something worth asking again rather than a verdict.
      expect(reply).toMatchObject({ ok: false, status: 0, retryable: true });
      expect(String(reply.error)).toContain('took too long');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The deadline this worker enforces has to stay above the one the app enforces, or the app's
   * own error handling never gets to speak. Read from both files rather than restated, because
   * the regression was precisely the two numbers drifting apart.
   */
  it('keeps its deadline above the app’s own model timeout', async () => {
    const goalSource = await fs.readFile(path.join(process.cwd(), 'src', 'main', 'goal.ts'), 'utf8');
    const appMs = Number(/const REQUEST_TIMEOUT_MS = ([\d_]+);/.exec(goalSource)?.[1]?.replace(/_/g, ''));
    const workerMs = Number(
      /const MODEL_REQUEST_TIMEOUT_MS = ([\d_]+);/.exec(backgroundSource)?.[1]?.replace(/_/g, '')
    );
    expect(Number.isFinite(appMs)).toBe(true);
    expect(workerMs).toBeGreaterThan(appMs);
    // And it is the goal opening that spends it. Nothing else here waits on a model.
    expect(backgroundSource).toContain("await call('/goal/open', {\n      method: 'POST',\n      timeoutMs: MODEL_REQUEST_TIMEOUT_MS,");
  });
});


it.each(['matching', 'wrong-document', 'unsafe-draft', 'newer-navigation', 'pinned', 'pinned-before-proof', 'pinned-during-proof'])('retires a cancelled helper only under its exact safe claim: %s', async scenario => {
  const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const tab = { id: 71, url: `https://chatgpt.com/c/${conversationId}`, active: false, pinned: scenario === 'pinned' };
  const claims = [{ id: 'old-input', owner: '71:doc:0', conversationId }, { id: 'new-input', owner: '71:doc:0', conversationId }];
  const tabsRemove = vi.fn();
  const sendMessage = vi.fn(async (..._args: unknown[]) => {
    if (scenario === 'pinned-during-proof') tab.pinned = true;
    return { safe: scenario !== 'unsafe-draft', conversationId, navigationEpoch: 0 };
  });
  const code = backgroundSource.slice(backgroundSource.indexOf('async function pruneManagedTabs('), backgroundSource.indexOf('\nfunction maintain(', backgroundSource.indexOf('async function pruneManagedTabs(')));
  const prune = vm.runInNewContext(`${code}\npruneManagedTabs`, {
    cleanConversationId: (id: string) => id, conversationForTab: () => conversationId,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    browserControlsTab: () => false,
    conversationFromUrl: (url: string) => url.split('/c/')[1], tabDocuments: { '71': scenario === 'wrong-document' ? 'replacement' : 'doc' },
    tabEpochs: { '71': 0 }, ownsDocument: () => true, journalCountForConversation: () => 0,
    tabReply: (...args: unknown[]) => sendMessage(...args),
    retireAutomaticTab: async (id: number) => { await tabsRemove(id); return true; },
    chrome: { tabs: { get: async () => ({ ...tab, pinned: tab.pinned || scenario === 'pinned-before-proof', ...(scenario === 'newer-navigation' ? { pendingUrl: 'https://chatgpt.com/' } : {}) }),
      sendMessage, remove: tabsRemove } }
  });
  await prune([tab], { managedConversations: [conversationId], retiredConversations: [conversationId], cancelledDecisionClaims: claims }, new Set(), new Set());
  expect(tabsRemove).toHaveBeenCalledTimes(scenario === 'matching' ? 1 : 0);
  if (scenario === 'matching') expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ cancelledDecisions: claims });
});

it.each(['idle', 'background-active-worker', 'background-active', 'selected', 'selected-before-proof',
  'selected-during-proof', 'selected-final', 'draft', 'pinned', 'navigation', 'navigation-final', 'journal'])
('releases an idle page only while its document remains unused: %s', async scenario => {
  const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const backgroundActive = scenario === 'background-active' || scenario === 'background-active-worker';
  const tab = { id: 71, windowId: 7, url: `https://chatgpt.com/c/${conversationId}`, active: scenario === 'selected' || backgroundActive, pinned: scenario === 'pinned' };
  const remove = vi.fn();
  const code = backgroundSource.slice(backgroundSource.indexOf('async function pruneManagedTabs('), backgroundSource.indexOf('\nfunction maintain(', backgroundSource.indexOf('async function pruneManagedTabs(')));
  let probed = false;
  let proofs = 0;
  const closeClaim = vi.fn(async () => true);
  const prune = vm.runInNewContext(`${code}\npruneManagedTabs`, {
    cleanConversationId: (id: string) => id, conversationForTab: () => conversationId,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    browserControlsTab: () => false,
    conversationFromUrl: (url: string) => url.split('/c/')[1], tabDocuments: { '71': 'doc' },
    tabEpochs: { '71': 0 }, ownsDocument: () => true,
    journalCountForConversation: () => scenario === 'journal' && probed ? 1 : 0,
    tabReply: async () => {
      probed = true;
      proofs++;
      if (scenario === 'selected-during-proof') tab.active = true;
      return { safe: scenario !== 'draft', conversationId, navigationEpoch: 0 };
    },
    transitionManagedTabCloseClaim: closeClaim,
    retireAutomaticTab: async (id: number, finalGuard: () => Promise<boolean>) => {
      if (!await finalGuard()) return false;
      await remove(id);
      return true;
    },
    storedBackgroundWindow: async () => backgroundActive ? { id: 7, focused: false } : null,
    chrome: { tabs: { get: async () => ({ ...tab, active: tab.active || scenario === 'selected-before-proof',
      ...(scenario === 'navigation' && probed ? { pendingUrl: 'https://chatgpt.com/' } : {}) }),
      query: async () => [{ ...tab,
        ...(scenario === 'selected-final' && proofs >= 2 ? { active: true } : {}),
        ...(scenario === 'navigation-final' && proofs >= 2 ? { url: 'https://chatgpt.com/' } : {}) }],
      remove },
      windows: {
        get: async () => ({ id: 7, focused: false }),
        getAll: async () => [{ id: 7, focused: false, tabs: [{ ...tab,
          ...(scenario === 'selected-final' && proofs >= 2 ? { active: true } : {}),
          ...(scenario === 'navigation-final' && proofs >= 2 ? { url: 'https://chatgpt.com/' } : {}) }] }]
      } }
  });
  await prune([tab], { managedConversations: [conversationId],
    workerConversations: scenario === 'background-active-worker' ? [conversationId] : [],
    workerTabCloseClaims: scenario === 'background-active-worker'
      ? { [conversationId]: '1234567890abcdef1234567890abcdef' }
      : {} }, new Set(), new Set([conversationId]));
  expect(remove).toHaveBeenCalledTimes(scenario === 'background-active-worker' ? 1 : 0);
  expect(closeClaim).toHaveBeenCalledTimes(scenario === 'background-active-worker' ? 2 : 0);
});

it.each(['deleted', 'not-deleted', 'protected', 'missing-claim', 'restored-before-claim', 'restored-before-consume',
  'draft', 'pinned', 'navigation', 'new-document', 'journal'] as const)(
  'closes a deleted load-error document only under its current exact main claim: %s', async state => {
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const claimId = '1234567890abcdef1234567890abcdef';
    const tab = { id: 71, windowId: 7, url: `https://chatgpt.com/c/${conversationId}`,
      active: true, pinned: state === 'pinned', pendingUrl: undefined as string | undefined };
    const remove = vi.fn();
    let probed = false;
    let liveDocument = true;
    const transition = vi.fn(async (action: string) => state !== 'restored-before-claim' &&
      !(state === 'restored-before-consume' && action === 'consume'));
    const proof = vi.fn(async (_tab: number, message: Record<string, unknown>) => {
      probed = true;
      if (state === 'navigation') tab.pendingUrl = 'https://chatgpt.com/';
      if (state === 'new-document') liveDocument = false;
      return { safe: state !== 'draft' && message.deletedConversationId === conversationId,
        conversationId, navigationEpoch: 0 };
    });
    const code = backgroundSource.slice(backgroundSource.indexOf('async function pruneManagedTabs('),
      backgroundSource.indexOf('\nfunction maintain(', backgroundSource.indexOf('async function pruneManagedTabs(')));
    const prune = vm.runInNewContext(`${code}\npruneManagedTabs`, {
      cleanConversationId: (id: string) => id, conversationForTab: () => conversationId,
      CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], browserControlsTab: () => false,
      conversationFromUrl: (url: string) => url.split('/c/')[1],
      tabDocuments: { '71': 'doc' }, tabEpochs: { '71': 0 }, ownsDocument: () => liveDocument,
      journalCountForConversation: () => state === 'journal' && probed ? 1 : 0,
      tabReply: proof, transitionManagedTabCloseClaim: transition,
      retireAutomaticTab: async (id: number, finalGuard: () => Promise<boolean>, _kind: unknown,
        afterPersistenceGuard?: () => Promise<boolean>) => {
        if (!await finalGuard()) return false;
        if (afterPersistenceGuard && !await afterPersistenceGuard()) return false;
        await remove(id); return true;
      },
      storedBackgroundWindow: async () => null,
      chrome: { tabs: { get: async () => ({ ...tab }), query: async () => [tab], remove },
        windows: { getAll: async () => [{ id: 7, focused: true, tabs: [tab] }] } }
    });
    await prune([tab], { managedConversations: [conversationId], retiredConversations: [conversationId],
      deletedConversations: state === 'not-deleted' ? [] : [conversationId],
      managedTabCloseClaims: state === 'missing-claim' ? {} : { [conversationId]: claimId } },
      new Set(state === 'protected' ? [conversationId] : []), new Set([conversationId]));
    expect(remove).toHaveBeenCalledTimes(state === 'deleted' ? 1 : 0);
    if (state === 'deleted') {
      expect(proof).toHaveBeenCalledTimes(2);
      for (const call of proof.mock.calls) expect(call[1]).toMatchObject({ deletedConversationId: conversationId });
      expect(transition.mock.calls.map(call => call[0])).toEqual(['claim', 'consume']);
    }
  });

it('keeps a stopped worker tab when its one-shot close claim is revoked before consume', async () => {
  const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const claimId = '1234567890abcdef1234567890abcdef';
  const tab = { id: 71, windowId: 7, url: `https://chatgpt.com/c/${conversationId}`,
    active: false, pinned: false };
  const remove = vi.fn();
  const transition = vi.fn(async (action: string) => action === 'claim');
  const code = backgroundSource.slice(backgroundSource.indexOf('async function pruneManagedTabs('),
    backgroundSource.indexOf('\nfunction maintain(', backgroundSource.indexOf('async function pruneManagedTabs(')));
  const prune = vm.runInNewContext(`${code}\npruneManagedTabs`, {
    cleanConversationId: (id: string) => id, conversationForTab: () => conversationId,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], browserControlsTab: () => false,
    conversationFromUrl: (url: string) => url.split('/c/')[1],
    tabDocuments: { '71': 'doc' }, tabEpochs: { '71': 0 }, ownsDocument: () => true,
    journalCountForConversation: () => 0,
    tabReply: async () => ({ safe: true, conversationId, navigationEpoch: 0 }),
    transitionManagedTabCloseClaim: transition,
    retireAutomaticTab: async (id: number, finalGuard: () => Promise<boolean>) => {
      if (!await finalGuard()) return false;
      await remove(id);
      return true;
    },
    storedBackgroundWindow: async () => null,
    chrome: {
      tabs: { get: async () => tab, query: async () => [tab], remove },
      windows: { get: async () => ({ id: 7, focused: false }),
        getAll: async () => [{ id: 7, focused: false, tabs: [tab] }] }
    }
  });

  await prune([tab], {
    managedConversations: [conversationId], workerConversations: [conversationId],
    workerTabCloseClaims: { [conversationId]: claimId }
  }, new Set(), new Set([conversationId]));

  expect(transition.mock.calls.map(call => call[0])).toEqual(['claim', 'consume']);
  expect(remove).not.toHaveBeenCalled();
});

it.each(['selected', 'pinned', 'navigation', 'document', 'core-work', 'storage-failure', 'restored', 'pending-work',
  'restored-during-final-inventory', 'pending-work-during-final-inventory',
  'missing-tab', 'unchanged'] as const)(
  'rechecks the actual retired tab after its durable retirement receipt write: %s', async change => {
    // Exercise the REAL retireAutomaticTab body, not the synthetic immediate-remove stub
    // used by pruneManagedTabs tests. Its persisted-receipt write is an asynchronous gap
    // after the managed one-shot close claim has already been consumed.
    const start = backgroundSource.indexOf('function retireAutomaticTab(');
    const end = backgroundSource.indexOf('\n/**\n * Tabs created by this extension', start);
    const body = backgroundSource.slice(start, end);
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const tab = { id: 71, url: `https://chatgpt.com/c/${conversationId}`, active: false, pinned: false,
      pendingUrl: undefined as string | undefined };
    const documents: Record<string, string> = { '71': 'original-document' };
    const epochs: Record<string, number> = { '71': 4 };
    const conversations: Record<string, string> = { '71': conversationId };
    const remove = vi.fn(async () => undefined);
    let coreWorking = false;
    let missingTab = false;
    let deleted = true;
    let pendingWork = false;
    let startWrite!: () => void;
    let releaseWrite!: () => void;
    const writeEntered = new Promise<void>(resolve => { startWrite = resolve; });
    const writeBarrier = new Promise<void>(resolve => { releaseWrite = resolve; });
    let writes = 0;
    const retire = vm.runInNewContext(`let automaticTabRetireFlight = null;\n${body}\nretireAutomaticTab`, {
      automaticTabRetirements: {}, tabDocuments: documents, tabEpochs: epochs,
      tabConversations: conversations, browserControlsTab: () => coreWorking,
      cleanConversationId: (value: string) => value, crypto: { randomUUID: () => 'test-retirement-id' },
      persistLive: async () => { if (++writes === 1) {
        startWrite(); await writeBarrier;
        if (change === 'storage-failure') throw new Error('persistent storage unavailable');
      } },
      chrome: { tabs: { query: async () => [tab, { id: 72, url: 'https://example.org/' }],
        get: async () => {
          if (missingTab) throw new Error('No tab with id');
          if (change === 'restored-during-final-inventory') deleted = false;
          if (change === 'pending-work-during-final-inventory') pendingWork = true;
          return { ...tab };
        }, remove } }
    }) as (id: number, guard: () => Promise<boolean>, kind: null, afterPersistence?: () => Promise<boolean>) => Promise<boolean>;
    const afterPersistence = vi.fn(async () => deleted && !pendingWork);
    const request = retire(71, async () => true, null,
      change === 'restored' || change === 'pending-work' ||
        change === 'restored-during-final-inventory' || change === 'pending-work-during-final-inventory'
        ? afterPersistence : undefined);
    await writeEntered;
    if (change === 'selected') tab.active = true;
    if (change === 'pinned') tab.pinned = true;
    if (change === 'navigation') tab.pendingUrl = 'https://chatgpt.com/';
    if (change === 'document') documents['71'] = 'replacement-document';
    if (change === 'core-work') coreWorking = true;
    if (change === 'missing-tab') missingTab = true;
    if (change === 'restored') deleted = false;
    if (change === 'pending-work') pendingWork = true;
    releaseWrite();
    const result = await request;
    expect(remove).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0);
    expect(result).toBe(change === 'unchanged');
    if (change === 'restored' || change === 'pending-work' ||
        change === 'restored-during-final-inventory' || change === 'pending-work-during-final-inventory') {
      expect(afterPersistence).toHaveBeenCalledTimes(1);
    }
  }
);

it.each([{ phase: 'prepared', accepted: false }, { phase: 'issued', accepted: true },
  { phase: 'removed', accepted: true }])(
  'restored tab-retirement marker is not a removal receipt before Chrome removal was $phase',
  async ({ phase, accepted }) => {
    const start = backgroundSource.indexOf('chrome.tabs.onRemoved.addListener(');
    const end = backgroundSource.indexOf('\n// A tab can survive while its ChatGPT document', start);
    const code = backgroundSource.slice(start, end);
    const retirement = { tab: 71, documentId: 'doc', navigationEpoch: 4,
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', phase };
    let listener!: (id: number, removeInfo: object) => void;
    const releaseTab = vi.fn(async (..._args: unknown[]) => true);
    let resolved!: () => void;
    const received = new Promise<void>(resolve => { resolved = resolve; });
    vm.runInNewContext(code, {
      chrome: { tabs: { onRemoved: { addListener: (handler: typeof listener) => { listener = handler; } } } },
      clearDeferredRevivalOffersForTab: () => undefined,
      serializeTab: async (_id: number, operation: () => Promise<unknown>) => { await operation(); resolved(); },
      load: async () => undefined,
      automaticTabRetirements: { '71': retirement }, tabDocuments: { '71': 'doc' },
      tabEpochs: { '71': 4 }, tabConversations: { '71': retirement.conversationId },
      cleanConversationId: (id: string) => id,
      restoreProtectedMainTab: async () => false, markTerminal: async () => 'doc',
      releaseTab, persistLive: async () => undefined
    });
    listener(71, { windowId: 7 });
    await received;
    expect(releaseTab.mock.calls).toHaveLength(1);
    expect(releaseTab.mock.calls[0]?.[6]).toBe(accepted);
  }
);

it('retires a finite one-off main tab only through its managed one-shot close claim', async () => {
  const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const claimId = 'abcdefabcdefabcdefabcdefabcdefab';
  const tab = { id: 71, windowId: 7, url: `https://chatgpt.com/c/${conversationId}`,
    active: false, pinned: false };
  const remove = vi.fn();
  const transition = vi.fn(async (_action: string, _conversationId: string, _claimId: string) => true);
  const code = backgroundSource.slice(backgroundSource.indexOf('async function pruneManagedTabs('),
    backgroundSource.indexOf('\nfunction maintain(', backgroundSource.indexOf('async function pruneManagedTabs(')));
  const prune = vm.runInNewContext(`${code}\npruneManagedTabs`, {
    cleanConversationId: (id: string) => id, conversationForTab: () => conversationId,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], browserControlsTab: () => false,
    conversationFromUrl: (url: string) => url.split('/c/')[1],
    tabDocuments: { '71': 'doc' }, tabEpochs: { '71': 0 }, ownsDocument: () => true,
    journalCountForConversation: () => 0,
    tabReply: async () => ({ safe: true, conversationId, navigationEpoch: 0 }),
    transitionManagedTabCloseClaim: transition,
    retireAutomaticTab: async (id: number, finalGuard: () => Promise<boolean>) => {
      if (!await finalGuard()) return false;
      await remove(id);
      return true;
    },
    storedBackgroundWindow: async () => null,
    chrome: {
      tabs: { get: async () => tab, query: async () => [tab], remove },
      windows: { get: async () => ({ id: 7, focused: false }),
        getAll: async () => [{ id: 7, focused: false, tabs: [tab] }] }
    }
  });

  await prune([tab], {
    managedConversations: [conversationId], finiteOneOffConversations: [conversationId],
    retiredConversations: [conversationId], managedTabCloseClaims: { [conversationId]: claimId }
  }, new Set(), new Set([conversationId]));

  expect(transition.mock.calls.map(call => call[0])).toEqual(['claim', 'consume']);
  expect(remove).toHaveBeenCalledWith(71);
});

it('vetoes duplicate retirement when the candidate becomes active in pruneManagedTabs final inventory', async () => {
  const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const keeper = { id: 70, windowId: 7, url: `https://chatgpt.com/c/${conversationId}`,
    active: true, lastAccessed: 200 };
  const duplicate = { id: 71, windowId: 7, url: `https://chatgpt.com/c/${conversationId}`,
    active: false, lastAccessed: 100 };
  const remove = vi.fn();
  let proofs = 0;
  const code = backgroundSource.slice(backgroundSource.indexOf('async function pruneManagedTabs('),
    backgroundSource.indexOf('\nfunction maintain(', backgroundSource.indexOf('async function pruneManagedTabs(')));
  const prune = vm.runInNewContext(`${code}\npruneManagedTabs`, {
    cleanConversationId: (id: string) => id,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
    conversationForTab: (tab: { url: string }) => tab.url.split('/c/')[1],
    conversationFromUrl: (url: string) => url.split('/c/')[1],
    browserControlsTab: () => false,
    tabDocuments: { '70': 'doc-70', '71': 'doc-71' }, tabEpochs: { '70': 0, '71': 0 },
    ownsDocument: () => true, journalCountForConversation: () => 0,
    tabReply: async () => { proofs++; return { safe: true, conversationId, navigationEpoch: 0 }; },
    retireAutomaticTab: async (id: number, finalGuard: () => Promise<boolean>) => {
      if (!await finalGuard()) return false;
      await remove(id);
      return true;
    },
    storedBackgroundWindow: async () => null,
    chrome: {
      tabs: {
        get: async (id: number) => id === duplicate.id ? duplicate : keeper,
        query: async () => [keeper, { ...duplicate, active: proofs >= 2 }]
      },
      windows: { get: async () => ({ focused: true }) }
    }
  });

  await prune([keeper, duplicate], { managedConversations: [conversationId] },
    new Set([conversationId]), new Set());

  expect(proofs).toBe(2);
  expect(remove).not.toHaveBeenCalled();
});

it('groups only app-managed Chrome tabs into the canonical task and worker groups', async () => {
  const workerId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
  const chatId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
  const personalId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000003';
  const tabs = [
    { id: 1, windowId: 7, groupId: -1, url: `https://chatgpt.com/c/${workerId}` },
    { id: 2, windowId: 7, groupId: -1, url: `https://chatgpt.com/c/${chatId}` },
    { id: 3, windowId: 7, groupId: -1, url: `https://chatgpt.com/c/${personalId}` }
  ];
  const group = vi.fn(async ({ tabIds }: { tabIds: number[] }) => tabIds[0] === 1 ? 11 : 12);
  const update = vi.fn(async (_groupId: number, _properties: Record<string, unknown>) => undefined);
  const code = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\nfunction maintain(', backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const organize = vm.runInNewContext(`${code}\norganizeManagedTabs`, {
    cleanConversationId: (id: string) => id,
    browserControlsTab: () => false,
    currentRootOpeningProtection: async () => ({ tabs: new Set(), markers: new Set() }),
    idleRootTabs: {}, appOwnedOpeningTabs: {}, IDLE_ROOT_CLOSE_MS: 5 * 60_000,
    exactPlainChatHome: (url: string) => url === 'https://chatgpt.com/' ? url : null,
    commandMarkerId: (id: unknown) => typeof id === 'string' && /^[a-f0-9]{16}$/i.test(id) ? id.toLowerCase() : null,
    exactBridgeCommandId: (id: unknown) => typeof id === 'string' && /^[a-f0-9]{16}$/i.test(id) ? id.toLowerCase() : null,
    conversationForTab: (tab: { url: string }) => tab.url.split('/c/')[1],
    ownedCommandRootMarker: () => null,
    chrome: {
      tabs: { group, query: async () => [] },
      tabGroups: { query: async () => [], update }
    }
  });
  await organize(tabs, { managedConversations: [workerId, chatId], workerConversations: [workerId] });
  expect(group.mock.calls.map(call => call[0].tabIds)).toEqual([[2], [1]]);
  expect(update.mock.calls.map(call => call[1])).toEqual([
    { title: 'CoS Chats', color: 'blue', collapsed: false },
    { title: 'CoS Workers', color: 'purple', collapsed: false }
  ]);
  expect(group.mock.calls.flatMap(call => call[0].tabIds)).not.toContain(3);
  group.mockClear();
  update.mockClear();
  await organize(tabs, { managedConversations: [workerId, chatId], workerConversations: [],
    helperConversations: [workerId, personalId] });
  expect(group.mock.calls.map(call => call[0].tabIds)).toEqual([[2], [1]]);
  expect(update.mock.calls.map(call => call[1].title)).toEqual(['CoS Chats', 'CoS Workers']);
  expect(group.mock.calls.flatMap(call => call[0].tabIds)).not.toContain(3);
});

it('keeps a bound worker in Workers even when its old opening marker is still classified for recovery', async () => {
  const commandId = '4e689b755134a55a';
  const workerId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000011';
  const tabs = [{ id: 11, windowId: 7, groupId: -1, pinned: false, url: `https://chatgpt.com/c/${workerId}` }];
  const group = vi.fn(async () => 31);
  const update = vi.fn(async () => undefined);
  const code = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\nfunction maintain(', backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const organize = vm.runInNewContext(`${code}\norganizeManagedTabs`, {
    cleanConversationId: (id: string) => id,
    browserControlsTab: () => false,
    currentRootOpeningProtection: async () => ({ tabs: new Set(), markers: new Set() }),
    idleRootTabs: {}, appOwnedOpeningTabs: {}, IDLE_ROOT_CLOSE_MS: 5 * 60_000,
    exactPlainChatHome: () => null,
    exactBridgeCommandId: (id: unknown) => id === commandId ? commandId : null,
    conversationForTab: () => workerId,
    ownedCommandRootMarker: () => commandId,
    cosGroupedTabs: {},
    persistLive: async () => undefined,
    chrome: {
      tabs: { group, query: async () => [] },
      tabGroups: { query: async () => [], update }
    }
  });

  await organize(tabs, {
    managedConversations: [workerId],
    workerConversations: [workerId],
    browserCommandIds: [commandId]
  });

  expect(group).toHaveBeenCalledWith({ tabIds: [11] });
  expect(update).toHaveBeenCalledWith(31, { title: 'CoS Workers', color: 'purple', collapsed: false });
});

it('groups only durable chats and workers while transient roots remain ungrouped for cleanup', async () => {
  const commandId = '4e689b755134a55a';
  const workerId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
  const chatId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
  const tabs = [
    { id: 1, windowId: 7, groupId: -1, url: `https://chatgpt.com/c/${workerId}` },
    { id: 2, windowId: 7, groupId: -1, url: `https://chatgpt.com/c/${chatId}` },
    { id: 3, windowId: 7, groupId: -1,
      url: `https://chatgpt.com/?clf=${commandId}&reasoning_effort=pro#clf=${commandId}` },
    { id: 4, windowId: 7, groupId: -1, url: 'https://chatgpt.com/' },
    { id: 5, windowId: 7, groupId: -1,
      url: `https://chatgpt.com/?clf=${commandId}&reasoning_effort=pro#clf=${commandId}` },
    { id: 6, windowId: 7, groupId: -1, url: 'https://chatgpt.com/' },
    { id: 7, windowId: 7, groupId: -1, url: 'https://chatgpt.com/' },
    { id: 8, windowId: 7, groupId: -1, url: 'https://chatgpt.com/' }
  ];
  const group = vi.fn(async ({ tabIds }: { tabIds: number[] }) => 10 + tabIds[0]!);
  const update = vi.fn(async (_groupId: number, _properties: Record<string, unknown>) => undefined);
  const helperCode = backgroundSource.slice(
    backgroundSource.indexOf('function clfCommandMarker('),
    backgroundSource.indexOf('\nfunction appOpeningMarker(', backgroundSource.indexOf('function clfCommandMarker('))
  );
  const organizeCode = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\nfunction maintain(', backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const organize = vm.runInNewContext(`${helperCode}\n${organizeCode}\norganizeManagedTabs`, {
    URL,
    browserControlsTab: () => false,
    appOwnedOpeningTabs: {
      '3': { createdAt: Date.now(), marker: commandId },
      '7': { createdAt: Date.now() - 10 * 60_000 },
      '8': { createdAt: Date.now(), conversationId: chatId,
        openRequestId: 'open-grouping-recovery', openState: 'redirected' }
    },
    idleRootTabs: { '6': { seenAt: Date.now() } },
    IDLE_ROOT_CLOSE_MS: 5 * 60_000,
    exactPlainChatHome: (url: string) => url === 'https://chatgpt.com/' ? url : null,
    currentRootOpeningProtection: async () => ({ tabs: new Set([7]), markers: new Set() }),
    cleanConversationId: (id: string) => id,
    commandMarkerId: (id: unknown) => typeof id === 'string' && /^[a-f0-9]{16}$/i.test(id) ? id.toLowerCase() : null,
    conversationForTab: (tab: { url: string }) => tab.url.includes('/c/') ? tab.url.split('/c/')[1] : null,
    conversationFromUrl: (url: unknown) => typeof url === 'string' && url.includes('/c/') ? url.split('/c/')[1] : null,
    chrome: {
      tabs: { group, query: async () => [] },
      tabGroups: { query: async () => [], update }
    }
  });

  await organize(tabs, {
    managedConversations: [workerId, chatId],
    workerConversations: [workerId],
    browserCommandIds: [commandId]
  });

  expect(group.mock.calls.map(call => call[0].tabIds)).toEqual([[2], [1]]);
  expect(update.mock.calls.map(call => call[1])).toEqual([
    { title: 'CoS Chats', color: 'blue', collapsed: false },
    { title: 'CoS Workers', color: 'purple', collapsed: false }
  ]);
  expect(group.mock.calls.flatMap(call => call[0].tabIds)).not.toContain(4);
  expect(group.mock.calls.flatMap(call => call[0].tabIds)).not.toContain(5);
  expect(group.mock.calls.flatMap(call => call[0].tabIds)).not.toContain(7);

  // Main names an exact terminal-delivery owner. Only then does orange mean attention.
  group.mockClear();
  update.mockClear();
  await organize(tabs, {
    managedConversations: [workerId, chatId],
    workerConversations: [workerId],
    browserCommandIds: [commandId],
    browserAttentionCommandIds: [commandId]
  });
  expect(group.mock.calls.map(call => call[0].tabIds)).toEqual([[2], [1]]);
  expect(update.mock.calls.map(call => call[1])).toEqual([
    { title: 'CoS Chats', color: 'blue', collapsed: false },
    { title: 'CoS Workers', color: 'purple', collapsed: false }
  ]);
  expect(group.mock.calls.flatMap(call => call[0].tabIds)).not.toContain(4);
  expect(group.mock.calls.flatMap(call => call[0].tabIds)).not.toContain(5);

  // Once main retires the old id, the exact owned root remains ungrouped while its guarded short
  // empty-page cleanup matures; losing the command does not adopt a personal New Chat tab.
  group.mockClear();
  update.mockClear();
  await organize(tabs, {
    managedConversations: [workerId, chatId],
    workerConversations: [workerId],
    browserCommandIds: [],
    browserAttentionCommandIds: []
  });
  expect(group.mock.calls.map(call => call[0].tabIds)).toEqual([[2], [1]]);
  expect(update.mock.calls.map(call => call[1])).not.toContainEqual(
    expect.objectContaining({ title: 'CoS Queue & Recovery' })
  );
});

describe('app chat placement never adopts an incognito window', () => {
  function placementHarness(windows: Array<Record<string, any>>, overrides: Record<string, any> = {}) {
    const start = backgroundSource.indexOf('function inBackgroundWindow(');
    const createStart = backgroundSource.indexOf('async function createChatTab(', start);
    const end = backgroundSource.indexOf('\n}', createStart) + 2;
    const tabsCreate = vi.fn(async (properties: Record<string, any>) => ({ id: 99, ...properties }));
    const windowsCreate = vi.fn(async (properties: Record<string, any>) => {
      const window = { id: 90, ...properties, tabs: [{ id: 100, windowId: 90, url: properties.url }] };
      windows.push(window);
      return window;
    });
    const context = {
      URL, console, backgroundWindowFlight: null, appOwnedOpeningTabs: {},
      concreteConversationForTab: (tab: { url?: string }) => tab.url?.includes('/c/') ? tab.url.split('/c/')[1] : null,
      rememberAppOwnedOpeningTab: vi.fn(async () => undefined), rememberOpenConversationTab: vi.fn(async () => undefined),
      chrome: {
        tabs: { create: tabsCreate },
        windows: {
          get: vi.fn(async (id: number) => windows.find(window => window.id === id)),
          getAll: vi.fn(async () => windows),
          create: windowsCreate,
          ...overrides
        }
      }
    };
    const create = vm.runInNewContext(`${backgroundSource.slice(start, end)}; createChatTab`, context);
    return { create, context, tabsCreate, windowsCreate };
  }

  it.each(['preferred-private', 'focused-private', 'most-chats-private'])('selects an existing regular window instead of %s', async mode => {
    const { create, tabsCreate, windowsCreate } = placementHarness([
      { id: 7, type: 'normal', incognito: true, focused: true,
        tabs: [{ url: 'https://chatgpt.com/c/private' }, { url: 'https://chatgpt.com/c/private2' }] },
      { id: 8, type: 'normal', incognito: false, focused: false, tabs: [] }
    ]);
    await create('https://chatgpt.com/?cos-input=owned', mode !== 'focused-private', mode === 'focused-private', null,
      mode === 'preferred-private' ? 7 : null);
    expect(tabsCreate).toHaveBeenCalledExactlyOnceWith({
      url: 'https://chatgpt.com/?cos-input=owned', windowId: 8, active: mode === 'focused-private'
    });
    expect(windowsCreate).not.toHaveBeenCalled();
  });

  it('retains the exact regular Prime window over a different focused regular window', async () => {
    const { create, tabsCreate } = placementHarness([
      { id: 7, type: 'normal', incognito: false, focused: false, tabs: [] },
      { id: 8, type: 'normal', incognito: false, focused: true, tabs: [] }
    ]);
    await create('https://chatgpt.com/', true, false, null, 7);
    expect(tabsCreate).toHaveBeenCalledWith({ url: 'https://chatgpt.com/', windowId: 7, active: false });
  });

  it.each(['incognito', 'popup', 'regular'])('validates the last-focused user window: %s', async mode => {
    const last = { id: 7, type: mode === 'popup' ? 'popup' : 'normal', incognito: mode === 'incognito',
      focused: true, tabs: [] };
    const { create, tabsCreate, windowsCreate } = placementHarness([
      last, { id: 8, type: 'normal', incognito: false, focused: false, tabs: [] }
    ], { getLastFocused: async () => last });
    await create('https://chatgpt.com/', false, true);
    expect(tabsCreate).toHaveBeenCalledExactlyOnceWith({
      url: 'https://chatgpt.com/', windowId: mode === 'regular' ? 7 : 8, active: true
    });
    expect(windowsCreate).not.toHaveBeenCalled();
  });

  it('does not infer that no regular window exists when the browser inventory fails', async () => {
    const { create, tabsCreate, windowsCreate } = placementHarness([], {
      getAll: async () => { throw new Error('browser inventory unavailable'); }
    });
    await expect(create('https://chatgpt.com/', true)).rejects.toThrow('chat_window_inventory_unavailable');
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(windowsCreate).not.toHaveBeenCalled();
  });

  it.each([false, true])('creates one explicit regular window when only incognito exists, background=%s', async background => {
    const { create, tabsCreate, windowsCreate, context } = placementHarness([
      { id: 7, type: 'normal', incognito: true, focused: true, tabs: [] }
    ]);
    const opened = await create('https://chatgpt.com/?cos-input=owned', background, !background);
    expect(windowsCreate).toHaveBeenCalledExactlyOnceWith({
      url: 'https://chatgpt.com/?cos-input=owned', type: 'normal', incognito: false, focused: !background
    });
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(opened).toMatchObject({ id: 100, windowId: 90 });
    expect(context.rememberAppOwnedOpeningTab).toHaveBeenCalledWith(opened, 'https://chatgpt.com/?cos-input=owned');
  });

  it('serializes concurrent background openings into one newly created regular window', async () => {
    const { create, tabsCreate, windowsCreate } = placementHarness([
      { id: 7, type: 'normal', incognito: true, focused: true, tabs: [] }
    ]);
    await Promise.all([create('https://chatgpt.com/?cos-input=first', true), create('https://chatgpt.com/?cos-input=second', true)]);
    expect(windowsCreate).toHaveBeenCalledTimes(1);
    expect(tabsCreate).toHaveBeenCalledExactlyOnceWith({ url: 'https://chatgpt.com/?cos-input=second', windowId: 90, active: false });
  });

  it('never focuses a newly created background window even if an active tab was requested', async () => {
    const { create, windowsCreate } = placementHarness([]);
    await create('https://chatgpt.com/', true, true);
    expect(windowsCreate).toHaveBeenCalledExactlyOnceWith({
      url: 'https://chatgpt.com/', type: 'normal', incognito: false, focused: false
    });
  });

  it.each([false, true])('withdraws admission after window election without opening a chat, background=%s', async background => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let waiting = false, admitted = true;
    const { create, tabsCreate, windowsCreate } = placementHarness([], {
      getAll: async () => { waiting = true; await held; return []; }
    });
    const pending = create('https://chatgpt.com/', background, !background, null, null, () => admitted);
    await vi.waitFor(() => expect(waiting).toBe(true));
    admitted = false; release();
    expect(await pending).toBeNull();
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(windowsCreate).not.toHaveBeenCalled();
  });

  it('retains native opening custody when admission changes after creating a regular window', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let waiting = false, admitted = true;
    const windowsCreate = vi.fn(async () => { waiting = true; await held;
      return { id: 90, type: 'normal', incognito: false, tabs: [{ id: 100, windowId: 90 }] }; });
    const { create, context } = placementHarness([], { create: windowsCreate });
    const pending = create('https://chatgpt.com/', true, false, { conversationId: 'original' }, null, () => admitted);
    await vi.waitFor(() => expect(waiting).toBe(true));
    admitted = false; release();
    expect(await pending).toMatchObject({ id: 100, windowId: 90 });
    expect(context.rememberAppOwnedOpeningTab).toHaveBeenCalledOnce();
    expect(context.rememberOpenConversationTab).not.toHaveBeenCalled();
  });

  it.each(['source-window', 'destination-window', 'fresh-tab'])('never consolidates a private tab or window: %s', async phase => {
    const prime = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000071';
    const root = { id: 71, windowId: 7, active: false, pinned: false,
      url: 'https://chatgpt.com/?clf=4e689b755134a55a#clf=4e689b755134a55a' };
    const tabs = [root, { id: 72, windowId: 8, url: `https://chatgpt.com/c/${prime}` }];
    const move = vi.fn();
    const start = backgroundSource.indexOf('function inBackgroundWindow(');
    const end = backgroundSource.indexOf('/** Background placement never focuses', start);
    const reconcile = vm.runInNewContext(`${backgroundSource.slice(start, end)}; reconcileBackgroundWindow`, {
      URL, console, backgroundWindowFlight: null,
      appOwnedOpeningTabs: { '71': { createdAt: Date.now(), marker: '4e689b755134a55a' } },
      cleanConversationId: (id: unknown) => typeof id === 'string' ? id : null,
      conversationForTab: (tab: { url: string }) => tab.url.split('/c/')[1] || null,
      concreteConversationForTab: (tab: { url: string }) => tab.url.split('/c/')[1] || null,
      chrome: {
        storage: { session: { get: async () => ({ chatBackgroundWindow: 7 }), remove: vi.fn() } },
        tabs: { query: async () => tabs, get: async () => ({ ...root, incognito: phase === 'fresh-tab' }), move },
        windows: {
          get: async (id: number) => ({ id, type: 'normal', incognito: phase === 'source-window' && id === 7, focused: false }),
          getAll: async () => [
            { id: 7, type: 'normal', incognito: phase === 'source-window', focused: false },
            { id: 8, type: 'normal', incognito: phase === 'destination-window', focused: true }
          ]
        }
      }
    });
    expect(await reconcile({ background: true, managedConversations: [prime], workerConversations: [], inputs: [] })).toBe(true);
    expect(move).not.toHaveBeenCalled();
  });
});

it('moves unnamed app-owned recovery roots into the normal Prime window without moving the Prime chat itself', async () => {
  const prime = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000071';
  const tabs = [
    { id: 71, windowId: 7, active: false, pinned: false,
      url: 'https://chatgpt.com/?clf=4e689b755134a55a#clf=4e689b755134a55a' },
    { id: 72, windowId: 8, active: false, pinned: false,
      url: `https://chatgpt.com/c/${prime}` }
  ];
  const move = vi.fn(async (id: number, target: { windowId: number }) => {
    const tab = tabs.find(row => row.id === id)!;
    tab.windowId = target.windowId;
    return tab;
  });
  const start = backgroundSource.indexOf('function inBackgroundWindow(');
  const end = backgroundSource.indexOf('/** Background placement never focuses', start);
  const reconcile = vm.runInNewContext(
    `${backgroundSource.slice(start, end)}\nreconcileBackgroundWindow`,
    {
      URL,
      console,
      backgroundWindowFlight: null,
      appOwnedOpeningTabs: { '71': { createdAt: Date.now(), marker: '4e689b755134a55a' } },
      cleanConversationId: (id: unknown) => typeof id === 'string' ? id : null,
      conversationForTab: (tab: { url: string }) => tab.url.includes('/c/') ? tab.url.split('/c/')[1] : null,
      concreteConversationForTab: (tab: { url: string }) => tab.url.includes('/c/') ? tab.url.split('/c/')[1] : null,
      chrome: {
        storage: { session: {
          get: async () => ({ chatBackgroundWindow: 7 }),
          set: vi.fn(),
          remove: vi.fn()
        } },
        tabs: {
          query: async () => tabs,
          get: async (id: number) => ({ ...tabs.find(row => row.id === id)! }),
          move
        },
        windows: {
          get: async (id: number) => ({ id, focused: false }),
          getAll: async () => [
            { id: 7, focused: false, tabs: [] },
            { id: 8, focused: true, tabs }
          ]
        }
      }
    }
  ) as (policy: Record<string, unknown>) => Promise<boolean>;

  expect(await reconcile({ background: true, managedConversations: [prime], workerConversations: [], inputs: [] })).toBe(true);
  expect(move).toHaveBeenCalledExactlyOnceWith(71, { windowId: 8, index: -1 });
  expect(tabs.find(tab => tab.id === 72)?.windowId).toBe(8);
});

it.each(['snapshot', 'fresh-read'])('never moves a pinned app-owned recovery root (%s)', async (phase) => {
  const marker = 'de01c492cdde4054';
  const tab = { id: 73, windowId: 8, active: false, pinned: phase === 'snapshot',
    url: `https://chatgpt.com/?clf=${marker}#clf=${marker}` };
  const move = vi.fn();
  const start = backgroundSource.indexOf('function inBackgroundWindow(');
  const end = backgroundSource.indexOf('/** Background placement never focuses', start);
  const reconcile = vm.runInNewContext(
    `${backgroundSource.slice(start, end)}\nreconcileBackgroundWindow`,
    {
      URL,
      console,
      backgroundWindowFlight: null,
      appOwnedOpeningTabs: { '73': { createdAt: Date.now(), marker } },
      cleanConversationId: (id: unknown) => typeof id === 'string' ? id : null,
      conversationForTab: () => null,
      concreteConversationForTab: () => null,
      chrome: {
        storage: { session: {
          get: async () => ({ chatBackgroundWindow: 7 }),
          set: vi.fn(),
          remove: vi.fn()
        } },
        tabs: {
          query: async () => [tab],
          get: async () => ({ ...tab, pinned: true }),
          move
        },
        windows: { get: async (id: number) => ({ id, focused: false }), getAll: async () => [] }
      }
    }
  ) as (policy: Record<string, unknown>) => Promise<boolean>;

  expect(await reconcile({ background: true, workerConversations: [], inputs: [] })).toBe(true);
  expect(move).not.toHaveBeenCalled();
});

it.each(['snapshot', 'fresh-read'])('leaves a pinned tab in place when background mode turns off (%s)', async (phase) => {
  const sourceTab = { id: 74, windowId: 7, active: false, pinned: phase === 'snapshot',
    url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-000000000074' };
  const currentTab = { ...sourceTab, pinned: true };
  const move = vi.fn();
  const remove = vi.fn();
  const start = backgroundSource.indexOf('function inBackgroundWindow(');
  const end = backgroundSource.indexOf('/** Background placement never focuses', start);
  const reconcile = vm.runInNewContext(
    `${backgroundSource.slice(start, end)}\nreconcileBackgroundWindow`,
    {
      URL,
      console,
      backgroundWindowFlight: null,
      appOwnedOpeningTabs: {},
      cleanConversationId: (id: unknown) => typeof id === 'string' ? id : null,
      conversationForTab: () => null,
      concreteConversationForTab: () => null,
      chrome: {
        storage: { session: {
          get: async () => ({ chatBackgroundWindow: 7 }),
          set: vi.fn(),
          remove
        } },
        tabs: {
          query: async () => [currentTab],
          get: async () => currentTab,
          move
        },
        windows: {
          get: async (id: number) => ({ id, focused: false }),
          getAll: async () => [
            { id: 7, focused: false, tabs: [sourceTab] },
            { id: 8, focused: true, tabs: [] }
          ]
        }
      }
    }
  ) as (policy: Record<string, unknown>) => Promise<boolean>;

  expect(await reconcile({ background: false })).toBe(true);
  expect(move).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledExactlyOnceWith('chatBackgroundWindow');
});

it('keeps opening and recovery roots ungrouped across Chrome windows', async () => {
  const first = '4e689b755134a55a';
  const second = 'de01c492cdde4054';
  const tabs = [
    { id: 81, windowId: 7, groupId: -1, pinned: false,
      url: `https://chatgpt.com/?clf=${first}#clf=${first}` },
    { id: 82, windowId: 8, groupId: -1, pinned: false,
      url: `https://chatgpt.com/?clf=${second}#clf=${second}` }
  ];
  const group = vi.fn(async () => 181);
  const update = vi.fn();
  const code = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\n/**\n * One coalesced browser-hygiene pass',
      backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const organize = vm.runInNewContext(`${code}\norganizeManagedTabs`, {
    cleanConversationId: (id: string) => id,
    currentRootOpeningProtection: async () => ({ tabs: new Set(), markers: new Set() }),
    idleRootTabs: {},
    appOwnedOpeningTabs: {
      '81': { createdAt: Date.now(), marker: first },
      '82': { createdAt: Date.now(), marker: second }
    },
    IDLE_ROOT_CLOSE_MS: 15_000,
    exactPlainChatHome: () => null,
    exactBridgeCommandId: (id: unknown) => typeof id === 'string' ? id : null,
    ownedCommandRootMarker: (tab: { id: number }) => tab.id === 81 ? first : second,
    conversationForTab: () => null,
    browserControlsTab: () => false,
    cosGroupedTabs: {},
    storedBackgroundWindow: async () => ({ id: 8 }),
    persistLive: async () => undefined,
    chrome: {
      tabs: { group, ungroup: vi.fn(), query: async () => [] },
      tabGroups: { query: async () => [], update }
    }
  });

  await organize(tabs, {
    managedConversations: [], workerConversations: [], browserCommandIds: [first, second]
  }, true);

  expect(group).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

it('leaves cleanup custody ungrouped without adopting personal roots', async () => {
  const tabs = [
    { id: 11, windowId: 7, groupId: -1, url: 'https://chatgpt.com/' },
    { id: 12, windowId: 8, groupId: -1, url: 'https://chatgpt.com/' },
    { id: 13, windowId: 8, groupId: -1, url: 'https://chatgpt.com/' }
  ];
  const move = vi.fn();
  const group = vi.fn(async ({ tabIds }: { tabIds: number[] }) => 30 + tabIds[0]!);
  const update = vi.fn();
  const code = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\n/**\n * One coalesced browser-hygiene pass',
      backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const grouped: Record<string, unknown> = {};
  const organize = vm.runInNewContext(`${code}\norganizeManagedTabs`, {
    cleanConversationId: (id: string) => id,
    exactBridgeCommandId: () => null,
    ownedCommandRootMarker: () => null,
    conversationForTab: () => null,
    conversationFromUrl: () => null,
    browserControlsTab: () => false,
    currentRootOpeningProtection: async () => ({ tabs: new Set(), markers: new Set() }),
    idleRootTabs: { '11': { seenAt: Date.now() } },
    appOwnedOpeningTabs: { '12': { createdAt: Date.now() - 10 * 60_000 } },
    IDLE_ROOT_CLOSE_MS: 5 * 60_000,
    exactPlainChatHome: (url: string) => url === 'https://chatgpt.com/' ? url : null,
    cosGroupedTabs: grouped,
    storedBackgroundWindow: async () => null,
    persistLive: async () => undefined,
    tabDocuments: {}, tabEpochs: {}, ownsDocument: () => false,
    journalCountForConversation: () => 0,
    tabReply: async () => null,
    chrome: {
      tabs: { move, group, ungroup: vi.fn(), query: async () => [] },
      tabGroups: { query: async () => [], update }
    }
  });

  await organize(tabs, { managedConversations: [], workerConversations: [] });

  expect(move).not.toHaveBeenCalled();
  expect(group).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(grouped).toEqual({});
  expect(grouped).not.toHaveProperty('13');
});

it('dissolves duplicate legacy cleanup groups during additive recovery', async () => {
  const tabs = [
    { id: 11, windowId: 7, groupId: 40, url: 'https://chatgpt.com/' },
    { id: 12, windowId: 7, groupId: 40, url: 'https://chatgpt.com/' },
    { id: 13, windowId: 7, groupId: 41, url: 'https://chatgpt.com/' }
  ];
  const groups = [
    { id: 40, windowId: 7, title: 'CoS Empty / Cleanup', color: 'grey' },
    { id: 41, windowId: 7, title: 'CoS Empty / Cleanup', color: 'grey' }
  ];
  const group = vi.fn(async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
    const id = groupId ?? 42;
    for (const tabId of tabIds) tabs.find(tab => tab.id === tabId)!.groupId = id;
    return id;
  });
  const update = vi.fn();
  const code = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\n/**\n * One coalesced browser-hygiene pass',
      backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const grouped: Record<string, unknown> = {
    '11': { groupId: 40, windowId: 7, category: 'cleanup' },
    '12': { groupId: 40, windowId: 7, category: 'cleanup' },
    '13': { groupId: 41, windowId: 7, category: 'cleanup' }
  };
  const ungroup = vi.fn(async (tabIds: number[]) => {
    for (const tabId of tabIds) tabs.find(tab => tab.id === tabId)!.groupId = -1;
  });
  const organize = vm.runInNewContext(`${code}\norganizeManagedTabs`, {
    cleanConversationId: (id: string) => id,
    currentRootOpeningProtection: async () => ({ tabs: new Set(), markers: new Set() }),
    idleRootTabs: {},
    appOwnedOpeningTabs: {
      '11': { createdAt: Date.now() - 10 * 60_000 },
      '12': { createdAt: Date.now() - 10 * 60_000 },
      '13': { createdAt: Date.now() - 10 * 60_000 }
    },
    IDLE_ROOT_CLOSE_MS: 5 * 60_000,
    exactPlainChatHome: (url: string) => url === 'https://chatgpt.com/' ? url : null,
    exactBridgeCommandId: () => null,
    ownedCommandRootMarker: () => null,
    conversationForTab: () => null,
    conversationFromUrl: () => null,
    browserControlsTab: () => false,
    cosGroupedTabs: grouped,
    storedBackgroundWindow: async () => null,
    persistLive: async () => undefined,
    tabDocuments: {}, tabEpochs: {}, ownsDocument: () => false,
    journalCountForConversation: () => 0,
    tabReply: async () => null,
    chrome: {
      tabs: {
        group,
        ungroup,
        query: async ({ groupId }: { groupId?: number }) =>
          Number.isInteger(groupId) ? tabs.filter(tab => tab.groupId === groupId) : tabs
      },
      tabGroups: { query: async () => groups.map(row => ({ ...row })), update }
    }
  });

  await organize(tabs, { managedConversations: [], workerConversations: [] }, true);

  expect(group).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(ungroup.mock.calls.map(call => call[0])).toEqual([[11, 12], [13]]);
  expect(tabs.every(tab => tab.groupId === -1)).toBe(true);
});

it('dissolves orphaned duplicate cleanup groups only after every root proves empty', async () => {
  const tabs = [
    { id: 31, windowId: 7, groupId: 50, url: 'https://chatgpt.com/', pinned: false },
    { id: 32, windowId: 7, groupId: 51, url: 'https://chatgpt.com/', pinned: false }
  ];
  const groups = [
    { id: 50, windowId: 7, title: 'CoS Empty / Cleanup', color: 'grey' },
    { id: 51, windowId: 7, title: 'CoS Empty / Cleanup', color: 'grey' }
  ];
  const ungroup = vi.fn(async (tabIds: number[]) => {
    for (const tabId of tabIds) tabs.find(tab => tab.id === tabId)!.groupId = -1;
  });
  const code = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\n/**\n * One coalesced browser-hygiene pass',
      backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const organize = vm.runInNewContext(`${code}\norganizeManagedTabs`, {
    cleanConversationId: (id: string) => id,
    currentRootOpeningProtection: async () => ({ tabs: new Set(), markers: new Set() }),
    idleRootTabs: {}, appOwnedOpeningTabs: {}, IDLE_ROOT_CLOSE_MS: 5 * 60_000,
    exactPlainChatHome: (url: string) => url === 'https://chatgpt.com/' ? url : null,
    exactIdleChatHome: (url: string) => url === 'https://chatgpt.com/' ? url : null,
    exactBridgeCommandId: () => null, ownedCommandRootMarker: () => null,
    conversationForTab: () => null, conversationFromUrl: () => null,
    browserControlsTab: () => false, cosGroupedTabs: {}, storedBackgroundWindow: async () => null,
    persistLive: async () => undefined,
    tabDocuments: { '31': 'doc-31', '32': 'doc-32' }, tabEpochs: { '31': 0, '32': 0 },
    ownsDocument: (source: { tab: number; documentId?: string; navigationEpoch?: number }) =>
      source.documentId === `doc-${source.tab}` && source.navigationEpoch === 0,
    journalCountForConversation: () => 0,
    tabReply: async (id: number) => ({ safe: true, conversationId: null, navigationEpoch: id === 31 ? 0 : 0 }),
    chrome: {
      tabs: {
        get: async (id: number) => ({ ...tabs.find(row => row.id === id)! }),
        group: vi.fn(), ungroup,
        query: async ({ groupId }: { groupId?: number }) =>
          Number.isInteger(groupId) ? tabs.filter(tab => tab.groupId === groupId) : tabs
      },
      tabGroups: { query: async () => groups.map(row => ({ ...row })), update: vi.fn() }
    }
  });

  await organize(tabs, { managedConversations: [], workerConversations: [] }, true);

  expect(ungroup.mock.calls.map(call => call[0])).toEqual([[31], [32]]);
  expect(tabs.every(tab => tab.groupId === -1)).toBe(true);
});

it('keeps cleanup and named work in their existing Chrome windows', async () => {
  const chatId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000021';
  const workerId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000022';
  const tabs = [
    { id: 21, windowId: 7, groupId: -1, url: `https://chatgpt.com/c/${chatId}`,
      active: false, pinned: false },
    { id: 22, windowId: 9, groupId: -1, url: `https://chatgpt.com/c/${workerId}`,
      active: false, pinned: false },
    { id: 23, windowId: 8, groupId: -1, url: 'https://chatgpt.com/',
      active: true, pinned: false, lastAccessed: Date.now() }
  ];
  const move = vi.fn(async (id: number, target: { windowId: number }) => {
    const tab = tabs.find(row => row.id === id)!;
    tab.windowId = target.windowId;
    return tab;
  });
  const group = vi.fn(async ({ tabIds }: { tabIds: number[] }) => 40 + tabIds[0]!);
  const update = vi.fn();
  const code = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\n/**\n * One coalesced browser-hygiene pass',
      backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const organize = vm.runInNewContext(`${code}\norganizeManagedTabs`, {
    cleanConversationId: (id: string) => id,
    exactBridgeCommandId: () => null,
    ownedCommandRootMarker: () => null,
    conversationForTab: (tab: { url: string }) => tab.url.includes('/c/') ? tab.url.split('/c/')[1] : null,
    conversationFromUrl: (url: string) => url.includes('/c/') ? url.split('/c/')[1] : null,
    browserControlsTab: () => false,
    currentRootOpeningProtection: async () => ({ tabs: new Set(), markers: new Set() }),
    idleRootTabs: { '23': { seenAt: Date.now() } }, appOwnedOpeningTabs: {},
    IDLE_ROOT_CLOSE_MS: 5 * 60_000,
    exactPlainChatHome: (url: string) => url === 'https://chatgpt.com/' ? url : null,
    cosGroupedTabs: {},
    storedBackgroundWindow: async () => null,
    persistLive: async () => undefined,
    tabDocuments: { '21': 'doc-21', '22': 'doc-22' }, tabEpochs: { '21': 0, '22': 0 },
    ownsDocument: (source: { documentId?: string }) => Boolean(source.documentId),
    journalCountForConversation: () => 0,
    tabReply: async (_id: number, message: { conversationId: string }) =>
      ({ safe: true, conversationId: message.conversationId, navigationEpoch: 0 }),
    chrome: {
      tabs: {
        get: async (id: number) => ({ ...tabs.find(row => row.id === id)! }),
        move, group, ungroup: vi.fn(), query: async () => []
      },
      tabGroups: { query: async () => [], update }
    }
  });

  await organize(tabs, {
    managedConversations: [chatId, workerId], workerConversations: [workerId]
  });

  expect(move).not.toHaveBeenCalled();
  expect(tabs.find(tab => tab.id === 21)?.windowId).toBe(7);
  expect(tabs.find(tab => tab.id === 22)?.windowId).toBe(9);
  expect(tabs.find(tab => tab.id === 23)?.windowId).toBe(8);
  expect(group.mock.calls.map(call => call[0].tabIds)).toEqual([[21], [22]]);
});

it('hydrates persisted browser-control leases before maintenance can enter tab hygiene', async () => {
  const start = backgroundSource.indexOf('async function hydrateBrowserControlLeases(');
  const end = backgroundSource.indexOf('\nglobalThis.chrome?.debugger?.onEvent', start);
  const hydrate = vm.runInNewContext(
    `${backgroundSource.slice(start, end)}\nhydrateBrowserControlLeases`,
    {
      chrome: { debugger: {} },
      getBrowserController: async () => ({ ready: () => ready })
    }
  ) as () => Promise<boolean>;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let settled = false;
  const work = hydrate().then(value => { settled = value; });
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await work;
  expect(settled).toBe(true);

  const maintain = backgroundSource.slice(
    backgroundSource.indexOf('async function maintainOnce('),
    backgroundSource.indexOf('\nasync function performBrowserRepairs(', backgroundSource.indexOf('async function maintainOnce('))
  );
  expect(maintain.indexOf('await hydrateBrowserControlLeases()')).toBeGreaterThanOrEqual(0);
  expect(maintain.indexOf('await hydrateBrowserControlLeases()'))
    .toBeLessThan(maintain.indexOf('await maintainTabHygiene('));
  expect(maintain).toContain('reply.data.recoveryMonitoring === true || repairs.length > 0');
});

it('groups exact managed tabs in place without detaching them across Chrome windows', async () => {
  const chatId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
  const workerId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
  const personalId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000003';
  const pinnedId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000004';
  const leasedId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000005';
  const draftId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000006';
  const tabs = [
    { id: 1, windowId: 7, groupId: -1, url: `https://chatgpt.com/c/${chatId}`, active: true, pinned: false },
    { id: 2, windowId: 8, groupId: -1, url: `https://chatgpt.com/c/${workerId}`, active: false, pinned: false },
    { id: 3, windowId: 8, groupId: -1, url: `https://chatgpt.com/c/${personalId}`, active: false, pinned: false },
    { id: 4, windowId: 8, groupId: -1, url: `https://chatgpt.com/c/${pinnedId}`, active: false, pinned: true },
    { id: 5, windowId: 9, groupId: -1, url: `https://chatgpt.com/c/${leasedId}`, active: false, pinned: false },
    { id: 6, windowId: 9, groupId: -1, url: `https://chatgpt.com/c/${draftId}`, active: false, pinned: false }
  ];
  const groups: Array<{ id: number; windowId: number; title: string; color?: string }> = [];
  let nextGroup = 20;
  const move = vi.fn(async (id: number, target: { windowId: number }) => {
    const tab = tabs.find(row => row.id === id)!;
    tab.windowId = target.windowId;
    tab.groupId = -1;
    return tab;
  });
  const group = vi.fn(async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
    const id = groupId ?? ++nextGroup;
    const windowId = tabs.find(row => row.id === tabIds[0])!.windowId;
    if (!groups.some(row => row.id === id)) groups.push({ id, windowId, title: '' });
    for (const tabId of tabIds) tabs.find(row => row.id === tabId)!.groupId = id;
    return id;
  });
  const update = vi.fn(async (id: number, properties: { title: string; color: string }) => {
    Object.assign(groups.find(row => row.id === id)!, properties);
  });
  const code = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\n/**\n * One coalesced browser-hygiene pass', backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const grouped: Record<string, unknown> = {};
  const ungroup = vi.fn(async (tabIds: number[]) => {
    for (const tabId of tabIds) tabs.find(tab => tab.id === tabId)!.groupId = -1;
  });
  const organize = vm.runInNewContext(`${code}\norganizeManagedTabs`, {
    cleanConversationId: (id: string) => id,
    currentRootOpeningProtection: async () => ({ tabs: new Set(), markers: new Set() }),
    idleRootTabs: {}, appOwnedOpeningTabs: {}, IDLE_ROOT_CLOSE_MS: 5 * 60_000,
    exactPlainChatHome: (url: string) => url === 'https://chatgpt.com/' ? url : null,
    exactBridgeCommandId: () => null,
    ownedCommandRootMarker: () => null,
    conversationForTab: (tab: { url: string }) => tab.url.split('/c/')[1],
    conversationFromUrl: (url: string) => url.split('/c/')[1],
    browserControlsTab: (id: number) => id === 5,
    cosGroupedTabs: grouped,
    tabDocuments: { '1': 'doc-1', '2': 'doc-2', '4': 'doc-4', '5': 'doc-5', '6': 'doc-6' },
    tabEpochs: { '1': 0, '2': 0, '4': 0, '5': 0, '6': 0 },
    ownsDocument: (source: { documentId?: string }) => Boolean(source.documentId),
    journalCountForConversation: () => 0,
    tabReply: async (id: number, message: { conversationId: string }) =>
      ({ safe: id !== 6, conversationId: message.conversationId, navigationEpoch: 0 }),
    storedBackgroundWindow: async () => null,
    persistLive: async () => undefined,
    chrome: {
      tabs: {
        get: async (id: number) => ({ ...tabs.find(row => row.id === id)! }),
        move,
        group,
        ungroup,
        query: async ({ groupId }: { groupId?: number }) =>
          Number.isInteger(groupId) ? tabs.filter(tab => tab.groupId === groupId) : tabs
      },
      tabGroups: { query: async () => groups.map(row => ({ ...row })), update }
    }
  });
  await organize(tabs, {
    managedConversations: [chatId, workerId, pinnedId, leasedId, draftId],
    workerConversations: [workerId]
  });
  expect(move).not.toHaveBeenCalled();
  expect(group.mock.calls.map(call => call[0].tabIds)).toEqual([[1], [2], [6]]);
  expect(group.mock.calls.flatMap(call => call[0].tabIds)).not.toContain(3);
  expect(group.mock.calls.flatMap(call => call[0].tabIds)).not.toContain(4);
  expect(group.mock.calls.flatMap(call => call[0].tabIds)).not.toContain(5);
  expect(groups.filter(row => row.title.startsWith('CoS '))).toHaveLength(3);
  expect(tabs.find(tab => tab.id === 3)?.windowId).toBe(8);
  expect(tabs.filter(tab => [4, 5, 6].includes(tab.id)).map(tab => tab.windowId)).toEqual([8, 9, 9]);
  // Routine maintenance must not expand a group the user deliberately collapsed.
  for (const row of groups) Object.assign(row, { collapsed: true });
  group.mockClear();
  update.mockClear();
  await organize(tabs, {
    managedConversations: [chatId, workerId, pinnedId, leasedId, draftId],
    workerConversations: [workerId]
  });
  expect(update.mock.calls.every(call => !Object.hasOwn(call[1], 'collapsed'))).toBe(true);
  expect(groups.every(row => (row as typeof row & { collapsed: boolean }).collapsed)).toBe(true);
});

it('groups active managed chats and workers without moving or closing them', async () => {
  const chatId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000031';
  const workerId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000032';
  const personalId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000033';
  const tabs = [
    { id: 31, windowId: 7, groupId: -1, url: `https://chatgpt.com/c/${chatId}`,
      active: true, pinned: false, lastAccessed: 300 },
    { id: 32, windowId: 8, groupId: -1, url: `https://chatgpt.com/c/${workerId}`,
      active: true, pinned: false, lastAccessed: 200 },
    { id: 33, windowId: 8, groupId: -1, url: `https://chatgpt.com/c/${personalId}`,
      active: false, pinned: false }
  ];
  const groups: Array<{ id: number; windowId: number; title: string }> = [];
  const move = vi.fn(async (id: number, target: { windowId: number }) => {
    const tab = tabs.find(row => row.id === id)!;
    tab.windowId = target.windowId;
    tab.groupId = -1;
    return tab;
  });
  const group = vi.fn(async ({ tabIds }: { tabIds: number[] }) => {
    const id = 60 + tabIds[0]!;
    groups.push({ id, windowId: tabs.find(tab => tab.id === tabIds[0])!.windowId, title: '' });
    for (const tabId of tabIds) tabs.find(tab => tab.id === tabId)!.groupId = id;
    return id;
  });
  const code = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\n/**\n * One coalesced browser-hygiene pass',
      backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const organize = vm.runInNewContext(`${code}\norganizeManagedTabs`, {
    cleanConversationId: (id: string) => id,
    currentRootOpeningProtection: async () => ({ tabs: new Set(), markers: new Set() }),
    idleRootTabs: {}, appOwnedOpeningTabs: {}, IDLE_ROOT_CLOSE_MS: 5 * 60_000,
    exactPlainChatHome: (url: string) => url === 'https://chatgpt.com/' ? url : null,
    exactBridgeCommandId: () => null,
    ownedCommandRootMarker: () => null,
    conversationForTab: (tab: { url: string }) => tab.url.split('/c/')[1],
    conversationFromUrl: (url: string) => url.split('/c/')[1],
    browserControlsTab: () => false,
    cosGroupedTabs: {},
    tabDocuments: { '31': 'doc-31', '32': 'doc-32' },
    tabEpochs: { '31': 0, '32': 0 },
    ownsDocument: () => true,
    journalCountForConversation: () => 0,
    tabReply: async (_id: number, message: { conversationId: string }) =>
      ({ safe: true, conversationId: message.conversationId, navigationEpoch: 0 }),
    storedBackgroundWindow: async () => null,
    persistLive: async () => undefined,
    chrome: {
      tabs: {
        get: async (id: number) => ({ ...tabs.find(tab => tab.id === id)! }),
        move, group, ungroup: vi.fn(),
        query: async ({ groupId }: { groupId?: number }) =>
          Number.isInteger(groupId) ? tabs.filter(tab => tab.groupId === groupId) : tabs
      },
      tabGroups: {
        query: async () => groups.map(row => ({ ...row })),
        update: async (id: number, properties: { title: string }) =>
          Object.assign(groups.find(row => row.id === id)!, properties)
      }
    }
  });

  await organize(tabs, {
    managedConversations: [chatId, workerId], workerConversations: [workerId]
  });

  expect(move).not.toHaveBeenCalled();
  expect(group.mock.calls.map(call => call[0].tabIds)).toEqual([[31], [32]]);
  expect(groups.map(row => ({ windowId: row.windowId, title: row.title }))).toEqual([
    { windowId: 7, title: 'CoS Chats' },
    { windowId: 8, title: 'CoS Workers' }
  ]);
  expect(group.mock.calls.flatMap(call => call[0].tabIds)).not.toContain(33);
});

it('adds loose recovered chats to their existing group without reconciling live layout', async () => {
  const first = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000041';
  const recovered = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000042';
  const tabs = [
    { id: 41, windowId: 7, groupId: 90, url: `https://chatgpt.com/c/${first}`, pinned: false },
    { id: 42, windowId: 7, groupId: -1, url: `https://chatgpt.com/c/${recovered}`, pinned: false }
  ];
  const groups = [{ id: 90, windowId: 7, title: 'CoS Chats', color: 'blue' }];
  const group = vi.fn(async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
    const id = groupId ?? 91;
    for (const tabId of tabIds) tabs.find(tab => tab.id === tabId)!.groupId = id;
    return id;
  });
  const ungroup = vi.fn();
  const code = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\n/**\n * One coalesced browser-hygiene pass',
      backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const organize = vm.runInNewContext(`${code}\norganizeManagedTabs`, {
    cleanConversationId: (id: string) => id,
    currentRootOpeningProtection: async () => ({ tabs: new Set(), markers: new Set() }),
    idleRootTabs: {}, appOwnedOpeningTabs: {}, IDLE_ROOT_CLOSE_MS: 5 * 60_000,
    exactPlainChatHome: (url: string) => url === 'https://chatgpt.com/' ? url : null,
    exactBridgeCommandId: () => null,
    ownedCommandRootMarker: () => null,
    conversationForTab: (tab: { url: string }) => tab.url.split('/c/')[1],
    conversationFromUrl: (url: string) => url.split('/c/')[1],
    browserControlsTab: () => false,
    cosGroupedTabs: { '41': { groupId: 90, windowId: 7, category: 'chat' } },
    tabDocuments: {}, tabEpochs: {}, ownsDocument: () => false,
    journalCountForConversation: () => 0, tabReply: async () => null,
    storedBackgroundWindow: async () => null,
    persistLive: async () => undefined,
    chrome: {
      tabs: {
        get: async (id: number) => ({ ...tabs.find(tab => tab.id === id)! }),
        group,
        ungroup,
        query: async ({ groupId }: { groupId?: number }) =>
          Number.isInteger(groupId) ? tabs.filter(tab => tab.groupId === groupId) : tabs
      },
      tabGroups: {
        query: async () => groups.map(row => ({ ...row })),
        update: vi.fn(async () => undefined)
      }
    }
  });

  await organize(tabs, { managedConversations: [first, recovered], workerConversations: [] }, true);

  expect(group).toHaveBeenCalledExactlyOnceWith({ tabIds: [42], groupId: 90 });
  expect(ungroup).not.toHaveBeenCalled();
  expect(tabs[0]!.groupId).toBe(90);
  expect(tabs[1]!.groupId).toBe(90);
});

it('merges exact same-category duplicate groups during recovery without moving windows', async () => {
  const ids = [1, 2, 3].map(n => `aaaaaaaa-bbbb-4ccc-8ddd-00000000005${n}`);
  const tabs = [
    { id: 51, windowId: 7, groupId: 90, url: `https://chatgpt.com/c/${ids[0]}`, pinned: false },
    { id: 52, windowId: 7, groupId: 91, url: `https://chatgpt.com/c/${ids[1]}`, pinned: false },
    { id: 53, windowId: 7, groupId: -1, url: `https://chatgpt.com/c/${ids[2]}`, pinned: false }
  ];
  const groups = [
    { id: 90, windowId: 7, title: 'CoS Chats', color: 'blue' },
    { id: 91, windowId: 7, title: 'CoS Chats', color: 'blue' }
  ];
  const group = vi.fn(async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
    const id = groupId ?? 92;
    for (const tabId of tabIds) tabs.find(tab => tab.id === tabId)!.groupId = id;
    return id;
  });
  const ungroup = vi.fn();
  const move = vi.fn();
  const code = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\n/**\n * One coalesced browser-hygiene pass',
      backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const organize = vm.runInNewContext(`${code}\norganizeManagedTabs`, {
    cleanConversationId: (id: string) => id,
    currentRootOpeningProtection: async () => ({ tabs: new Set(), markers: new Set() }),
    idleRootTabs: {}, appOwnedOpeningTabs: {}, IDLE_ROOT_CLOSE_MS: 5 * 60_000,
    exactPlainChatHome: (url: string) => url === 'https://chatgpt.com/' ? url : null,
    exactBridgeCommandId: () => null,
    ownedCommandRootMarker: () => null,
    conversationForTab: (tab: { url: string }) => tab.url.split('/c/')[1],
    conversationFromUrl: (url: string) => url.split('/c/')[1],
    browserControlsTab: () => false,
    cosGroupedTabs: {
      '51': { groupId: 90, windowId: 7, category: 'chat' },
      '52': { groupId: 91, windowId: 7, category: 'chat' }
    },
    tabDocuments: {}, tabEpochs: {}, ownsDocument: () => false,
    journalCountForConversation: () => 0, tabReply: async () => null,
    storedBackgroundWindow: async () => null,
    persistLive: async () => undefined,
    chrome: {
      tabs: {
        get: async (id: number) => ({ ...tabs.find(tab => tab.id === id)! }),
        move,
        group,
        ungroup,
        query: async ({ groupId }: { groupId?: number }) =>
          Number.isInteger(groupId) ? tabs.filter(tab => tab.groupId === groupId) : tabs
      },
      tabGroups: {
        query: async () => groups.map(row => ({ ...row })),
        update: vi.fn(async () => undefined)
      }
    }
  });

  await organize(tabs, { managedConversations: ids, workerConversations: [] }, true);

  expect(group).toHaveBeenCalledExactlyOnceWith({ tabIds: [52, 53], groupId: 90 });
  expect(tabs.map(tab => tab.groupId)).toEqual([90, 90, 90]);
  expect(move).not.toHaveBeenCalled();
  expect(ungroup).not.toHaveBeenCalled();

  await organize(tabs, { managedConversations: ids, workerConversations: [] }, false);

  expect(group).toHaveBeenCalledTimes(1);
  expect(tabs.every(tab => tab.groupId === 90)).toBe(true);
  expect(move).not.toHaveBeenCalled();
  expect(ungroup).not.toHaveBeenCalled();
});

it('converges three duplicate CoS Chats groups into one canonical Chrome window', async () => {
  const first = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000071';
  const second = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000072';
  const third = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000073';
  const tabs = [
    { id: 71, windowId: 7, groupId: 90, url: `https://chatgpt.com/c/${first}`,
      active: true, pinned: false },
    { id: 72, windowId: 8, groupId: 91, url: `https://chatgpt.com/c/${second}`,
      active: true, pinned: false },
    { id: 73, windowId: 9, groupId: 92, url: `https://chatgpt.com/c/${third}`,
      active: true, pinned: false }
  ];
  const groups = [
    { id: 90, windowId: 7, title: 'CoS Chats', color: 'blue' },
    { id: 91, windowId: 8, title: 'CoS Chats', color: 'blue' },
    { id: 92, windowId: 9, title: 'CoS Chats', color: 'blue' }
  ];
  const move = vi.fn(async (id: number, target: { windowId: number }) => {
    const tab = tabs.find(row => row.id === id)!;
    const sourceGroup = tab.groupId;
    tab.windowId = target.windowId;
    tab.groupId = -1;
    groups.splice(groups.findIndex(group => group.id === sourceGroup), 1);
    return { ...tab };
  });
  const group = vi.fn(async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
    const id = groupId ?? 92;
    for (const tabId of tabIds) tabs.find(tab => tab.id === tabId)!.groupId = id;
    return id;
  });
  const code = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\n/**\n * One coalesced browser-hygiene pass',
      backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const ungroup = vi.fn(async (tabIds: number[]) => {
    for (const tabId of tabIds) tabs.find(tab => tab.id === tabId)!.groupId = -1;
  });
  const organize = vm.runInNewContext(`${code}\norganizeManagedTabs`, {
    cleanConversationId: (id: string) => id,
    currentRootOpeningProtection: async () => ({ tabs: new Set(), markers: new Set() }),
    idleRootTabs: {}, appOwnedOpeningTabs: {}, IDLE_ROOT_CLOSE_MS: 15_000,
    exactPlainChatHome: (url: string) => url === 'https://chatgpt.com/' ? url : null,
    exactBridgeCommandId: () => null,
    ownedCommandRootMarker: () => null,
    conversationForTab: (tab: { url: string }) => tab.url.split('/c/')[1],
    browserControlsTab: () => false,
    cosGroupedTabs: {
      '71': { groupId: 90, windowId: 7, category: 'chat' },
      '72': { groupId: 91, windowId: 8, category: 'chat' }
    },
    storedBackgroundWindow: async () => null,
    persistLive: async () => undefined,
    chrome: {
      tabs: {
        get: async (id: number) => ({ ...tabs.find(tab => tab.id === id)! }),
        move,
        group,
        ungroup,
        query: async ({ groupId }: { groupId?: number }) =>
          Number.isInteger(groupId) ? tabs.filter(tab => tab.groupId === groupId) : tabs
      },
      windows: { get: async (id: number) => ({ focused: id === 7 }) },
      tabGroups: {
        query: async () => groups.map(row => ({ ...row })),
        update: vi.fn(async () => undefined)
      }
    }
  });

  await organize(tabs, { managedConversations: [first, second, third], workerConversations: [] }, true);

  expect(move).toHaveBeenCalledTimes(2);
  expect(move).toHaveBeenCalledWith(72, { windowId: 7, index: -1 });
  expect(move).toHaveBeenCalledWith(73, { windowId: 7, index: -1 });
  expect(group).toHaveBeenCalledWith({ tabIds: [72, 73], groupId: 90 });
  expect(tabs.every(tab => tab.windowId === 7 && tab.groupId === 90)).toBe(true);
});

it('removes redirected plain homes from stale CoS Chats groups during additive recovery', async () => {
  const chatId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000061';
  const tabs = [
    { id: 61, windowId: 7, groupId: 90, url: 'https://chatgpt.com/', pinned: false },
    { id: 62, windowId: 7, groupId: 90, url: `https://chatgpt.com/c/${chatId}`, pinned: false }
  ];
  const groups = [{ id: 90, windowId: 7, title: 'CoS Chats', color: 'blue' }];
  let nextGroup = 90;
  const group = vi.fn(async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
    const id = groupId ?? ++nextGroup;
    if (!groups.some(row => row.id === id)) groups.push({ id, windowId: 7, title: '', color: '' });
    for (const tabId of tabIds) tabs.find(tab => tab.id === tabId)!.groupId = id;
    return id;
  });
  const update = vi.fn(async (id: number, properties: { title: string; color: string }) => {
    Object.assign(groups.find(row => row.id === id)!, properties);
  });
  const code = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\n/**\n * One coalesced browser-hygiene pass',
      backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const ungroup = vi.fn(async (tabIds: number[]) => {
    for (const tabId of tabIds) tabs.find(tab => tab.id === tabId)!.groupId = -1;
  });
  const organize = vm.runInNewContext(`${code}\norganizeManagedTabs`, {
    cleanConversationId: (id: string) => id,
    currentRootOpeningProtection: async () => ({ tabs: new Set(), markers: new Set() }),
    idleRootTabs: { '61': { seenAt: Date.now() } }, appOwnedOpeningTabs: {},
    IDLE_ROOT_CLOSE_MS: 15_000,
    exactPlainChatHome: (url: string) => url === 'https://chatgpt.com/' ? url : null,
    exactBridgeCommandId: () => null,
    ownedCommandRootMarker: () => null,
    // This deliberately models the stale reload-era fallback that caused the live bug.
    conversationForTab: (tab: { id: number; url: string }) => tab.id === 61
      ? chatId
      : tab.url.split('/c/')[1],
    browserControlsTab: () => false,
    cosGroupedTabs: {
      '61': { groupId: 90, windowId: 7, category: 'chat' },
      '62': { groupId: 90, windowId: 7, category: 'chat' }
    },
    storedBackgroundWindow: async () => null,
    persistLive: async () => undefined,
    chrome: {
      tabs: {
        group,
        ungroup,
        query: async ({ groupId }: { groupId?: number }) =>
          Number.isInteger(groupId) ? tabs.filter(tab => tab.groupId === groupId) : tabs
      },
      tabGroups: { query: async () => groups.map(row => ({ ...row })), update }
    }
  });

  await organize(tabs, { managedConversations: [chatId], workerConversations: [] }, true);

  expect(group).not.toHaveBeenCalledWith({ tabIds: [61] });
  expect(update).not.toHaveBeenCalledWith(91, expect.anything());
  expect(ungroup).toHaveBeenCalledWith([61]);
  expect(tabs.find(tab => tab.id === 61)?.groupId).toBe(-1);
  expect(tabs.find(tab => tab.id === 62)?.groupId).toBe(90);
});

it('dissolves ownership-dropped duplicate CoS groups using only persisted exact provenance', async () => {
  const currentId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
  const droppedId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
  const personalId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000003';
  const tabs = [
    { id: 1, windowId: 7, groupId: -1, url: `https://chatgpt.com/c/${currentId}`, active: true },
    { id: 4, windowId: 8, groupId: 21, url: `https://chatgpt.com/c/${droppedId}` },
    { id: 5, windowId: 9, groupId: 22, url: `https://chatgpt.com/c/${personalId}` }
  ];
  const groups = [
    { id: 21, windowId: 8, title: 'CoS Chats' },
    { id: 22, windowId: 9, title: 'CoS Chats' }
  ];
  const grouped: Record<string, unknown> = {
    '4': { groupId: 21, windowId: 8, category: 'chat' }
  };
  const ungroup = vi.fn(async (ids: number[]) => {
    for (const id of ids) tabs.find(tab => tab.id === id)!.groupId = -1;
  });
  const group = vi.fn(async ({ tabIds }: { tabIds: number[] }) => {
    const id = 23;
    if (!groups.some(row => row.id === id)) groups.push({ id, windowId: 7, title: '' });
    for (const tabId of tabIds) tabs.find(tab => tab.id === tabId)!.groupId = id;
    return id;
  });
  const code = backgroundSource.slice(
    backgroundSource.indexOf('async function organizeManagedTabs('),
    backgroundSource.indexOf('\n/**\n * One coalesced browser-hygiene pass', backgroundSource.indexOf('async function organizeManagedTabs('))
  );
  const organize = vm.runInNewContext(`${code}\norganizeManagedTabs`, {
    cleanConversationId: (id: string) => id,
    currentRootOpeningProtection: async () => ({ tabs: new Set(), markers: new Set() }),
    idleRootTabs: {}, appOwnedOpeningTabs: {}, IDLE_ROOT_CLOSE_MS: 5 * 60_000,
    exactPlainChatHome: (url: string) => url === 'https://chatgpt.com/' ? url : null,
    exactBridgeCommandId: () => null,
    ownedCommandRootMarker: () => null,
    conversationForTab: (tab: { url: string }) => tab.url.split('/c/')[1],
    conversationFromUrl: (url: string) => url.split('/c/')[1],
    browserControlsTab: () => false,
    cosGroupedTabs: grouped,
    storedBackgroundWindow: async () => null,
    persistLive: async () => undefined,
    tabDocuments: {}, tabEpochs: {},
    ownsDocument: () => false,
    journalCountForConversation: () => 0,
    tabReply: async () => null,
    chrome: {
      tabs: {
        get: async (id: number) => ({ ...tabs.find(tab => tab.id === id)! }),
        group,
        ungroup,
        query: async ({ groupId }: { groupId?: number }) =>
          Number.isInteger(groupId) ? tabs.filter(tab => tab.groupId === groupId) : tabs
      },
      tabGroups: {
        query: async () => groups.map(row => ({ ...row })),
        update: async (id: number, properties: { title: string }) =>
          Object.assign(groups.find(row => row.id === id)!, properties)
      }
    }
  });
  await organize(tabs, { managedConversations: [currentId], workerConversations: [] });
  expect(ungroup).toHaveBeenCalledExactlyOnceWith([4]);
  expect(tabs.find(tab => tab.id === 5)?.groupId).toBe(22);
  expect(grouped).not.toHaveProperty('4');
});

describe('hidden same-document route receipt wake (#1514)', () => {
  const url = 'https://chatgpt.com/c/bbbbbbbb-1111-4222-8333-444444444444';
  const workerForRoute = () => loadWorker({
    local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
    fetch: async input => new URL(input).pathname === '/hello'
      ? response(200, { app: 'chat-on-steroids', paired: true }) : response(200, {})
  });
  const notices = (worker: WorkerHarness) => worker.tabsSendMessage.mock.calls
    .filter(call => (call[1] as { type?: string }).type === 'clf-route-changed');
  it('targets only the registered exact document and epoch without opening or reloading a tab', async () => {
    const worker = workerForRoute();
    await worker.registerTab(5, 'route-document-1');
    await worker.changeTabUrl(5, url);
    expect(notices(worker)).toEqual([[5, { type: 'clf-route-changed', url, navigationEpoch: 0 }, { documentId: 'route-document-1' }]]);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsReload).not.toHaveBeenCalled();
  });
  it('does not address an unregistered or retired document or an external route', async () => {
    const worker = workerForRoute();
    await worker.changeTabUrl(5, url);
    expect(notices(worker)).toEqual([]);
    await worker.registerTab(5, 'route-document-1');
    await worker.startTabNavigation(5, url);
    await worker.changeTabUrl(5, url);
    expect(notices(worker)).toEqual([]);
    await worker.registerTab(6, 'route-document-2');
    await worker.changeTabUrl(6, 'https://example.com/');
    expect(notices(worker)).toEqual([]);
  });
});

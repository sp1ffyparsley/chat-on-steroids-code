/**
 * The MAIN-world Fiber reader, running against Fiber trees shaped like the live page.
 *
 * Until now nothing executed extension/fiber.js at all: the extension tests asserted
 * things about its *source*, and the content-script tests faked its replies. So the one
 * file whose entire job is to read a shape this repo does not control had no test that
 * could notice the shape moving — and it had moved. On the live page the node carrying a
 * row's messages sits at climb depth 30, and the file stopped at 29, so every row of every
 * chat produced no descriptor at all. That is invisible from outside: a helper that finds
 * nothing and a browser with no helper look exactly the same.
 *
 * Every fixture below is transcribed from shapes read out of a real conversation
 * (2026-08-16): the depth, the group array whose `messages[0]` is the row's own request,
 * the `parent_id` link from a result back to it, the truncated request payloads, and the
 * `invoked_resource` on the answer.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

let source = '';

beforeAll(async () => {
  source = await fs.readFile(path.join(process.cwd(), 'extension', 'fiber.js'), 'utf8');
});

interface Descriptor {
  v: number;
  index: number;
  tool: string | null;
  path: string | null;
  app: string | null;
  resource: string | null;
  messageId: string | null;
  turnId: string | null;
  conversationId: string | null;
  createTime: number | null;
  hidden: number;
  localCount: number | null;
  answered: boolean;
  own?: boolean;
}

// ------------------------------------------------------------------ fixtures

const THREAD = 'f0f00004-1111-4111-8111-111111111111';
/**
 * The connector name the live page actually holds, taken from a real conversation.
 *
 * Spaces and all — this is `resource_name` out of this app's own protected-resource
 * metadata, and the fixture spells it exactly because the whole evidence pipeline once
 * matched a single hardcoded name that no longer existed.
 */
const APP = 'Luna Forge X7 Core';
const DESKTOP_APP = 'Luna Forge X7 Desktop';
const PLUGINS_APP = 'Luna Forge X7 Plugins';
/** Names retained as exact migration aliases for conversations created before this fork's rename. */
const HISTORICAL_APP = 'Chat On Steroids Core';
const HISTORICAL_DESKTOP_APP = 'Chat On Steroids Desktop';
const HISTORICAL_PLUGINS_APP = 'Chat On Steroids Plugins';
/** What the connector was called before 1.7.1 split it. Older chats still hold it. */
const LEGACY_APP = 'TobisComputer';
/** The connector's link id, as it appears in a request path. */
const LINK = 'link_11111111222233334444555555555555';
/** A result's resource uri names the app instance rather than the connector. */
const ASDK = 'asdk_app_22222222333344445555666666666666';
/** The depth the live page put the group node at. The old limit was 30 exclusive. */
const LIVE_DEPTH = 30;

interface Message {
  id: string;
  author: { role: string; name?: string };
  recipient: string;
  channel?: string;
  create_time?: number;
  status?: string;
  end_turn?: boolean;
  content?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * An assistant connector request, the way the live page stores one.
 *
 * `text` is the payload as ChatGPT holds it, which is why `truncate` exists: on the live
 * page most of these are cut mid-argument and `JSON.parse` throws on them.
 */
function request(
  id: string,
  tool: string | null,
  options: { truncate?: number; parent?: string; app?: string } = {}
): Message {
  const app = options.app ?? APP;
  const head = tool === null ? '{"path":"/' : `{"path":"/${app}/${LINK}/${tool}"`;
  const body = tool === null ? head : `${head},"args":{"note":"${'x'.repeat(80)}","path":"C:/Users/example/secret.txt"}}`;
  return {
    id,
    author: { role: 'assistant' },
    recipient: 'api_tool.call_tool',
    create_time: 1786873658.125,
    content: {
      content_type: 'code',
      language: 'json',
      response_format_name: null,
      text: options.truncate === undefined ? body : body.slice(0, options.truncate)
    },
    metadata: {
      parent_id: options.parent ?? '699e6497-0000-4000-8000-000000000001',
      request_id: 'wfr_01a009',
      turn_exchange_id: '82f67b26',
      tool_icons: ['api_tool']
    }
  };
}

/** A tool result, chained to whatever message it actually answered. */
function answer(id: string, parent: string, tool: string, app: string = APP): Message {
  return {
    id,
    author: { role: 'tool' },
    recipient: 'all',
    channel: 'commentary',
    create_time: 1786873669.5,
    content: { content_type: 'code', language: 'json', response_format_name: null, text: '' },
    metadata: {
      parent_id: parent,
      request_id: 'wfr_01a009',
      invoked_plugin: { type: 'remote', namespace: 'api_tool' },
      invoked_resource: { app_name: app, resource_uri: `/${ASDK}/${LINK}/${tool}` }
    }
  };
}

/** Public assistant prose in the current page model. */
function authored(
  id: string,
  text: string,
  options: {
    status?: string;
    endTurn?: boolean;
    parent?: string;
    workingTurnId?: string;
    turnExchangeId?: string;
    createTime?: number;
    channel?: string;
  } = {}
): Message {
  return {
    id,
    author: { role: 'assistant' },
    recipient: 'all',
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(options.endTurn !== undefined ? { end_turn: options.endTurn } : {}),
    ...(options.createTime ? { create_time: options.createTime } : {}),
    content: { content_type: 'text', parts: [text] },
    metadata: {
      message_type: 'next',
      ...(options.parent ? { parent_id: options.parent } : {}),
      ...(options.workingTurnId ? { working_turn_id: options.workingTurnId } : {}),
      ...(options.turnExchangeId ? { turn_exchange_id: options.turnExchangeId } : {})
    }
  };
}

/** Internal assistant reasoning/tool-summary state. It is not public authored prose. */
function thought(id: string): Message {
  return {
    id,
    author: { role: 'assistant' },
    recipient: 'all',
    content: { content_type: 'thoughts', parts: null, text: null },
    metadata: {
      message_type: 'next',
      reasoning_status: 'is_reasoning',
      tool_summary_type: 'chatgpt_local_files_core'
    }
  };
}

interface Group {
  messages: Message[];
  collapsedSameToolCallCount?: number;
  clientThreadId?: string;
  turnIndex?: number;
  isLastMessageInTurn?: boolean;
}

/** The props the live page hands the component that renders one row's group. */
function group(messages: Message[], collapsed = 0): Group {
  return {
    messages,
    collapsedSameToolCallCount: collapsed,
    clientThreadId: THREAD,
    turnIndex: 2,
    isLastMessageInTurn: false
  };
}

interface Fiber {
  memoizedProps: Record<string, unknown> | null;
  return: Fiber | null;
}

/**
 * A Fiber chain with `props` `depth` levels above the row.
 *
 * The filler nodes are the tooltip, popper and layout wrappers the real tree is padded
 * with — a dozen of them carry no props worth reading, which is the whole reason the
 * distance from the row to its data is as long as it is.
 */
function chain(props: Record<string, unknown> | null, depth = LIVE_DEPTH, above: Fiber | null = null): Fiber {
  let node: Fiber = { memoizedProps: props, return: above };
  for (let up = 0; up < depth; up++) {
    node = { memoizedProps: { className: 'flex items-center', children: null }, return: node };
  }
  return node;
}

/** The turn-level node, which carries every message of the turn and must never be read. */
function turnNode(messages: Message[], conversationProps: Record<string, unknown> = {}): Fiber {
  return {
    memoizedProps: {
      allMessages: messages,
      allGroupedMessages: [messages],
      conversation: { id: THREAD },
      turn: { id: 'turn-1', messages },
      turnIndex: 2,
      ...conversationProps
    },
    return: null
  };
}

// ------------------------------------------------------------------- harness

/**
 * Runs the shipped helper against a page whose rows carry the given Fiber chains, and
 * returns what it posted back.
 */
interface TurnCall {
  messageId: string;
  tool: string;
  order: number;
  answered: boolean;
  resultReceiptId?: string;
  own?: boolean;
}

interface TurnEvidence {
  index: number;
  sightings?: Array<{ requestId: string; appId: string; linkId: string | null; appName: string | null }>;
  turnId: string | null;
  conversationId?: string | null;
  conversationConflict?: boolean;
  endMessageId?: string | null;
  calls: TurnCall[];
  callEvidenceComplete?: boolean;
  codeModeCalls?: Array<{ messageId: string; requestId: string | null; answered: boolean }>;
  requests?: Array<{ requestId: string; messageId: string | null; createTime: number | null }>;
  messages: Array<{
    messageId: string;
    rawMessageId: string;
    role?: 'user' | 'assistant';
    stable: boolean;
    order: number;
    createTime?: number | null;
    rawText: string;
    renderedHtml: string;
  }>;
  activities?: Array<{ messageId: string; label: string; order: number }>;
}

/** One assistant turn section, carrying its own message model the way the page does. */
interface TurnFixture {
  id: string;
  messages: Message[];
  /** A visible `.markdown` block: its text, or markup when the test is about the markup. */
  rendered?: Array<string | { html: string }>;
  staleStamp?: string;
  conversationProps?: Record<string, unknown>;
  /** Mounted on an earlier page ChatGPT keeps undisplayed in the same tab. */
  keptPage?: boolean;
}

async function scan(
  fibers: Fiber[],
  turnSections: TurnFixture[] = [],
  identity?: { apps?: Record<string, string>; appIds?: unknown[] }
): Promise<{
  rows: Descriptor[];
  version: number;
  scanToken: string;
  stamps: Array<string | null>;
  turnStamps: Array<string | null>;
  turns: TurnEvidence[];
}> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: `https://chatgpt.com/c/${THREAD}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const window = dom.window as unknown as Window & typeof globalThis & Record<string, any>;
  const document = window.document;

  for (const turn of turnSections) {
    const section = document.createElement('section');
    section.setAttribute('data-testid', 'conversation-turn-2');
    if (turn.id) section.setAttribute('data-turn-id', turn.id);
    if (turn.staleStamp !== undefined) section.setAttribute('data-clf-fiber-turn', turn.staleStamp);
    (section as unknown as Record<string, unknown>)['__reactFiber$qlrmvxwbkkq'] = turnNode(
      turn.messages,
      turn.conversationProps
    );
    for (const entry of turn.rendered ?? []) {
      const block = document.createElement('div');
      block.className = 'markdown';
      if (typeof entry === 'string') block.textContent = entry;
      else block.innerHTML = entry.html;
      section.append(block);
    }
    if (turn.keptPage) {
      const page = document.createElement('div');
      page.setAttribute('data-app-shell-page-surface', 'true');
      page.style.display = 'none';
      page.append(section);
      document.body.append(page);
    } else document.body.append(section);
  }

  const elements = fibers.map((fiber) => {
    const row = document.createElement('span');
    row.className = 'group/tool-message';
    row.setAttribute('aria-label', '工具呼び出し一覧');
    // React hangs the Fiber off a key with a per-build random suffix.
    (row as unknown as Record<string, unknown>)['__reactFiber$qlrmvxwbkkq'] = fiber;
    document.body.append(row);
    return row;
  });

  window.eval(source);

  const nonce = 'test-nonce';
  const reply = new Promise<Record<string, any>>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error('the helper never answered')), 2000);
    window.addEventListener('message', (event: any) => {
      if (!event.data || event.data.source !== 'clf-fiber-reply' || event.data.nonce !== nonce) return;
      globalThis.clearTimeout(timer);
      resolve(event.data);
    });
  });

  // Dispatched rather than posted: jsdom's own postMessage does not set `source`, and the
  // helper refuses any message that did not come from this window.
  window.dispatchEvent(
    new window.MessageEvent('message', { data: { source: 'clf-fiber-ask', nonce, ...identity }, source: window })
  );

  const data = await reply;
  const stamps = elements.map((row) => row.getAttribute('data-clf-fiber'));
  const turnStamps = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')].map((section) =>
    section.getAttribute('data-clf-fiber-turn')
  );
  dom.window.close();
  return {
    rows: data.rows as Descriptor[],
    version: data.v as number,
    scanToken: data.scanToken as string,
    stamps,
    turnStamps,
    turns: (data.turns ?? []) as TurnEvidence[]
  };
}

/** One row whose group sits where the live page puts it. */
const row = (messages: Message[], collapsed = 0) => chain(group(messages, collapsed) as unknown as Record<string, unknown>);
const rowInTurn = (messages: Message[], turnMessages: Message[], collapsed = 0) =>
  chain(group(messages, collapsed) as unknown as Record<string, unknown>, LIVE_DEPTH, turnNode(turnMessages));

// --------------------------------------------------------------------- tests

it.each(['older', 'same'] as const)('retires the %s protocol listener on reinjection without accumulating scan replies', priorProtocol => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: `https://chatgpt.com/c/${THREAD}`, runScripts: 'outside-only', pretendToBeVisual: true
  });
  const window = dom.window as unknown as Window & typeof globalThis & Record<string, any>;
  const replies: Array<{ source?: string; nonce?: string; v?: number }> = [];
  window.postMessage = (message: unknown) => { replies.push(message as typeof replies[number]); };
  const version = Number(/const VERSION = (\d+);/.exec(source)?.[1]);
  expect(Number.isSafeInteger(version)).toBe(true);
  const priorVersion = priorProtocol === 'older' ? version - 1 : version;
  const ask = (nonce: string, eventSource: Window | null = window) => window.dispatchEvent(
    new window.MessageEvent('message', { data: { source: 'clf-fiber-ask', nonce }, source: eventSource })
  );
  try {
    window.eval(source.replace(/const VERSION = \d+;/, `const VERSION = ${priorVersion};`));
    ask('before-reinjection');
    expect(replies.map(reply => reply.v)).toEqual([priorVersion]);
    replies.length = 0;
    // The current helper can be injected more than once during one document's lifetime.
    // There must still be only one listener, including across a protocol-version upgrade.
    window.eval(source);
    window.eval(source);
    ask('after-reinjection');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ source: 'clf-fiber-reply', nonce: 'after-reinjection', v: version });
    replies.length = 0;
    ask('foreign-window', null);
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { source: 'not-the-fiber-protocol', nonce: 'unrelated-message' }, source: window
    }));
    expect(replies).toEqual([]);
  } finally { dom.window.close(); }
});

describe('reading a row out of the page', () => {
  /**
   * The regression the whole batch exists for. The group node is exactly `MAX_CLIMB`
   * levels up, which the old `up < MAX_CLIMB` stopped one short of, so this row — and
   * every row of every chat — came back undescribed while looking like a browser that
   * simply had no helper.
   */
  it('reaches the group node at the depth the live page puts it', async () => {
    const ask = request('req-1', 'search_files');
    const { rows } = await scan([row([ask, answer('res-1', 'req-1', 'search_files')])]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ index: 0, tool: 'search_files', app: APP, answered: true });
  });

  it('names six sequential calls in the same chat, each as itself', async () => {
    const tools = ['search_files', 'search_files', 'read_file', 'list_directory', 'run_command', 'agent_status'];
    const { rows, stamps, scanToken } = await scan(
      tools.map((tool, at) => row([request(`req-${at}`, tool), answer(`res-${at}`, `req-${at}`, tool)]))
    );

    expect(rows.map((entry) => entry.tool)).toEqual(tools);
    expect(rows.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4, 5]);
    // Both worlds agree on which row each descriptor belongs to through the stamp, not
    // through querying the DOM twice and hoping React did not re-render in between.
    expect(scanToken).toBe('test-nonce');
    expect(stamps).toEqual(tools.map((_tool, index) => `test-nonce:${index}`));
  });

  it('keeps the version it was built for on the reply', async () => {
    const { version, rows } = await scan([row([request('req-1', 'read_file')])]);
    expect(version).toBe(15);
    expect(rows[0]!.v).toBe(15);
  });
  it('counts only TobisComputer requests in the complete turn, not api_tool metadata calls', async () => {
    const mine1 = request('req-1', 'read_file');
    const mine2 = request('req-2', 'search_files');
    const meta: Message = {
      id: 'meta-1',
      author: { role: 'assistant' },
      recipient: 'api_tool.list_resources',
      content: { text: '{"query":"TobisComputer"}' }
    };
    const other: Message = {
      id: 'other-1',
      author: { role: 'assistant' },
      recipient: 'api_tool.call_tool',
      content: { text: '{"path":"/Gmail/link_x/search","args":{}}' }
    };
    const turnMessages = [
      meta,
      mine1,
      answer('res-1', 'req-1', 'read_file'),
      other,
      mine2,
      answer('res-2', 'req-2', 'search_files')
    ];
    const { rows } = await scan([rowInTurn([mine2, answer('res-2', 'req-2', 'search_files')], turnMessages, 4)]);

    expect(rows[0]).toMatchObject({ tool: 'search_files', hidden: 4, localCount: 2 });
  });
});

/**
 * The v4 addition, and the reason attribution stopped depending on what ChatGPT drew.
 *
 * A count told the app "this turn made four calls"; it could not say *which*. Attribution
 * therefore still needed a visible row per call, and ChatGPT groups rows and sometimes
 * draws none at all — so a real chat's calls were filed under `Unattributed activity`
 * while the chat that made them sat beside it. Naming each request fixes that at the
 * source: a turn that rendered nothing still says exactly what it asked for.
 */
describe('the calls a turn says it made', () => {
  /**
   * The live regression: 1.7.1 renamed the connector and split it in two, and this test
   * spelled only the old name. Every request on every page stopped being recognised as
   * ours, so no turn produced evidence and one chat's whole run of calls was filed under
   * `Unattributed activity`. Both current connectors and the old name must read.
   */
  it('recognises the private brand, historical connectors and the pre-1.7.1 name', async () => {
    const messages = [
      request('req-core', 'read'),
      answer('res-core', 'req-core', 'read'),
      request('req-desk', 'computer', { app: DESKTOP_APP }),
      answer('res-desk', 'req-desk', 'computer', DESKTOP_APP),
      request('req-historical-core', 'find', { app: HISTORICAL_APP }),
      answer('res-historical-core', 'req-historical-core', 'find', HISTORICAL_APP),
      request('req-historical-desk', 'observe', { app: HISTORICAL_DESKTOP_APP }),
      answer('res-historical-desk', 'req-historical-desk', 'observe', HISTORICAL_DESKTOP_APP),
      request('req-old', 'read_file', { app: LEGACY_APP }),
      answer('res-old', 'req-old', 'read_file', LEGACY_APP)
    ];
    const { turns } = await scan([], [{ id: 'turn-renamed', messages }]);

    expect(turns[0]!.calls).toEqual([
      { messageId: 'req-core', tool: 'read', order: 0, answered: true, requestId: 'wfr_01a009', createTime: 1786873658.125 },
      { messageId: 'req-desk', tool: 'computer', order: 1, answered: true, requestId: 'wfr_01a009', createTime: 1786873658.125 },
      { messageId: 'req-historical-core', tool: 'find', order: 2, answered: true, requestId: 'wfr_01a009', createTime: 1786873658.125 },
      { messageId: 'req-historical-desk', tool: 'observe', order: 3, answered: true, requestId: 'wfr_01a009', createTime: 1786873658.125 },
      { messageId: 'req-old', tool: 'read_file', order: 4, answered: true, requestId: 'wfr_01a009', createTime: 1786873658.125 }
    ]);
  });

  it('recognises only the alternate shell underscore spelling of exact connector identities', async () => {
    const underscore = (name: string) => name.replaceAll(' ', '_');
    const messages = [
      request('req-shell-core', 'read', { app: underscore(APP) }),
      answer('res-shell-core', 'req-shell-core', 'read', underscore(APP)),
      request('req-shell-desk', 'computer', { app: underscore(DESKTOP_APP) }),
      answer('res-shell-desk', 'req-shell-desk', 'computer', underscore(DESKTOP_APP)),
      request('req-shell-plugins', 'get_scene_info', { app: underscore(PLUGINS_APP) }),
      answer('res-shell-plugins', 'req-shell-plugins', 'get_scene_info', underscore(PLUGINS_APP)),
      request('req-shell-historical', 'read', { app: underscore(HISTORICAL_APP) }),
      answer('res-shell-historical', 'req-shell-historical', 'read', underscore(HISTORICAL_APP)),
      request('req-shell-historical-plugins', 'get_scene_info', { app: underscore(HISTORICAL_PLUGINS_APP) }),
      answer('res-shell-historical-plugins', 'req-shell-historical-plugins', 'get_scene_info', underscore(HISTORICAL_PLUGINS_APP))
    ];
    const { turns } = await scan([], [{ id: 'turn-shell-connectors', messages }]);

    expect(turns[0]!.calls.map((call) => call.messageId)).toEqual([
      'req-shell-core',
      'req-shell-desk',
      'req-shell-plugins',
      'req-shell-historical',
      'req-shell-historical-plugins'
    ]);
  });

  /**
   * A name is not a prefix game. `Chat On Steroids Backup` shares every character of the
   * brand and is still a different integration; matching on the brand rather than on the
   * exact connector names would make this app vouch for its calls and file a stranger's
   * traffic into this chat's session.
   */
  it('refuses a connector whose name merely starts with this app’s brand', async () => {
    const messages = [
      request('req-fake', 'read', { app: 'Chat On Steroids Backup' }),
      answer('res-fake', 'req-fake', 'read', 'Chat On Steroids Backup'),
      request('req-mine', 'read')
    ];
    const { turns } = await scan([], [{ id: 'turn-lookalike', messages }]);

    expect(turns[0]!.calls.map((call) => call.messageId)).toEqual(['req-mine']);
  });

  it('refuses underscore-form connector lookalikes instead of normalizing arbitrary names', async () => {
    const messages = [
      request('req-private-lookalike', 'read', { app: 'Luna_Forge_X7_Core_Backup' }),
      answer('res-private-lookalike', 'req-private-lookalike', 'read', 'Luna_Forge_X7_Core_Backup'),
      request('req-public-lookalike', 'read', { app: 'Chat_On_Steroids_Core_Backup' }),
      answer('res-public-lookalike', 'req-public-lookalike', 'read', 'Chat_On_Steroids_Core_Backup'),
      request('req-mine', 'read')
    ];
    const { turns } = await scan([], [{ id: 'turn-underscore-lookalike', messages }]);

    expect(turns[0]!.calls.map((call) => call.messageId)).toEqual(['req-mine']);
  });

  it('backfills a missing classic invocation request ID only from its exact finished native result', async () => {
    const asked = request('backfill-original-parent', 'read');
    delete asked.metadata!.request_id;
    const returned = answer('backfill-exact-result', asked.id, 'read');
    returned.author.name = 'api_tool.call_tool';
    returned.status = 'finished_successfully';
    returned.metadata!.request_id = 'wfr_exact_result_backfill';
    const { turns } = await scan([], [{ id: 'backfill-native-turn', messages: [asked, returned] }]);
    expect(turns[0]?.calls).toMatchObject([{
      messageId: asked.id, requestId: 'wfr_exact_result_backfill', answered: true
    }]);
    expect(turns[0]!.calls[0]).not.toHaveProperty('resultReceiptId');
    expect(asked.metadata).not.toHaveProperty('request_id');
  });

  it.each(['duplicate-result', 'conflicting-result', 'duplicate-result-id', 'unfinished', 'missing-status',
    'wrong-parent', 'missing-parent', 'foreign-app', 'foreign-link', 'foreign-tool', 'foreign-surface',
    'missing-metadata', 'missing-request', 'invalid-request', 'oversize-request', 'wrong-role',
    'wrong-recipient', 'missing-author', 'code-wrapper'] as const)(
    'does not backfill classic request identity from %s evidence', async mode => {
      const asked = request('backfill-held-parent', 'read');
      delete asked.metadata!.request_id;
      const returned = answer('backfill-held-result', asked.id, 'read');
      returned.author.name = 'api_tool.call_tool';
      returned.status = 'finished_successfully';
      returned.metadata!.request_id = 'wfr_untrusted_result_backfill';
      if (mode === 'unfinished') returned.status = 'in_progress';
      if (mode === 'missing-status') delete returned.status;
      if (mode === 'wrong-parent') returned.metadata!.parent_id = 'a-different-native-call';
      if (mode === 'missing-parent') delete returned.metadata!.parent_id;
      if (mode === 'foreign-app') (returned.metadata!.invoked_resource as Record<string, unknown>).app_name = 'Foreign Core';
      if (mode === 'foreign-link') (returned.metadata!.invoked_resource as Record<string, unknown>).resource_uri = `/${ASDK}/link_99999999888877776666555555555555/read`;
      if (mode === 'foreign-tool') (returned.metadata!.invoked_resource as Record<string, unknown>).resource_uri = `/${ASDK}/${LINK}/exec_command`;
      if (mode === 'foreign-surface') (returned.metadata!.invoked_resource as Record<string, unknown>).app_name = PLUGINS_APP;
      if (mode === 'missing-request') delete returned.metadata!.request_id;
      if (mode === 'invalid-request') returned.metadata!.request_id = 'wfr_invalid request';
      if (mode === 'oversize-request') returned.metadata!.request_id = 'wfr_' + 'x'.repeat(97);
      if (mode === 'missing-metadata') delete returned.metadata;
      if (mode === 'wrong-role') returned.author.role = 'assistant';
      if (mode === 'wrong-recipient') returned.recipient = 'functions.exec';
      if (mode === 'missing-author') delete returned.author.name;
      if (mode === 'code-wrapper') returned.author.name = 'functions.exec';
      const messages = [asked, returned];
      if (['duplicate-result', 'conflicting-result', 'duplicate-result-id'].includes(mode)) {
        const duplicate = answer(mode === 'duplicate-result-id' ? returned.id : 'second-native-result', asked.id, 'read');
        duplicate.author.name = 'api_tool.call_tool';
        duplicate.status = 'finished_successfully';
        duplicate.metadata!.request_id = mode === 'conflicting-result' ? 'wfr_conflicting_result' : returned.metadata!.request_id;
        messages.push(duplicate);
      }
      const { turns } = await scan([], [{ id: 'backfill-held-turn', messages }]);
      expect(turns[0]?.calls).toMatchObject([{ messageId: asked.id, requestId: null }]);
    }
  );

  it('keeps shared-workflow sibling results bound to their own exact native parent', async () => {
    const first = request('backfill-first-sibling', 'read'), second = request('backfill-second-sibling', 'read');
    delete first.metadata!.request_id;
    delete second.metadata!.request_id;
    const returned = answer('backfill-only-first-result', first.id, 'read');
    returned.author.name = 'api_tool.call_tool';
    returned.status = 'finished_successfully';
    returned.metadata!.request_id = 'wfr_shared_sibling_workflow';
    const { turns } = await scan([], [{ id: 'backfill-sibling-turn', messages: [first, returned, second] }]);
    expect(turns[0]?.calls).toMatchObject([
      { messageId: first.id, requestId: 'wfr_shared_sibling_workflow', answered: true },
      { messageId: second.id, requestId: null, answered: false }
    ]);
  });

  it('never replaces a known classic invocation request ID with result metadata', async () => {
    const asked = request('backfill-known-parent', 'read');
    const returned = answer('backfill-known-result', asked.id, 'read');
    returned.author.name = 'api_tool.call_tool';
    returned.status = 'finished_successfully';
    returned.metadata!.request_id = 'wfr_different_result';
    const { turns } = await scan([], [{ id: 'backfill-known-turn', messages: [asked, returned] }]);
    expect(turns[0]?.calls).toMatchObject([{ messageId: asked.id, requestId: 'wfr_01a009', answered: false }]);
  });

  it('names every request in the turn, in order, with its result state', async () => {
    const messages = [
      request('req-a', 'search_files'),
      answer('res-a', 'req-a', 'search_files'),
      request('req-b', 'read_file'),
      answer('res-b', 'req-b', 'read_file'),
      // Issued but not answered yet: the turn is still running.
      request('req-c', 'run_powershell')
    ];
    const { turns } = await scan([], [{ id: 'turn-evidence', messages }]);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.turnId).toBe('turn-evidence');
    expect(turns[0]!.calls).toEqual([
      { messageId: 'req-a', tool: 'search_files', order: 0, answered: true, requestId: 'wfr_01a009', createTime: 1786873658.125 },
      { messageId: 'req-b', tool: 'read_file', order: 1, answered: true, requestId: 'wfr_01a009', createTime: 1786873658.125 },
      { messageId: 'req-c', tool: 'run_powershell', order: 2, answered: false, requestId: 'wfr_01a009', createTime: 1786873658.125 }
    ]);
  });

  it.each(['core', 'code'] as const)(
    'keeps truncated native call sets unknown when the classic provider has 201 %s requests', async kind => {
      const calls: Message[] = Array.from({ length: 201 }, (_, index) => kind === 'core'
        ? request(`native-core-${index}`, 'read_file')
        : { id: `native-code-${index}`, author: { role: 'assistant' }, recipient: 'functions.exec',
          metadata: { request_id: `wfr_code_${index}` } });
      const final = authored('terminal-after-native-cap', 'Finished.', {
        channel: 'final', status: 'finished_successfully', endTurn: true });
      const { turns } = await scan([], [{ id: 'turn-native-overflow', messages: [...calls, final] }]);
      expect(turns).toHaveLength(1);
      expect(turns[0]!.endMessageId).toBe(final.id);
      // The bounded prefix is useful for attribution; it is NOT an exhaustive
      // native call census even though the paired reader receives 200 entries.
      expect(turns[0]!.calls).toHaveLength(kind === 'core' ? 200 : 0);
      expect(turns[0]!.codeModeCalls).toHaveLength(kind === 'code' ? 200 : 0);
      expect(turns[0]!.callEvidenceComplete).toBe(false);
    }
  );

  it('keeps a duplicated classic native call id unknown rather than calling a filtered empty prefix tool-free', async () => {
    const original = request('duplicate-native-id', 'read_file');
    const { turns } = await scan([], [{ id: 'turn-native-duplicate', messages: [original, { ...original },
      authored('terminal-after-duplicate', 'Finished.', {
        channel: 'final', status: 'finished_successfully', endTurn: true })] }]);
    expect(turns[0]!.calls).toEqual([]);
    expect(turns[0]!.callEvidenceComplete).toBe(false);
  });

  it('withholds a tool-free native final if its current connector invocation lost the request path', async () => {
    const unreadable = request('native-path-unreadable', 'read_file');
    unreadable.content = { content_type: 'code', text: '{"args":{"path":"private"}}' };
    const { turns } = await scan([], [{ id: 'turn-native-unreadable', messages: [
      unreadable,
      authored('terminal-after-unreadable', 'Finished.', {
        channel: 'final', status: 'finished_successfully', endTurn: true })] }]);
    expect(turns[0]!.calls).toEqual([]);
    expect(turns[0]!.callEvidenceComplete).toBe(false);
  });

  it('marks a duplicate native Code Mode parent as an incomplete census, not an independently completed final', async () => {
    const parent: Message = { id: 'native-duplicate-exec-parent', author: { role: 'assistant' },
      recipient: 'functions.exec', metadata: { request_id: 'wfr_duplicate_exec_parent' } };
    const { turns } = await scan([], [{ id: 'turn-native-code-parent-duplicate', messages: [parent,
      { ...parent }, authored('terminal-after-duplicate-code', 'Finished.', {
        channel: 'final', status: 'finished_successfully', endTurn: true })] }]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.endMessageId).toBe('terminal-after-duplicate-code');
    expect(turns[0]!.codeModeCalls).toHaveLength(2);
    expect(turns[0]!.callEvidenceComplete).toBe(false);
  });

  it.each(['wrong-tool', 'wrong-link', 'wrong-request', 'wrong-surface',
    'wrong-role', 'wrong-recipient', 'wrong-author', 'exact'])(
    'requires the native returned Core resource to belong to the exact requested call before marking it answered (%s)',
    async mode => {
      const asked = request('original-native-core-parent', 'read');
      const returned = answer('only-returned-native-result', asked.id,
        mode === 'wrong-tool' ? 'exec_command' : 'read',
        mode === 'wrong-surface' ? PLUGINS_APP : APP);
      returned.author.name = 'api_tool.call_tool';
      returned.status = 'finished_successfully';
      if (mode === 'wrong-role') returned.author.role = 'assistant';
      if (mode === 'wrong-recipient') returned.recipient = 'functions.exec';
      if (mode === 'wrong-author') returned.author.name = 'functions.exec';
      if (mode === 'wrong-link')
        (returned.metadata!.invoked_resource as Record<string, unknown>).resource_uri =
          `/${ASDK}/link_99999999888877776666555555555555/read`;
      if (mode === 'wrong-request') returned.metadata!.request_id = 'wfr_not_the_original';
      const { rows, turns } = await scan(
        [rowInTurn([asked, returned], [asked, returned])],
        [{ id: 'native-wrong-resource-result', messages: [asked, returned] }]
      );
      expect(turns[0]?.calls).toMatchObject([{
        messageId: asked.id, tool: 'read', requestId: 'wfr_01a009',
        answered: mode === 'exact'
      }]);
      expect(rows[0]?.answered).toBe(mode === 'exact');
      expect(turns[0]!.calls[0]).not.toHaveProperty('resultReceiptId');
    }
  );

  it.each(['pending', 'complete', 'wrong-request', 'missing-parent', 'duplicate-result', 'sibling-results', 'wrong-tool'])(
    'waits for the exact enclosing native Code Mode result (%s)',
    async (mode) => {
      const root: Message = {
        id: 'code-root',
        author: { role: 'assistant' },
        recipient: 'functions.exec',
        status: 'finished_successfully',
        metadata: { request_id: 'wfr_code_01', turn_exchange_id: 'batch', working_turn_id: 'work' }
      };
      const first = request('batch-first', 'read', { parent: root.id });
      const second = request('batch-second', 'read', { parent: first.id });
      const firstResult = answer('batch-result-first', second.id, 'read');
      const secondResult = answer('batch-result-second', firstResult.id, 'read');
      firstResult.author.name = secondResult.author.name = 'api_tool.call_tool';
      const result: Message = {
        id: 'code-result',
        author: { role: 'tool', name: 'functions.exec' },
        recipient: 'all',
        status: 'finished_successfully',
        metadata: { parent_id: secondResult.id }
      };
      for (const message of [first, second, firstResult, secondResult, result]) {
        message.metadata = {
          ...message.metadata,
          request_id: 'wfr_code_01',
          turn_exchange_id: 'batch',
          working_turn_id: 'work'
        };
      }
      if (mode === 'wrong-request') result.metadata!.request_id = 'another-request';
      if (mode === 'missing-parent') result.metadata!.parent_id = 'unseen-parent';
      if (mode === 'wrong-tool') result.author.name = 'some_other.exec';
      const following = request('ordinary-after-code', 'read', { parent: result.id });
      const messages = [
        root,
        first,
        second,
        firstResult,
        secondResult,
        ...(mode === 'pending' ? [] : [result]),
        ...(mode === 'duplicate-result' ? [result] : []),
        ...(mode === 'sibling-results'
          ? [{ ...result, id: 'code-result-sibling',
            metadata: { ...result.metadata } }] : []),
        ...(mode === 'complete' ? [following] : [])
      ];

      const { turns } = await scan([], [{ id: 'native-code-batch', messages }]);

      expect(turns[0]!.calls.map((call) => call.answered)).toEqual(
        mode === 'complete' ? [true, true, false] : [false, false]
      );
      expect(turns[0]!.codeModeCalls).toEqual([{
        messageId: root.id,
        requestId: 'wfr_code_01',
        answered: mode === 'complete'
      }]);
    }
  );

  /** The blocker itself: no connector row anywhere, and the calls are still accounted for. */
  it('reports a turn’s calls even when the page drew no tool row at all', async () => {
    const messages = [
      request('req-1', 'read_files'),
      answer('res-1', 'req-1', 'read_files'),
      request('req-2', 'screenshot'),
      answer('res-2', 'req-2', 'screenshot')
    ];
    const { rows, turns } = await scan([], [{ id: 'turn-rowless', messages }]);

    expect(rows).toHaveLength(0);
    expect(turns[0]!.calls.map((call) => call.tool)).toEqual(['read_files', 'screenshot']);
  });

  it('refuses to vouch for another connector’s traffic', async () => {
    const gmail: Message = {
      id: 'gmail-1',
      author: { role: 'assistant' },
      recipient: 'api_tool.call_tool',
      content: { text: '{"path":"/Gmail/link_x/search","args":{}}' }
    };
    const meta: Message = {
      id: 'meta-1',
      author: { role: 'assistant' },
      recipient: 'api_tool.list_resources',
      content: { text: '{"query":"TobisComputer"}' }
    };
    const messages = [gmail, meta, request('req-mine', 'read_file'), answer('res-mine', 'req-mine', 'read_file')];
    const { turns } = await scan([], [{ id: 'turn-mixed', messages }]);

    expect(turns[0]!.calls).toEqual([{ messageId: 'req-mine', tool: 'read_file', order: 0, answered: true, requestId: 'wfr_01a009', createTime: 1786873658.125 }]);
  });

  it('drops a message id the turn reports twice rather than spending it on two records', async () => {
    const messages = [
      request('req-dup', 'read_file'),
      request('req-dup', 'run_command'),
      request('req-ok', 'search_files')
    ];
    const { turns } = await scan([], [{ id: 'turn-dup', messages }]);

    expect(turns[0]!.calls.map((call) => call.messageId)).toEqual(['req-ok']);
  });

  it('carries no argument value, no result body and no path', async () => {
    // `request()` puts a real file path and an 80-character note in the payload. Neither
    // may appear anywhere in what crosses back into the isolated world.
    const messages = [request('req-secret', 'read_file'), answer('res-secret', 'req-secret', 'read_file')];
    const { turns } = await scan([], [{ id: 'turn-secret', messages }]);

    const wire = JSON.stringify(turns);
    expect(wire).not.toContain('secret.txt');
    expect(wire).not.toContain('xxxx');
    expect(wire).not.toContain(LINK);
    // The allowlist, and the whole of it. `requestId` and `createTime` are ChatGPT's own
    // identifiers for the request — an opaque id and a timestamp — carried because they are
    // the only candidates for joining a call to the conversation that issued it without
    // guessing. Neither is derived from `args`, and this list is what keeps that true.
    expect(Object.keys(turns[0]!.calls[0]!).sort()).toEqual([
      'answered',
      'createTime',
      'messageId',
      'order',
      'requestId',
      'tool'
    ]);
  });

  it('reads the mounted conversation object identity used by helper answers', async () => {
    const { turns } = await scan([], [{
      id: 'helper-final', messages: [authored('helper-message', 'Complete.')],
      rendered: ['Complete.'], conversationProps: { conversation: { id: THREAD } }
    }]);
    expect(turns[0]).toMatchObject({ conversationId: THREAD, conversationConflict: false });
  });

  it('reads the durable server identity instead of the mounted WEB identity', async () => {
    const conversation = { id: 'WEB:11111111-2222-4333-8444-555555555555', serverId$: () => THREAD };
    const { turns } = await scan([], [{
      id: 'server-bound-user', messages: [{ ...authored('native-user', 'Keep `literal` text.'), author: { role: 'user' } }],
      conversationProps: { conversation }
    }]);
    expect(turns[0]).toMatchObject({ conversationId: THREAD, conversationConflict: false });
    expect(turns[0]!.messages[0]).toMatchObject({ role: 'user', rawText: 'Keep `literal` text.' });
    expect(JSON.stringify(turns)).not.toContain('WEB:');
  });

  it.each([undefined, () => null, () => { throw new Error('unresolved'); }])('does not promote a local WEB identity when the durable signal is unavailable (%s)', async (serverId$) => {
    const { turns } = await scan([], [{
      id: 'unresolved-server-owner', messages: [authored('native-answer', 'Answer.')],
      conversationProps: { conversation: { id: 'WEB:11111111-2222-4333-8444-555555555555', serverId$ } }
    }]);
    expect(turns[0]).toMatchObject({ conversationId: null, conversationConflict: false });
  });

  it('keeps a contradictory durable server identity conflicted', async () => {
    const { turns } = await scan([], [{
      id: 'conflicting-server-owner', messages: [authored('native-answer', 'Answer.')],
      conversationProps: { conversationId: THREAD,
        conversation: { id: 'WEB:11111111-2222-4333-8444-555555555555', serverId$: () => '22222222-3333-4444-8555-666666666666' } }
    }]);
    expect(turns[0]).toMatchObject({ conversationId: null, conversationConflict: true });
  });

  it.each([{ clientThreadId: THREAD }, { conversation: { id: THREAD } }])('distinguishes contradictory conversation metadata from missing conversation metadata: %j', async (identity) => {
    const other = '11111111-2222-3333-4444-555555555555';
    const messages = [authored('assistant-conflicted-chat', 'Stale mounted answer.')];
    const { turns } = await scan([], [{
      id: 'turn-conflicted-chat',
      messages,
      rendered: ['Stale mounted answer.'],
      conversationProps: { ...identity, conversationId: other }
    }]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      conversationId: null,
      conversationConflict: true
    });
  });

  it('reads each visible turn separately rather than merging them', async () => {
    const first = [request('req-1', 'read_file'), answer('res-1', 'req-1', 'read_file')];
    const second = [request('req-2', 'run_command')];
    const { turns } = await scan([], [
      { id: 'turn-one', messages: first },
      { id: 'turn-two', messages: second }
    ]);

    expect(turns.map((turn) => turn.turnId)).toEqual(['turn-one', 'turn-two']);
    expect(turns[1]!.calls.map((call) => call.tool)).toEqual(['run_command']);
  });

  it('ignores the turns of an earlier page ChatGPT keeps undisplayed in the same tab', async () => {
    const { turns } = await scan([], [
      {
        id: 'source-turn', messages: [authored('source-message', 'Old chat.')], rendered: ['Old chat.'],
        conversationProps: { conversation: { id: '99999999-8888-4777-8666-555555555555' } }, keptPage: true
      },
      {
        id: 'resumed-turn', messages: [authored('resumed-message', 'New chat.')], rendered: ['New chat.'],
        conversationProps: { conversation: { id: THREAD } }
      }
    ]);

    expect(turns.map(turn => turn.turnId)).toEqual(['resumed-turn']);
    expect(turns[0]).toMatchObject({ conversationId: THREAD, conversationConflict: false });
  });

  it('takes canonical assistant identity and raw Markdown from the public text message model, not Markdown-node cardinality', async () => {
    const publicText = '**One** canonical update with `code`.';
    const messages = [
      thought('internal-thought-1'),
      request('req-1', 'read_file'),
      thought('internal-thought-2'),
      authored('assistant-public-1', publicText),
      answer('res-1', 'req-1', 'read_file')
    ];
    const { turns } = await scan([], [
      {
        id: 'turn-prose',
        messages,
        // Deliberately unlike the raw Markdown and deliberately more numerous. This is the
        // live 1.8.1 failure shape: activity/tool internals also render `.markdown`, so DOM
        // cardinality is not message cardinality and must never gate capture.
        rendered: ['One canonical update with code.', 'Inspected a file', 'Internal activity caption']
      }
    ]);

    expect(turns[0]!.messages).toEqual([
      {
        messageId: 'assistant-public-1',
        rawMessageId: 'assistant-public-1',
        role: 'assistant',
        stable: false,
        order: 3,
        createTime: null,
        rawText: publicText,
        renderedHtml: ''
      }
    ]);
  });

  it('resolves a finished public content-reference wrapper to its exact same-turn authored source', async () => {
    const source = authored('referenced-source', '{"action":"finish","reply":"Helper answer."}', {
      status: 'finished_successfully',
      workingTurnId: 'helper-work',
      turnExchangeId: 'helper-exchange'
    });
    source.metadata = { ...source.metadata, is_visually_hidden_from_conversation: true };
    const wrapper = authored(
      'public-reference-wrapper',
      '::chatgpt-content-reference{index="0" source_message_id="referenced-source"}',
      {
        status: 'finished_successfully',
        endTurn: true,
        channel: 'final',
        workingTurnId: 'helper-work',
        turnExchangeId: 'helper-exchange'
      }
    );

    const { turns } = await scan([], [{ id: 'helper-reference-turn', messages: [source, wrapper] }]);

    expect(turns[0]!.endMessageId).toBe(wrapper.id);
    expect(turns[0]!.messages).toEqual([
      expect.objectContaining({
        rawMessageId: wrapper.id,
        rawText: '{"action":"finish","reply":"Helper answer."}'
      })
    ]);
  });

  it('refuses a content-reference that points at private analysis', async () => {
    const source = authored('private-source', 'private reasoning', {
      status: 'finished_successfully',
      channel: 'analysis'
    });
    source.metadata = { ...source.metadata, is_visually_hidden_from_conversation: true };
    const wrapper = authored(
      'public-reference-wrapper',
      '::chatgpt-content-reference{index="0" source_message_id="private-source"}',
      { status: 'finished_successfully', endTurn: true, channel: 'final' }
    );

    const { turns } = await scan([], [{ id: 'private-reference-turn', messages: [source, wrapper] }]);

    expect(turns[0]!.messages).toEqual([
      expect.objectContaining({
        rawMessageId: wrapper.id,
        rawText: '::chatgpt-content-reference{index="0" source_message_id="private-source"}'
      })
    ]);
    expect(JSON.stringify(turns)).not.toContain('private reasoning');
  });

  it('attaches rendered HTML only when a public message has one unique exact visible-text match', async () => {
    const messages = [authored('assistant-public-1', 'A plain live update.')];
    const { turns } = await scan([], [
      { id: 'turn-html', messages, rendered: ['Unrelated activity', 'A plain live update.'] }
    ]);

    expect(turns[0]!.messages).toEqual([
      {
        messageId: 'assistant-public-1',
        rawMessageId: 'assistant-public-1',
        role: 'assistant',
        stable: false,
        order: 0,
        createTime: null,
        rawText: 'A plain live update.',
        renderedHtml: 'A plain live update.',
        sectionIndex: 0
      }
    ]);
  });

  /**
   * Markup is carried whole or not at all.
   *
   * Cutting it at a character count cuts it mid-tag, and the cut lands inside ChatGPT's
   * code-block chrome far more often than its size suggests, because that chrome is several
   * hundred characters of toolbar and layout around a few lines of code. What arrived then
   * was a presentation that stopped inside an unclosed box: the prose after the block gone,
   * and the remainder of the message drawn as code. The canonical text below is unaffected,
   * so refusing the capture costs presentation and never content.
   */
  it('drops a rendered capture too large to carry whole rather than cutting it mid-tag', async () => {
    const text = 'x'.repeat(121_000);
    const { turns } = await scan([], [
      {
        id: 'turn-oversized-html',
        messages: [authored('assistant-oversized', text)],
        rendered: [{ html: `<p>${text}</p>` }]
      }
    ]);

    expect(turns[0]!.messages[0]!.rawText).toBe(text);
    expect(turns[0]!.messages[0]!.renderedHtml).toBe('');
    // No rendered join was made either, so nothing downstream reads this block as evidence.
    expect(turns[0]!.messages[0]).not.toHaveProperty('sectionIndex');
  });

  it('keeps one exact logical id when ChatGPT rotates the raw UUID before the thought parent mounts', async () => {
    const relation = {
      parent: 'thought-stream-owner',
      workingTurnId: 'working-stream-owner',
      turnExchangeId: 'exchange-stream-owner'
    };
    const first = await scan([], [{
      id: 'turn-rotating-child',
      messages: [authored('raw-child-one', 'First partial.', relation)]
    }]);
    const second = await scan([], [{
      id: 'turn-rotating-child',
      messages: [authored('raw-child-two', 'First partial. More text.', relation)]
    }]);

    expect(first.turns[0]!.messages[0]!.rawMessageId).toBe('raw-child-one');
    expect(second.turns[0]!.messages[0]!.rawMessageId).toBe('raw-child-two');
    expect(first.turns[0]!.messages[0]!.messageId).toBe(second.turns[0]!.messages[0]!.messageId);
    expect(first.turns[0]!.messages[0]!.messageId).toBe(
      'assistant:thought-stream-owner:working-stream-owner:exchange-stream-owner'
    );
    expect(first.turns[0]!.messages[0]!.stable).toBe(false);
    expect(second.turns[0]!.messages[0]!.stable).toBe(false);
  });

  it('keeps one exact logical id when a reload re-parents the same server message', async () => {
    // The live shape from 2026-08-20: reloading a chat rehydrates it from the server, which
    // hands the same authored message a different `parent_id` while `working_turn_id`,
    // `turn_exchange_id` and `create_time` all stay put. Keyed on the parent, every message
    // already recorded came back as a second row and the transcript showed each one twice.
    const branch = { workingTurnId: 'working-43a30177', turnExchangeId: 'exchange-43a30177', createTime: 1_787_211_141.137 };
    const live = await scan([], [{
      id: 'turn-reloaded',
      messages: [authored('raw-live', 'I am auditing the MCP-visible contract first.', { ...branch, parent: 'thought-e97025b0' })]
    }]);
    const reloaded = await scan([], [{
      id: 'turn-reloaded',
      messages: [authored('raw-rehydrated', 'I am auditing the MCP-visible contract first.', { ...branch, parent: 'thought-3ecd4ef3' })]
    }]);

    expect(live.turns[0]!.messages[0]!.messageId).toBe(
      'assistant:working-43a30177:exchange-43a30177:1787211141137'
    );
    expect(reloaded.turns[0]!.messages[0]!.messageId).toBe(live.turns[0]!.messages[0]!.messageId);
    expect(live.turns[0]!.messages[0]!.stable).toBe(true);
    expect(reloaded.turns[0]!.messages[0]!.stable).toBe(true);
  });

  it('falls back to the parent tuple when two messages of one branch share a creation stamp', async () => {
    const branch = { workingTurnId: 'working-same', turnExchangeId: 'exchange-same', createTime: 1_787_211_141.137 };
    const { turns } = await scan([], [{
      id: 'turn-collision',
      messages: [
        authored('raw-first', 'First.', { ...branch, parent: 'thought-first' }),
        authored('raw-second', 'Second.', { ...branch, parent: 'thought-second' })
      ]
    }]);

    expect(turns[0]!.messages.map((message) => message.messageId)).toEqual([
      'assistant:working-same:exchange-same:1787211141137',
      'assistant:thought-second:working-same:exchange-same'
    ]);
  });

  it('preserves distinct authored segments even when raw, working and exchange UUIDs all repeat', async () => {
    const id = 'b7d6231f-1174-42f0-8ee0-e828d132020c';
    const times = [1788644947400, 1788644965847, 1788645029019, 1788645099694];
    const ids: string[] = [];
    for (const [index, time] of times.entries()) {
      const result = await scan([], [{ id: `segment-${index}`, messages: [authored(id, `Distinct segment ${index}`, {
        workingTurnId: id, turnExchangeId: id, createTime: time
      })] }]);
      ids.push(result.turns[0]!.messages[0]!.messageId);
    }
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual(times.map(time => `assistant:${id}:${id}:${time}`));
  });

  it('keeps two messages when both the creation stamp and parent tuple collide', async () => {
    const relation = { parent: 'thought-same', workingTurnId: 'working-same', turnExchangeId: 'exchange-same' };
    const { turns } = await scan([], [{
      id: 'turn-double-collision',
      messages: [
        authored('raw-first', 'First.', relation),
        authored('raw-second', 'Second.', relation)
      ]
    }]);

    expect(turns[0]!.messages.map((message) => message.messageId)).toEqual([
      'assistant:thought-same:working-same:exchange-same',
      'raw-second'
    ]);
    expect(turns[0]!.messages[1]!.stable).toBe(false);
  });

  it.each(['', 'Inspect this image.'])('captures native image metadata without inventing user prose (%s)', async text => {
    const message: Message = { id: 'native-image-user', author: { role: 'user' }, recipient: 'all',
      content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'must-not-cross-worlds' }, text] },
      metadata: { attachments: [{ id: 'native-file-id', name: 'example.avif', size: 123, mime_type: 'image/avif',
        library_file_id: 'private-library-id', source: 'private-source' }] } };
    const { turns } = await scan([], [{ id: 'image-turn', messages: [message] }]);
    expect(turns[0]!.messages).toEqual([expect.objectContaining({ messageId: message.id, rawText: text,
      attachments: [{ id: 'native-file-id', name: 'example.avif', size: 123, mimeType: 'image/avif' }] })]);
    expect(JSON.stringify(turns)).not.toMatch(/must-not-cross-worlds|private-library-id|private-source/);
    const assistant = await scan([], [{ id: 'not-user', messages: [{ ...message, author: { role: 'assistant' } }] }]);
    expect(assistant.turns).toEqual([]);
  });

  it('captures the opening user message from the page model before the DOM exposes a message id', async () => {
    const opening: Message = {
      id: 'user-opening-model-id',
      author: { role: 'user' },
      recipient: 'all',
      create_time: 1_787_165_000.125,
      content: { content_type: 'text', parts: ['first prompt before DOM identity'] }
    };
    const { turns } = await scan([], [{ id: 'turn-opening-user', messages: [opening] }]);

    expect(turns[0]!.messages).toEqual([
      {
        messageId: 'user-opening-model-id',
        rawMessageId: 'user-opening-model-id',
        role: 'user',
        stable: true,
        order: 0,
        createTime: 1_787_165_000_125,
        rawText: 'first prompt before DOM identity',
        renderedHtml: ''
      }
    ]);
  });

  it('keeps exact transcript evidence when a virtualized assistant section has no data-turn-id', async () => {
    const publicText = authored('assistant-idless-page-turn', 'Visible historical answer.');
    const { turns, turnStamps } = await scan([], [{ id: '', messages: [publicText], rendered: ['Visible historical answer.'] }]);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.turnId).toBeNull();
    expect(turns[0]!.messages[0]).toMatchObject({
      messageId: 'assistant-idless-page-turn',
      rawText: 'Visible historical answer.'
    });
    expect(turnStamps).toEqual(['test-nonce:0']);
  });

  it('keeps a long public assistant answer beyond the old 32k transcript cap', async () => {
    const long = 'handoff detail '.repeat(14000);
    expect(long.length).toBeGreaterThan(180_000);
    expect(long.length).toBeLessThan(256_000);
    const { turns } = await scan([], [{ id: 'turn-long-answer', messages: [authored('assistant-long', long)] }]);

    expect(turns[0]!.messages[0]!.rawText).toBe(long);
  });

  it('marks completion only from the finished public text message whose website object says end_turn', async () => {
    const internal = thought('thought-terminal-looking');
    internal.status = 'finished_successfully';
    internal.end_turn = true;
    const messages = [
      internal,
      authored('interim-public', 'Still working.', { status: 'finished_successfully', endTurn: false }),
      authored('final-public', 'Finished.', { status: 'finished_successfully', endTurn: true })
    ];
    const { turns } = await scan([], [{ id: 'turn-terminal', messages, rendered: ['Still working.', 'Finished.'] }]);

    expect(turns[0]!.endMessageId).toBe('final-public');
  });

  it('reads through the trailing analysis ghost the page leaves after a finished answer', async () => {
    // Measured live 2026-08-31 on a finished tool-heavy turn: the answer sits on `final` with
    // `end_turn`, and behind it the page keeps an empty `analysis` message at `in_progress`
    // forever. Reading the tail as "the last public text decides" hid the answer for good.
    const ghost = authored('analysis-ghost', '', { status: 'in_progress', channel: 'analysis' });
    const messages = [
      authored('final-public', 'Finished.', { status: 'finished_successfully', endTurn: true, channel: 'final' }),
      ghost
    ];
    const { turns } = await scan([], [{ id: 'turn-ghost', messages, rendered: ['Finished.'] }]);

    expect(turns[0]!.endMessageId).toBe('final-public');
    expect(turns[0]!.messages.map((message) => message.messageId)).toEqual(['final-public']);
  });

  it('retains an image-only terminal turn without requiring public text', async () => {
    const image = authored('image-final', '', { status: 'finished_successfully', endTurn: true, channel: 'final' });
    image.content = { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'image-test' }] };
    const { turns } = await scan([], [{ id: 'turn-image', messages: [image] }]);
    expect(turns[0]?.endMessageId).toBe('image-final');
    expect(turns[0]?.messages).toEqual([]);
  });

  it('does not reuse an old text completion while a newer image answer is still running', async () => {
    const image = authored('image-running', '', { status: 'in_progress', endTurn: false, channel: 'final' });
    image.content = { content_type: 'multimodal_text', parts: [] };
    const { turns } = await scan([], [{ id: 'turn-image-retry', messages: [authored('old-answer', 'Old', { status: 'finished_successfully', endTurn: true }), image] }]);
    expect(turns[0]?.endMessageId ?? null).toBeNull();
  });

  it('reads through a trailing commentary message that never carries the answer', async () => {
    const messages = [
      authored('final-public', 'Finished.', { status: 'finished_successfully', endTurn: true, channel: 'final' }),
      authored('narration', 'Wrapping up.', { status: 'finished_successfully', endTurn: false, channel: 'commentary' })
    ];
    const { turns } = await scan([], [{ id: 'turn-narration', messages, rendered: ['Finished.', 'Wrapping up.'] }]);

    expect(turns[0]!.endMessageId).toBe('final-public');
  });

  it('still lets a newer answer-capable message hold the turn open after an earlier answer ended', async () => {
    const messages = [
      authored('old-final', 'Old completed attempt.', { status: 'finished_successfully', endTurn: true, channel: 'final' }),
      authored('retry-active', 'Trying again.', { status: 'finished_successfully', endTurn: false, channel: 'final' })
    ];
    const { turns } = await scan([], [{ id: 'turn-channel-retry', messages, rendered: ['Old completed attempt.', 'Trying again.'] }]);

    expect(turns[0]!.endMessageId ?? null).toBeNull();
  });

  it('does not call an active turn finished merely because prior messages are finished successfully', async () => {
    const messages = [
      authored('prior-public', 'Checkpoint.', { status: 'finished_successfully', endTurn: false }),
      authored('active-public', 'Continuing.', { status: 'finished_successfully', endTurn: false })
    ];
    const { turns } = await scan([], [{ id: 'turn-active', messages, rendered: ['Checkpoint.', 'Continuing.'] }]);

    expect(turns[0]!.endMessageId ?? null).toBeNull();
  });

  it('treats a newer retry message as active even when the previous attempt ended successfully', async () => {
    const messages = [
      authored('old-final', 'Old completed attempt.', { status: 'finished_successfully', endTurn: true }),
      authored('retry-active', 'Trying again.', { status: 'finished_successfully', endTurn: false })
    ];
    const { turns } = await scan([], [{ id: 'turn-retry', messages, rendered: ['Old completed attempt.', 'Trying again.'] }]);

    expect(turns[0]!.endMessageId ?? null).toBeNull();
  });

  it('says nothing about a turn that made no connector call', async () => {
    const chatter: Message = { id: 'm-1', author: { role: 'assistant' }, recipient: 'all', content: { text: 'hello' } };
    const { turns } = await scan([], [{ id: 'turn-quiet', messages: [chatter] }]);

    expect(turns).toEqual([]);
  });

  it('reports a request id ChatGPT has published before the api_tool message exists', async () => {
    // The live 2026-08-21 shape. ChatGPT stamps `metadata.request_id` on the plain public
    // message the moment the turn issues a connector request, and holds the `api_tool`
    // message behind its safety check — measured on this machine at around forty seconds,
    // where the app gives up after fifteen. `calls` cannot see this id: there is no
    // recipient and no tool path to read yet. `requests` is the view that can.
    const pending = authored('m-pending', 'Working on it.', { createTime: 1786873650.5 });
    pending.metadata!['request_id'] = 'wfr_safety_held';
    const { turns } = await scan([], [{ id: 'turn-safety-held', messages: [pending], rendered: ['Working on it.'] }]);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.calls).toEqual([]);
    expect(turns[0]!.requests).toEqual([
      { requestId: 'wfr_safety_held', messageId: 'm-pending', createTime: 1786873650.5 }
    ]);
  });

  it('reports a turn that has nothing but a request id', async () => {
    // Nothing rendered, no row, no result — the turn used to be dropped whole, taking the
    // one fact the app actually needs with it.
    const bare: Message = {
      id: 'm-bare',
      author: { role: 'assistant' },
      recipient: 'all',
      metadata: { request_id: 'wfr_bare' }
    };
    const { turns } = await scan([], [{ id: 'turn-bare', messages: [bare] }]);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.requests).toEqual([{ requestId: 'wfr_bare', messageId: 'm-bare', createTime: null }]);
  });

  it('reports one request id once however many messages of the turn carry it', async () => {
    // ChatGPT reuses a single request id across a turn's request, its result and its public
    // message. The correlation join is a set, not a count.
    const { turns } = await scan([], [{
      id: 'turn-repeated-id',
      messages: [request('req-1', 'read_file'), answer('res-1', 'req-1', 'read_file')]
    }]);

    expect(turns[0]!.requests).toEqual([
      { requestId: 'wfr_01a009', messageId: 'req-1', createTime: 1786873658.125 }
    ]);
  });

  it('carries nothing but the id, the message it sat on and its stamp', async () => {
    const pending = authored('m-allowlist', 'Working.', { createTime: 1786873650.5 });
    pending.metadata!['request_id'] = 'wfr_allowlist';
    // Everything else on a real message's metadata, none of which may leave the page.
    pending.metadata!['parent_id'] = 'must-not-leak';
    pending.metadata!['turn_exchange_id'] = 'must-not-leak';
    const { turns } = await scan([], [{ id: 'turn-allowlist', messages: [pending], rendered: ['Working.'] }]);

    expect(Object.keys(turns[0]!.requests![0]!).sort()).toEqual(['createTime', 'messageId', 'requestId']);
  });

  it('clears a stale turn stamp when that section has no descriptor in this scan', async () => {
    const { turns, turnStamps } = await scan([], [
      { id: 'turn-stale-stamp', messages: [], staleStamp: '0' }
    ]);

    expect(turns).toEqual([]);
    expect(turnStamps).toEqual([null]);
  });
});

describe('which call a row stands for', () => {
  /**
   * ChatGPT's own "Open tool call list" for the turn behind this fixture read
   * `1: list_resources, 2: create_agents` under a single row, and the row showed
   * `create_agents`. So the representative is the group's own request, and the folded call
   * is a count — of a *different* tool, which is why the count can never be read as
   * "another call to the same tool as this one".
   */
  it('takes the group its own request, with the folded call counted and not named', async () => {
    const ask = request('req-agents', 'create_agents');
    const { rows } = await scan([
      row(
        [
          ask,
          answer('res-agents', 'req-agents', 'create_agents'),
          // The folded call's result. It is in this array, but it is chained to a request
          // that is not — reading it as this row's identity is the mislabelling bug.
          answer('res-resources', 'req-elsewhere', 'list_resources')
        ],
        1
      )
    ]);

    expect(rows[0]).toMatchObject({ tool: 'create_agents', hidden: 1, answered: true });
    expect(rows[0]!.resource).toContain('create_agents');
  });

  it('pairs the result by parent_id rather than by whatever came back next', async () => {
    const { rows } = await scan([
      row([
        request('req-mine', 'read_file'),
        // A neighbour's result, sitting where a forward scan would take it as ours.
        answer('res-theirs', 'req-theirs', 'run_command'),
        answer('res-mine', 'req-mine', 'read_file')
      ])
    ]);

    expect(rows[0]!.tool).toBe('read_file');
    expect(rows[0]!.resource).toContain('read_file');
    expect(rows[0]!.resource).not.toContain('run_command');
  });

  it('reports a call with no result of its own as unanswered rather than borrowing one', async () => {
    const { rows } = await scan([
      row([request('req-mine', 'search_files'), answer('res-theirs', 'req-theirs', 'run_command')])
    ]);

    expect(rows[0]).toMatchObject({ tool: 'search_files', answered: false, app: null, resource: null });
  });

  /**
   * The turn-level node carries every message of the turn. Picking a request out of it is
   * picking one of many by position, which is how a row ends up wearing a neighbour's
   * name — so reaching it means the group was not found, not "use this instead".
   */
  it('refuses the turn-level messages rather than guessing from them', async () => {
    const messages = [
      request('req-1', 'search_files'),
      answer('res-1', 'req-1', 'search_files'),
      request('req-2', 'read_file'),
      answer('res-2', 'req-2', 'read_file')
    ];
    const { rows } = await scan([chain(null, 4, turnNode(messages))]);

    expect(rows).toEqual([]);
  });

  it('gives up on a row whose group starts with something other than a connector request', async () => {
    const { rows } = await scan([row([answer('res-1', 'req-1', 'read_file'), request('req-2', 'search_files')])]);
    expect(rows).toEqual([]);
  });
});

describe('a payload the page stored truncated', () => {
  /**
   * `JSON.parse` throws `Unterminated string in JSON at position 741` on most live
   * requests. The old reader caught that and fell back to the recipient,
   * `api_tool.call_tool`, so the row was confidently labelled `call_tool` — a tool this
   * connector does not have and never ran.
   */
  it('still names the tool, and never falls back to the connector bridge', async () => {
    const { rows } = await scan([
      row([request('req-1', 'create_file', { truncate: 90 }), answer('res-1', 'req-1', 'create_file')])
    ]);

    expect(rows[0]!.tool).toBe('create_file');
    expect(rows[0]!.tool).not.toBe('call_tool');
  });

  it('falls back to the result when the cut lands inside the path itself', async () => {
    const { rows } = await scan([
      row([request('req-1', 'create_file', { truncate: 40 }), answer('res-1', 'req-1', 'create_file')])
    ]);

    expect(rows[0]).toMatchObject({ tool: 'create_file', path: null, answered: true });
  });

  it('says nothing at all when neither source can be read', async () => {
    const { rows } = await scan([row([request('req-1', 'create_file', { truncate: 40 })])]);

    // The descriptor still exists — it carries the fold count — but it names no tool, so
    // applyPageLabel leaves the row exactly as ChatGPT drew it.
    expect(rows[0]).toMatchObject({ tool: null, path: null, answered: false });
  });

  it('fails closed when the request and the result name different tools', async () => {
    const { rows } = await scan([
      row([request('req-1', 'search_files'), answer('res-1', 'req-1', 'read_file')])
    ]);

    // Two sources disagreeing means the pairing is wrong. A row left saying "Called tool"
    // is a smaller failure than a row saying "Search files" over a file read.
    expect(rows[0]!.tool).toBeNull();
  });
});

describe('what may leave the page', () => {
  const receiptResource = (id: string) => ({ type: 'resource', resource: {
    uri: 'urn:cos:result-receipt:v1:' + id,
    mimeType: 'application/vnd.chat-on-steroids.result-receipt+json',
    text: JSON.stringify({ version: 1, id })
  } });
  it.each(['resource-only', 'matching-both'])('recovers the exact native result from the committed MCP embedded resource (%s)', async carrier => {
    const id = 'ba'.repeat(24);
    const first = request('carrier-sibling', 'read');
    const asked = request('carrier-owner', 'read');
    const result = answer('carrier-result', asked.id, 'read');
    result.author.name = 'api_tool.call_tool';
    result.content!.text = JSON.stringify({
      content: [{ type: 'text', text: 'private body sentinel' }, receiptResource(id)],
      ...(carrier === 'matching-both' ? { structuredContent: { cosResultReceipt: { version: 1, id } } } : {})
    });
    const messages = [first, asked, result];
    const { turns } = await scan([rowInTurn(messages, messages)], [{ id: 'carrier-turn', messages }]);
    expect(turns[0]?.calls).toMatchObject([
      { messageId: first.id, answered: false },
      { messageId: asked.id, answered: true, resultReceiptId: id }
    ]);
    expect(JSON.stringify(turns)).not.toContain('private body sentinel');
    expect(JSON.stringify(turns)).not.toContain('urn:cos');
  });
  it.each(['duplicate', 'different-id', 'wrong-uri', 'wrong-mime', 'malformed-text',
    'text-only', 'nested-envelope', 'conflicting-structured', 'invalid-structured', 'unfinished',
    'foreign-tool', 'foreign-parent'])('refuses an ambiguous or unproved receipt resource (%s)', async fault => {
    const id = 'ba'.repeat(24);
    const asked = request('refused-carrier-owner', 'read');
    const result = answer('refused-carrier-result', asked.id, 'read');
    result.author.name = 'api_tool.call_tool';
    const resource = receiptResource(id);
    let content: unknown[] = [resource];
    let structuredContent: unknown;
    if (fault === 'duplicate') content.push(receiptResource(id));
    if (fault === 'different-id') content.push(receiptResource('ab'.repeat(24)));
    if (fault === 'wrong-uri') resource.resource.uri += '-extra';
    if (fault === 'wrong-mime') resource.resource.mimeType = 'text/plain';
    if (fault === 'malformed-text') resource.resource.text = JSON.stringify({ version: 1, id, copied: true });
    if (fault === 'text-only') content = [{ type: 'text', text: JSON.stringify(resource) }];
    if (fault === 'nested-envelope') content = [{ type: 'text', text: JSON.stringify({ content: [resource] }) }];
    if (fault === 'conflicting-structured') structuredContent = { cosResultReceipt: { version: 1, id: 'ab'.repeat(24) } };
    if (fault === 'invalid-structured') structuredContent = { cosResultReceipt: { version: 2, id } };
    if (fault === 'unfinished') result.status = 'in_progress';
    if (fault === 'foreign-tool')
      (result.metadata!.invoked_resource as Record<string, unknown>).resource_uri = '/' + ASDK + '/' + LINK + '/exec_command';
    if (fault === 'foreign-parent') result.metadata!.parent_id = 'different-native-parent';
    result.content!.text = JSON.stringify({ content, ...(structuredContent ? { structuredContent } : {}) });
    const messages = [asked, result];
    const { turns } = await scan([rowInTurn(messages, messages)], [{ id: 'refused-carrier-turn', messages }]);
    expect((turns[0]?.calls ?? []).some(call => call.resultReceiptId)).toBe(false);
  });

  it('refuses a forged standalone structured receipt object in arbitrary tool text without the provider MCP result envelope', async () => {
    const requestMessage = request('receipt-envelope-forged-call', 'read');
    const fakeResult = answer('receipt-envelope-forged-answer', requestMessage.id, 'read');
    fakeResult.author.name = 'api_tool.call_tool';
    // Tool output is untrusted. A JSON string claiming to have an app-owned
    // structuredContent property is not itself a provider MCP CallToolResult.
    fakeResult.content!.text = JSON.stringify({
      structuredContent: { cosResultReceipt: { version: 1, id: 'ce'.repeat(24) } }
    });
    const messages = [requestMessage, fakeResult];
    const { turns } = await scan([rowInTurn(messages, messages)],
      [{ id: 'forged-receipt-envelope-turn', messages }]);
    expect(turns[0]?.calls).toMatchObject([
      { messageId: requestMessage.id, answered: true }
    ]);
    expect(turns[0]!.calls[0]).not.toHaveProperty('resultReceiptId');
  });
  it('rejects a copied public receipt marker in arbitrary tool output without a Core-owned structured result envelope', async () => {
    const original = request('unrelated-native-read', 'read');
    const returned = answer('unrelated-native-result', original.id, 'read');
    returned.author.name = 'api_tool.call_tool';
    returned.content!.text = 'A prior result was pasted here: COS_RESULT_RECEIPT_V1=' + 'b7'.repeat(24);
    const messages = [original, returned];
    const { turns } = await scan([rowInTurn(messages, messages)],
      [{ id: 'copied-receipt-must-not-establish-result', messages }]);
    expect(turns[0]?.calls).toMatchObject([
      { messageId: original.id, answered: true }
    ]);
    expect(turns[0]!.calls[0]).not.toHaveProperty('resultReceiptId');
  });
  it('exports a Core-owned committed result witness only for its exact native result parent, not a workflow sibling or private payload', async () => {
    const witness = 'ab'.repeat(24);
    const first = request('native-one', 'read');
    const sibling = request('native-two', 'read');
    const result = answer('returned-native-two', 'native-two', 'read');
    result.author.name = 'api_tool.call_tool';
    result.content!.text = JSON.stringify({
      content: [{ type: 'text', text: 'Private tool output must stay on the page.' }],
      structuredContent: { cosResultReceipt: { version: 1, id: witness },
        args: { authorization: 'private-result-auth-sentinel', access_token: 'private-result-token-sentinel' } }
    });
    const messages = [first, sibling, result];
    const { turns } = await scan([rowInTurn(messages, messages)],
      [{ id: 'exact-native-receipt-turn', messages }]);
    const calls = turns[0]?.calls ?? [];
    expect(calls).toMatchObject([
      { messageId: 'native-one', answered: false },
      { messageId: 'native-two', answered: true, resultReceiptId: witness }
    ]);
    expect(calls[0]).not.toHaveProperty('resultReceiptId');
    expect(JSON.stringify(turns)).not.toContain('Private tool output');
    expect(JSON.stringify(turns)).not.toMatch(/private-result-auth-sentinel|private-result-token-sentinel|authorization|access_token/);

    // A different app/tool's result and an unproved native parent can never
    // create the witness, even when their text contains the same opaque value.
    result.metadata!.parent_id = 'native-one';
    (result.metadata!.invoked_resource as Record<string, unknown>).resource_uri =
      `/${ASDK}/${LINK}/exec_command`;
    const foreign = await scan([rowInTurn(messages, messages)],
      [{ id: 'invalid-result-parent-turn', messages }]);
    expect((foreign.turns[0]?.calls ?? []).some(call => call.resultReceiptId)).toBe(false);
  });
  it.each(['before', 'after'])('refuses a received Core witness when a second unreceipted native tool result names its same parent (%s)', async position => {
    const asked = request('native-double-result', 'read');
    const witness = 'af'.repeat(24);
    const valid = answer('native-double-result-receipted', asked.id, 'read');
    valid.author.name = 'api_tool.call_tool';
    valid.content!.text = JSON.stringify({ content: [{ type: 'text', text: 'private disk output' }],
      structuredContent: { cosResultReceipt: { version: 1, id: witness } } });
    const duplicate = answer('native-double-result-unreceipted', asked.id, 'read');
    duplicate.author.name = 'api_tool.call_tool';
    const messages = position === 'before' ? [asked, duplicate, valid] : [asked, valid, duplicate];
    const { turns } = await scan([rowInTurn(messages, messages)],
      [{ id: 'native-double-result-turn', messages }]);
    // A duplicate provider result is not an acknowledged native result,
    // even when one of its siblings carries a valid recorder witness.
    expect(turns[0]?.calls).toMatchObject([{ messageId: asked.id, answered: false }]);
    expect(turns[0]!.calls[0]).not.toHaveProperty('resultReceiptId');
    expect(JSON.stringify(turns)).not.toContain('private disk output');
  });

  it('refuses a Core result witness from an explicitly unfinished provider message even when its receipt structure is valid', async () => {
    const asked = request('native-result-still-streaming', 'read');
    const returned = answer('native-result-streaming', asked.id, 'read');
    returned.author.name = 'api_tool.call_tool';
    returned.status = 'in_progress';
    returned.content!.text = JSON.stringify({
      content: [{ type: 'text', text: 'private output' }],
      structuredContent: { cosResultReceipt: { version: 1, id: 'ac'.repeat(24) } }
    });
    const messages = [asked, returned];
    const { turns } = await scan([rowInTurn(messages, messages)],
      [{ id: 'native-result-still-streaming-turn', messages }]);
    // A serialized object from a still-running provider result is not a
    // native result ACK; otherwise Goal/Loop can settle before completion.
    expect(turns[0]?.calls).toMatchObject([{ messageId: asked.id, answered: false }]);
    expect(turns[0]!.calls[0]).not.toHaveProperty('resultReceiptId');
  });
  describe('a connector renamed in ChatGPT (app id, 2026-10-11)', () => {
    const NAMES = { core: APP, desktop: DESKTOP_APP, plugins: PLUGINS_APP };
    const pair = (app: string, requestId: string, uri?: string) => {
      const asked = request(`${requestId}-ask`, 'read', { app });
      asked.metadata!.request_id = requestId;
      const result = answer(`${requestId}-res`, asked.id, 'read', app);
      result.metadata!.request_id = requestId;
      result.author.name = 'api_tool.call_tool';
      if (uri) (result.metadata!.invoked_resource as Record<string, unknown>).resource_uri = uri;
      return [asked, result];
    };

    it('treats a renamed connector as ours by its learned app id and link', async () => {
      const messages = pair('My tools', 'q1');
      const { rows, turns } = await scan([rowInTurn(messages, messages)], [{ id: 'renamed-turn', messages }], { apps: NAMES, appIds:
        [{ surface: 'core', appId: ASDK, linkId: LINK, name: 'My tools' }] });
      expect(turns[0]!.calls.map(call => call.tool)).toEqual(['read']);
      expect(rows[0]).toMatchObject({ own: true });
    });

    it('does not claim a same-named app once the real app id is learned', async () => {
      const messages = pair(APP, 'q2', '/asdk_app_foreign/link_foreign/read');
      const content = messages[0]!.content as Record<string, string>;
      content['text'] = content['text']!.replace(LINK, 'link_foreign');
      const { rows, turns } = await scan([rowInTurn(messages, messages)], [{ id: 'foreign-turn', messages }], { apps: NAMES, appIds:
        [{ surface: 'core', appId: ASDK, linkId: LINK, name: APP }] });
      expect(turns[0]?.calls ?? []).toEqual([]);
      expect(rows[0]).toMatchObject({ own: false });
    });

    it('falls back to the names while nothing is learned', async () => {
      const messages = pair(APP, 'q3');
      const { rows, turns } = await scan([rowInTurn(messages, messages)], [{ id: 'names-turn', messages }], { apps: NAMES, appIds: [] });
      expect(turns[0]!.calls.map(call => call.tool)).toEqual(['read']);
      expect(rows[0]).toMatchObject({ own: true });
    });

    it('reports a sighting for every connector result row, ours or not', async () => {
      const messages = [...pair('My tools', 'q4'), ...pair('Gmail', 'q5', '/asdk_app_gmail/link_g/search')];
      const { turns } = await scan([], [{ id: 'sighting-turn', messages }], { apps: NAMES, appIds: [] });
      expect(turns[0]!.sightings).toEqual([
        { requestId: 'q4', appId: ASDK, linkId: LINK, appName: 'My tools' },
        { requestId: 'q5', appId: 'asdk_app_gmail', linkId: 'link_g', appName: 'Gmail' }
      ]);
    });
  });

  /**
   * The payload carries the user's own text and this app's own secrets. The tool path is
   * the first field of it; a file tool's own `path` argument is a second `"path"` later in
   * the same string, and reading that one would put a user's filename on a row and ship it
   * out of the page context.
   */
  it('reads the tool path and never the path argument beside it', async () => {
    const { rows } = await scan([row([request('req-1', 'create_file')])]);

    expect(rows[0]!.path).toBe(`/${APP}/${LINK}/create_file`);
    expect(JSON.stringify(rows[0])).not.toContain('secret.txt');
  });

  it('emits the allowlisted fields and nothing else', async () => {
    const { rows } = await scan([row([request('req-1', 'read_file'), answer('res-1', 'req-1', 'read_file')])]);

    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        'answered',
        'app',
        'conversationId',
        'createTime',
        'hidden',
        'index',
        'localCount',
        'messageId',
        'own',
        'path',
        'resource',
        'tool',
        'turnId',
        'v'
      ].sort()
    );
  });

  it('does not let one unreadable row cost the others their labels', async () => {
    const { rows } = await scan([
      row([request('req-1', 'read_file')]),
      chain(null, 4, turnNode([request('req-2', 'search_files')])),
      row([request('req-3', 'run_command')])
    ]);

    expect(rows.map((entry) => [entry.index, entry.tool])).toEqual([
      [0, 'read_file'],
      [2, 'run_command']
    ]);
  });
});

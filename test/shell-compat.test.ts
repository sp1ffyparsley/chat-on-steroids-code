/**
 * Current ChatGPT alternate-shell compatibility, exercised through the shipped MAIN-world
 * Fiber helper and isolated-world DOM adapter together. These fixtures deliberately use the
 * native shell's typed turn/items and search-unit layout; selector-only tests would miss the
 * provenance boundary this suite exists to protect.
 */

import { promises as fs } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

let fiberSource = '';
let currentFiberProducer = 0;
let domSource = '';

beforeAll(async () => {
  [fiberSource, domSource] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'extension', 'fiber.js'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'extension', 'chatgpt-dom.js'), 'utf8')
  ]);
  currentFiberProducer = Number(/const PRODUCER_VERSION = (\d+);/.exec(fiberSource)?.[1]);
  expect(currentFiberProducer).toBeGreaterThan(0);
});

// Identity discovery reads provider metadata only when a selected, exact native
// request establishes scope. An orphan result outside the selected path is not
// sufficient on its own, even if its request label matches an unproved call.
it.each([false, true])('projects a shell app identity without private tool output (outside=%s)', async outsideResult => {
  const page = await shellHarness({ withCall: true, identitySightings: true, outsideResult });
  try {
    expect(page.fiber.turns[0].sightings).toEqual(outsideResult ? [] : [
      { requestId: REQUEST, appId: ASDK, linkId: LINK, appName: APP }
    ]);
    expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    expect(JSON.stringify(page.fiber)).not.toContain('foreign-request');
  } finally { page.dom.window.close(); }
});
const THREAD = 'f0f00004-1111-4111-8111-111111111111';
const TURN = 'shell-turn-1';
const USER = 'f0f00004-1111-4111-8111-111111111201';
const ASSISTANT = 'f0f00004-1111-4111-8111-111111111202';
const RESULT = 'f0f00004-1111-4111-8111-111111111203';
const CALL = 'call_shell_read';
const REQUEST = 'wfr_shell_01';
const EXEC = 'call_shell_exec';
const EXEC_REQUEST = 'wfr_shell_exec_01';
const EXEC_RESULT = 'f0f00004-1111-4111-8111-111111111206';
const REFERENCE_SOURCE = 'f0f00004-1111-4111-8111-111111111204';
const INTERIM = 'f0f00004-1111-4111-8111-111111111205';
const APP = 'Luna_Forge_X7_Core';
const LINK = 'link_11111111222233334444555555555555';
const ASDK = 'asdk_app_22222222333344445555666666666666';
const LOCAL_THREAD = 'local-chatgpt:e3de07c0-d1a4-4fdc-8a8d-d3534f7047f9';
const CALL_REJECT_KEYS = ['callCompletionVeto', 'callLiveMappingMissing', 'callLiveMappingConflict',
  'callPathMissing', 'callReceiptMissing', 'callReceiptConflict', 'callNativePending',
  'callScopeConflict', 'callExecUnresolved'] as const;
const EMPTY_CALL_REJECTS = Object.fromEntries(CALL_REJECT_KEYS.map(key => [key, 0]));
const CALL_JOIN_KEYS = ['callJoinReferenceMissing', 'callJoinReferenceUnselected', 'callJoinReferenceConflict',
  'callJoinResultMissing', 'callJoinResultIdentity', 'callJoinDescriptorUnsupported',
  'callIdentityRecovered', 'callIdentityPriorPair', 'callIdentityUserUnproved',
  'callIdentityNativeUnproved', 'callIdentityScopeUnproved', 'callIdentityParentUnproved',
  'callIdentitySelectedWithheld',
  'identityReasonCurrentQuestionMissing', 'identityReasonCurrentQuestionUnselected', 'identityReasonCurrentQuestionConflict', 'identityReasonNativeInvocationMissing', 'identityReasonNativeInvocationMismatch', 'identityReasonRequestIdMissing', 'identityReasonDecodedPathMissing', 'identityReasonDecodedPathForeign', 'identityReasonServerMissing', 'identityReasonServerMismatch', 'identityReasonToolMismatch', 'identityReasonWorkingTurnMissing', 'identityReasonWorkingTurnMismatch', 'identityReasonTurnExchangeMissing', 'identityReasonTurnExchangeMismatch', 'identityReasonNativeAncestryUnproved', 'identityReasonPriorRequestIdMissing', 'identityReasonPriorRequestIdMismatch', 'identityReasonPriorResultResourceIncomplete', 'identityReasonPriorToolScopeMismatch', 'identityReasonNativeScopeTurnIncomplete', 'identityReasonNativeScopePathUnproved', 'identityReasonNativeScopeFinalCount', 'identityReasonNativeScopeFinalPathMismatch', 'identityReasonNativeScopeFinalReceiptUnproved', 'identityReasonNativeScopeFinalNamespaceMissing', 'identityReasonNativeScopeNodeConflict', 'identityReasonNativeScopeCacheConflict', 'identityReasonNativeScopeBranchConflict', 'identityReasonNativeScopeUnsupported'] as const;
const EMPTY_CALL_JOINS = Object.fromEntries(CALL_JOIN_KEYS.map(key => [key, 0]));
const EMPTY_VETO_RECEIPT_CHECKS = { callVetoReceiptChecked: 0, callVetoReceiptMatched: 0 };
const EMPTY_ASSISTANT_TERMINAL_RECEIPTS = { assistantTerminalReceiptChecked: 0, assistantTerminalReceiptMatched: 0 };
const COMPLETION_VETO_SHAPES = ['callCompletedFalse', 'callCompletedUndefined', 'callCompletedNull',
  'callCompletedMalformed', 'callStatusVeto'] as const;
const EMPTY_COMPLETION_VETO_SHAPES = Object.fromEntries(COMPLETION_VETO_SHAPES.map(key => [key, 0]));
const COMPLETION_VETO_STATUSES = ['callVetoStatusAbsent', 'callVetoStatusPending', 'callVetoStatusError',
  'callVetoStatusDone', 'callVetoStatusFinal', 'callVetoStatusCompleted', 'callVetoStatusComplete',
  'callVetoStatusFinished', 'callVetoStatusFinishedSuccessfully', 'callVetoStatusUnknown'] as const;
const EMPTY_COMPLETION_VETO_STATUSES = Object.fromEntries(COMPLETION_VETO_STATUSES.map(key => [key, 0]));
const USER_PROJECTION_KEYS = ['userTypedMissing', 'userIdentityInvalid', 'userTextEmpty',
  'userTextUnsupported', 'userBudgetDropped', 'userProjected'] as const;
const EMPTY_USER_PROJECTION = Object.fromEntries(USER_PROJECTION_KEYS.map(key => [key, 0]));
const EMPTY_REQUEST_ID_SHAPES = { callRequestIdPresent: 0, callRequestIdMissing: 0 };

interface ShellOptions {
  appIds?: { appId: string; linkId: string; surface: string; name: string }[];
  diagnosticLogs?: string[];
  status?: 'in_progress' | 'complete';
  assistantCompleted?: boolean;
  withCall?: boolean;
  callCompleted?: boolean | 'missing' | null | 'invalid';
  nativeCallReceipt?: boolean;
  nativeCallLive?: boolean;
  nativeCallLiveConflict?: boolean;
  nativeCurrentNode?: string;
  nativeCallCacheConflict?: boolean;
  nativeAssistantCacheConflict?: boolean;
  nativeCallMutation?: (mapping: Record<string, any>, entry: any) => void;
  nativeDigestSettled?: () => void;
  identitySightings?: boolean;
  outsideResult?: boolean;
  withExec?: boolean;
  provisional?: boolean;
  staleFiber?: boolean;
  visualStopText?: boolean;
  retainedLocalIdentity?: boolean;
  contentReference?: 'public' | 'analysis';
  objectConversationQuery?: boolean;
  omitPublicReferenceChannel?: boolean;
  temporaryLocalConversation?: boolean;
  withoutUserSlot?: boolean;
  committedRootDepth?: number;
  dilReference?: 'exact' | 'foreign' | 'duplicate' | 'oversized';
  dilMarkdown?: string;
  nestedInterim?: 'plain' | 'dil' | 'foreign' | 'analysis' | 'hoisted';
  domTurnKey?: string;
  layoutKey?: string;
  /** Number of ordinary Fiber ancestors between this DOM node and its typed shell owner. */
  shellOwnerDepth?: number;
  omitFiber?: boolean;
  missingShellEntry?: boolean;
  oversizedShellItems?: boolean;
  shellItemsMutation?: (items: any[]) => void;
  omitShellSelector?: boolean;
  userIdentity?: 'server-only' | 'discordant' | 'duplicate';
  secondShell?: 'exact' | 'foreign-entry' | 'foreign-conversation' | 'foreign-assistant';
}

function queryClient(mapping: Record<string, unknown>, options: ShellOptions) {
  return {
    getQueryCache() {
      return {
        getAll() {
          return [{
            queryKey: ['chatgpt-conversation', options.objectConversationQuery
              ? { serverConversationId: THREAD }
              : THREAD],
            state: { data: options.objectConversationQuery
              ? { conversationId: THREAD, mapping }
              : { conversation_id: THREAD, mapping } }
          }];
        }
      };
    }
  };
}

function shellEntry(options: ShellOptions, identity: {
  entryId?: string;
  conversationId?: string;
  assistantId?: string;
} = {}) {
  const status = options.status ?? 'complete';
  const assistantId = identity.assistantId ?? ASSISTANT;
  const conversationId = identity.conversationId ?? (options.provisional ? 'local-chatgpt:fixture'
    : options.temporaryLocalConversation ? LOCAL_THREAD : THREAD);
  const user: any = { type: 'user-message', messageId: USER, serverMessageId: USER, message: 'hello shell' };
  if (options.userIdentity === 'server-only') delete user.messageId;
  if (options.userIdentity === 'discordant') user.serverMessageId = REFERENCE_SOURCE;
  const items: any[] = [
    user,
    {
      type: 'assistant-message', messageId: assistantId,
      content: options.contentReference
        ? `::chatgpt-content-reference{index="0" source_message_id="${REFERENCE_SOURCE}"}`
        : 'hello back',
      phase: 'final_answer', completed: options.assistantCompleted ?? (status === 'complete')
    }
  ];
  if (options.userIdentity === 'duplicate') items.splice(1, 0, {
    type: 'user-message', messageId: REFERENCE_SOURCE, serverMessageId: REFERENCE_SOURCE, message: 'other question'
  });
  const messageIds = [USER, assistantId];
  if (options.nestedInterim) {
    const interim: any = { type: 'assistant-message', messageId: INTERIM,
      phase: options.nestedInterim === 'analysis' ? 'analysis' : 'final_answer', completed: true,
      content: options.nestedInterim === 'plain' || options.nestedInterim === 'analysis'
        ? 'Now editing `a.txt`.'
        : `::chatgpt-content-reference{index="0" source_message_id="${INTERIM}"}`,
      contentReferences: [{ type: 'dil',
        source_message_id: options.nestedInterim === 'foreign' ? REFERENCE_SOURCE : INTERIM,
        model_dil_v2: { fallbackMarkdown: 'Now editing `a.txt`.' } }] };
    items.splice(1, 0, { type: 'chatgpt-reasoning-group', items: [interim, { ...interim }] });
    if (options.nestedInterim === 'hoisted') items.splice(2, 0, { ...interim });
  }
  if (options.dilReference) {
    const answer = items[1];
    answer.content = `::chatgpt-content-reference{index="0" source_message_id="${ASSISTANT}"}`;
    const reference = {
      type: 'dil', source_message_id: options.dilReference === 'foreign' ? REFERENCE_SOURCE : ASSISTANT,
      model_dil_v2: { fallbackMarkdown: options.dilReference === 'oversized' ? 'x'.repeat(600 * 1024)
        : options.dilMarkdown ?? '{"action":"continue","reply":"Continue the verified work."}' }
    };
    answer.contentReferences = options.dilReference === 'duplicate' ? [reference, reference] : [reference];
  }
  if (options.withCall) {
    items.splice(1, 0, {
      type: 'mcp-tool-call', callId: CALL,
      ...(options.callCompleted === 'missing' ? {} : { completed: options.callCompleted === undefined ? true : options.callCompleted }),
      invocation: { server: APP, tool: 'read' },
      widgetStateSource: { messageId: RESULT }
    });
    messageIds.splice(1, 0, options.outsideResult ? CALL : RESULT);
    if (options.nativeCallReceipt) messageIds.splice(1, 0, CALL);
  }
  if (options.withExec) {
    items.splice(1, 0, { type: 'dynamic-tool-call', tool: 'exec', callId: EXEC, completed: true });
  }
  if (options.oversizedShellItems) {
    while (items.length <= 5000) items.push({ type: 'unknown-fixture-item' });
  }
  options.shellItemsMutation?.(items);
  return {
    id: identity.entryId ?? TURN,
    conversationId,
    turn: { status, messageIds, items }
  };
}

function shellMapping(options: ShellOptions) {
  const mapping: Record<string, any> = {
    [USER]: { id: USER, message: { id: USER, author: { role: 'user' }, metadata: {} } },
    [ASSISTANT]: {
      id: ASSISTANT,
      message: {
        id: ASSISTANT, author: { role: 'assistant' }, recipient: 'all', channel: 'final',
        status: options.status === 'in_progress' ? 'in_progress' : 'finished_successfully',
        end_turn: options.status !== 'in_progress', content: { content_type: 'text', parts: ['hello back'] }, metadata: {}
      }
    }
  };
  if (options.withCall) {
    mapping[RESULT] = {
      id: RESULT,
      message: {
        id: RESULT,
        author: { role: 'tool', ...(options.identitySightings ? { name: 'api_tool.call_tool' } : {}) },
        content: { parts: ['PRIVATE_TOOL_RESULT'] },
        recipient: 'all',
        create_time: 1786873669.5,
        metadata: {
          request_id: REQUEST,
          invoked_resource: { app_name: APP, resource_uri: `/${ASDK}/${LINK}/read` }
        }
      }
    };
  }
  if (options.outsideResult) {
    mapping[CALL] = { id: CALL, message: { id: CALL, author: { role: 'assistant' }, recipient: 'api_tool.call_tool',
      content: { text: '{"path":"/Luna Forge X7 Core/' + LINK + '/read","args":{}}' }, metadata: { request_id: REQUEST } } };
    mapping.foreign = { id: 'foreign', message: { id: 'foreign', author: { role: 'tool', name: 'api_tool.call_tool' },
      metadata: { request_id: 'foreign-request', invoked_resource: { app_name: 'Gmail', resource_uri: '/asdk_app_gmail/link_gmail/search' } } } };
  }
  if (options.withExec) {
    mapping[EXEC] = {
      id: EXEC,
      message: {
        id: EXEC,
        author: { role: 'assistant' },
        recipient: 'functions.exec',
        create_time: 1786873668.5,
        metadata: { request_id: EXEC_REQUEST }
      }
    };
  }
  if (options.contentReference) {
    mapping[REFERENCE_SOURCE] = {
      id: REFERENCE_SOURCE,
      message: {
        id: REFERENCE_SOURCE,
        author: { role: 'assistant' },
        recipient: 'all',
        ...(options.omitPublicReferenceChannel && options.contentReference === 'public'
          ? {}
          : { channel: options.contentReference === 'analysis' ? 'analysis' : 'final' }),
        status: 'finished_successfully',
        content: {
          content_type: 'text',
          parts: [options.contentReference === 'analysis' ? 'private reasoning' : '{"action":"continue","reply":"Keep qualifying the production pilot."}']
        },
        metadata: { is_visually_hidden_from_conversation: true }
      }
    };
  }
  return mapping;
}

function completeExecBeforeCall(mapping: Record<string, any>, entry: any) {
  const scope = { request_id: EXEC_REQUEST, working_turn_id: TURN, turn_exchange_id: USER };
  Object.assign(mapping[EXEC], { parent: USER });
  Object.assign(mapping[EXEC].message, {
    status: 'finished_successfully',
    metadata: { ...scope, parent_id: USER }
  });
  mapping[EXEC_RESULT] = {
    id: EXEC_RESULT,
    parent: EXEC,
    message: {
      id: EXEC_RESULT,
      author: { role: 'tool', name: 'functions.exec' },
      recipient: 'all',
      status: 'finished_successfully',
      metadata: { ...scope, parent_id: EXEC }
    }
  };
  mapping[CALL].parent = EXEC_RESULT;
  mapping[CALL].message.metadata.parent_id = EXEC_RESULT;
  entry.turn.messageIds = [USER, EXEC, EXEC_RESULT, CALL, RESULT, ASSISTANT];
}

/** A valid 628-node branch within the existing 200-call/400-public-item bounds. */
function longNativeCompletionPath(mapping: Record<string, any>, entry: any) {
  const user = entry.turn.items.find((item: any) => item.type === 'user-message');
  const final = entry.turn.items.find((item: any) => item.type === 'assistant-message' && item.phase === 'final_answer');
  const scope = { request_id: REQUEST, working_turn_id: TURN, turn_exchange_id: USER };
  for (const id of Object.keys(mapping)) if (id !== USER && id !== ASSISTANT) delete mapping[id];
  entry.turn.items = [user];
  entry.turn.messageIds = [USER];
  let previous = USER;
  const append = (id: string, message: Record<string, any>) => {
    mapping[id] = { id, parent: previous, message: { id, ...message,
      metadata: { ...scope, parent_id: previous, ...message.metadata } } };
    previous = id;
  };
  for (let index = 0; index < 2; index++) {
    const id = `long-public-${index}`;
    entry.turn.items.push({ type: 'assistant-message', messageId: id, phase: 'commentary',
      content: 'Public progress.', completed: true });
    entry.turn.messageIds.push(id);
    append(id, { author: { role: 'assistant' }, recipient: 'all', channel: 'commentary',
      status: 'finished_successfully', end_turn: false, content: { content_type: 'text', parts: ['Public progress.'] } });
  }
  const reasoning = { type: 'chatgpt-reasoning-group', items: [] as any[] };
  entry.turn.items.push(reasoning);
  for (let index = 0; index < 156; index++) {
    const exec = index === 0 ? EXEC : `long-exec-${index}`;
    const call = index === 0 ? CALL : `long-call-${index}`;
    const result = index === 0 ? RESULT : `long-result-${index}`;
    reasoning.items.push({ type: 'dynamic-tool-call', tool: 'exec', callId: exec, completed: true },
      { type: 'mcp-tool-call', callId: call, invocation: { server: APP, tool: 'read' },
        widgetStateSource: { messageId: result } });
    entry.turn.messageIds.push(call, result);
    append(exec, { author: { role: 'assistant' }, recipient: 'functions.exec', status: 'finished_successfully' });
    append(call, { author: { role: 'assistant' }, recipient: 'api_tool.call_tool', status: 'finished_successfully',
      content: { text: '{"path":"/Luna Forge X7 Core/' + LINK + '/read","args":{}}' } });
    append(result, { author: { role: 'tool', name: 'api_tool.call_tool' }, recipient: 'all',
      status: 'finished_successfully', content: { content_type: 'code', text: 'PRIVATE_TOOL_RESULT' },
      metadata: { invoked_resource: { app_name: APP, resource_uri: `/${ASDK}/${LINK}/read` } } });
    append(`long-exec-result-${index}`, { author: { role: 'tool', name: 'functions.exec' }, recipient: 'all',
      status: 'finished_successfully' });
  }
  entry.turn.items.push(final);
  entry.turn.messageIds.push(ASSISTANT);
  mapping[ASSISTANT].parent = previous;
  mapping[ASSISTANT].message.metadata = { ...scope, parent_id: previous };
}

/** 156 exact child pairs, either under one exec or directly under the same user. */
function longPairedNativeCompletionPath(mapping: Record<string, any>, entry: any, withExec: boolean) {
  longNativeCompletionPath(mapping, entry);
  const reasoning = entry.turn.items.find((item: any) => item.type === 'chatgpt-reasoning-group');
  entry.turn.items = entry.turn.items.filter((item: any) => item.phase !== 'commentary');
  reasoning.items = reasoning.items.filter((item: any) => item.type !== 'dynamic-tool-call' ||
    (withExec && item.callId === EXEC));
  for (const id of Object.keys(mapping)) {
    if (id.startsWith('long-public-') || id.startsWith('long-exec-') || (!withExec && id === EXEC))
      delete mapping[id];
  }
  let previous = USER;
  const link = (id: string) => {
    mapping[id].parent = previous;
    mapping[id].message.metadata.parent_id = previous;
    previous = id;
  };
  if (withExec) link(EXEC);
  for (let index = 0; index < 156; index++) {
    link(index === 0 ? CALL : `long-call-${index}`);
    link(index === 0 ? RESULT : `long-result-${index}`);
  }
  if (withExec) {
    const id = 'long-final-exec-result';
    mapping[id] = { id, message: { id, author: { role: 'tool', name: 'functions.exec' }, recipient: 'all',
      status: 'finished_successfully', metadata: { request_id: REQUEST, working_turn_id: TURN,
        turn_exchange_id: USER } } };
    link(id);
  } else {
    for (const item of reasoning.items) {
      item.completed = false;
      delete item.widgetStateSource;
    }
  }
  link(ASSISTANT);
  entry.turn.messageIds = entry.turn.messageIds.filter((id: string) => Boolean(mapping[id]));
}

function installFiber(section: Element, options: ShellOptions, entry = shellEntry(options)) {
  const mapping = shellMapping(options);
  if (options.nativeCallReceipt) {
    const scope = { request_id: REQUEST, working_turn_id: TURN, turn_exchange_id: USER };
    mapping[CALL] = { id: CALL, parent: USER, message: {
      id: CALL, author: { role: 'assistant' }, recipient: 'api_tool.call_tool',
      status: 'finished_successfully',
      content: { text: '{"path":"/Luna Forge X7 Core/' + LINK + '/read","args":{}}' },
      metadata: { ...scope, parent_id: USER }
    } };
    Object.assign(mapping[RESULT], { parent: CALL });
    Object.assign(mapping[RESULT].message, {
      author: { role: 'tool', name: 'api_tool.call_tool' }, status: 'finished_successfully',
      metadata: { ...mapping[RESULT].message.metadata, ...scope, parent_id: CALL }
    });
    mapping[ASSISTANT].parent = RESULT;
    options.nativeCallMutation?.(mapping, entry);
  }
  let cachedMapping = mapping;
  if (options.nativeCallCacheConflict || options.nativeAssistantCacheConflict) {
    cachedMapping = { ...mapping };
    if (options.nativeCallCacheConflict) cachedMapping[RESULT] = {
      ...mapping[RESULT],
      message: { ...mapping[RESULT].message,
        metadata: { ...mapping[RESULT].message.metadata, request_id: 'conflicting-cached-request' } }
    };
    if (options.nativeAssistantCacheConflict) cachedMapping[ASSISTANT] = {
      ...mapping[ASSISTANT],
      message: { ...mapping[ASSISTANT].message,
        content: { content_type: 'text', parts: ['conflicting cached answer'] } }
    };
  }
  const owner: any = {
    memoizedProps: {
      ...(options.missingShellEntry ? {} : { entry }),
      ...(options.provisional ? {} : {
        conversationId: options.temporaryLocalConversation ? LOCAL_THREAD : THREAD
      }),
      ...(options.retainedLocalIdentity ? { clientThreadId: 'local-chatgpt:retained-after-commit' } : {}),
      client: queryClient(cachedMapping, options)
    },
    return: null
  };
  if (options.nativeCallReceipt && options.nativeCallLive !== false) owner.memoizedState = { memoizedState: {
    renderedConversation: { mapping, current_node: options.nativeCurrentNode ?? ASSISTANT }, renderedTurns: [entry]
  } };
  if (options.nativeCallLiveConflict) owner.memoizedState.next = { memoizedState: {
    renderedConversation: { mapping, current_node: CALL }, renderedTurns: [entry]
  } };
  if (options.omitFiber) return;
  if (!options.staleFiber) {
    if (options.committedRootDepth) {
      const state: any = { current: null };
      const root: any = { tag: 3, stateNode: state, memoizedProps: { client: owner.memoizedProps.client }, return: null };
      state.current = root;
      delete owner.memoizedProps.client;
      let parent = root;
      for (let depth = 0; depth < options.committedRootDepth; depth++) {
        const wrapper: any = { tag: 0, memoizedProps: {}, return: parent };
        parent.child = wrapper;
        parent = wrapper;
      }
      parent.child = owner;
      owner.return = parent;
      owner.tag = 5;
    }
    let attached = owner;
    for (let depth = 0; depth < (options.shellOwnerDepth ?? 0); depth++) {
      const child: any = { tag: 0, memoizedProps: {}, return: attached };
      attached.child = child;
      attached = child;
    }
    (section as any).__reactFiber$shellfixture = attached;
    return;
  }

  // React's DOM pointer may still reference the previous side of a double-buffered tree.
  // The committed root points at an alternate whose branch no longer owns this exchange.
  const root: any = { current: null };
  const staleRoot: any = { tag: 3, stateNode: root, memoizedProps: {}, return: null, child: owner };
  const currentRoot: any = { tag: 3, stateNode: root, memoizedProps: {}, return: null, child: null };
  staleRoot.alternate = currentRoot;
  currentRoot.alternate = staleRoot;
  owner.tag = 5;
  owner.return = staleRoot;
  const currentLeaf: any = { tag: 5, memoizedProps: { className: 'current-unrelated-branch' }, return: currentRoot };
  owner.alternate = currentLeaf;
  currentLeaf.alternate = owner;
  currentRoot.child = currentLeaf;
  root.current = currentRoot;
  (section as any).__reactFiber$shellfixture = owner;
}

async function shellHarness(options: ShellOptions = {}) {
  const layoutKey = options.layoutKey ?? TURN;
  const primaryEntry = shellEntry(options);
  const assistantIndex = primaryEntry.turn.items.findIndex((item: any) => item.messageId === ASSISTANT);
  const dom = new JSDOM(`<!doctype html><html><body>
    <div ${options.omitShellSelector ? '' : 'data-app-shell-main-surface'}>
      <div data-thread-find-target="conversation">
        <div id="exchange" data-turn-key="${options.domTurnKey ?? TURN}">
          <div data-content-search-turn-key="${layoutKey}"></div>
          ${options.withoutUserSlot ? '' : `<div id="user-slot" data-content-search-unit-key="${layoutKey}:0:user">
            <div data-user-message-bubble><div class="whitespace-pre-wrap">hello shell</div></div>
          </div>`}
          <div data-chatgpt-agent-turn-start></div>
          <div id="assistant-slot" data-content-search-unit-key="${layoutKey}:${assistantIndex}:assistant">
            <div ${options.temporaryLocalConversation ? `data-chatgpt-selection-conversation-id="${LOCAL_THREAD}"` : ''}>
              <div class="markdown" data-markdown-text-style="assistant-message">${options.dilReference ? 'Unable to load answer' : 'hello back'}</div>
            </div>
          </div>
          <div id="cot-v5-row"><span data-testid="cot-v5-tool-icon-pile"></span><span>Called tool</span></div>
          ${options.visualStopText ? '<div>Stop generating</div>' : ''}
        </div>
      </div>
    </div>
    ${options.temporaryLocalConversation ? `<div data-map-composer-conversation="${LOCAL_THREAD}"></div>` : ''}
  </body></html>`, {
    url: `https://chatgpt.com/c/${THREAD}${options.temporaryLocalConversation ? '?temporary-chat=true' : ''}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const win = dom.window as any;
  Object.defineProperty(win.crypto, 'subtle', { value: { digest: async (...args: Parameters<typeof webcrypto.subtle.digest>) => {
    const digest = await webcrypto.subtle.digest(...args); options.nativeDigestSettled?.(); return digest;
  } } });
  win.TextEncoder = TextEncoder;
  if (options.diagnosticLogs) win.console.info = (...args: unknown[]) => options.diagnosticLogs!.push(args.map(String).join(' '));
  const exchange = win.document.getElementById('exchange')!;
  installFiber(exchange, options, primaryEntry);
  let secondExchange: Element | null = null;
  if (options.secondShell) {
    secondExchange = exchange.cloneNode(true) as Element;
    secondExchange.id = 'exchange-2';
    exchange.after(secondExchange);
    const secondEntry = options.secondShell === 'exact' ? primaryEntry : shellEntry(options, {
      ...(options.secondShell === 'foreign-entry' ? { entryId: 'foreign-shell-turn' } : {}),
      ...(options.secondShell === 'foreign-conversation' ? { conversationId: 'f0f00004-1111-4111-8111-222222222222' } : {}),
      ...(options.secondShell === 'foreign-assistant' ? { assistantId: 'f0f00004-1111-4111-8111-333333333333' } : {})
    });
    installFiber(secondExchange, options, secondEntry);
  }
  win.eval(fiberSource);

  const nonce = 'shell-scan';
  const reply = new Promise<Record<string, any>>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error('fiber helper never answered')), 2000);
    win.addEventListener('message', (event: any) => {
      if (event.data?.source !== 'clf-fiber-reply' || event.data?.nonce !== nonce) return;
      globalThis.clearTimeout(timer);
      resolve(event.data);
    });
  });
  win.dispatchEvent(new win.MessageEvent('message', {
    data: { source: 'clf-fiber-ask-v2', nonce, appIds: options.appIds }, source: win
  }));
  const fiber = await reply;
  win.eval(domSource);
  return { dom, win, fiber, api: win.CLF_DOM, exchange, secondExchange };
}

async function shellRescan(page: Awaited<ReturnType<typeof shellHarness>>, nonce: string) {
  const answer = new Promise<any>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error('shell rescan never answered')), 2000);
    const listener = (event: any) => {
      if (event.data?.source !== 'clf-fiber-reply' || event.data?.nonce !== nonce) return;
      page.win.removeEventListener('message', listener);
      globalThis.clearTimeout(timer);
      resolve(event.data);
    };
    page.win.addEventListener('message', listener);
  });
  page.win.dispatchEvent(new page.win.MessageEvent('message', {
    data: { source: 'clf-fiber-ask-v2', nonce }, source: page.win
  }));
  return answer;
}

describe('alternate shell turn/message provenance', () => {
  it.each([
    ['hidden DOM with exact typed user', 'userProjected', null],
    ['typed user absent', 'userTypedMissing', (entry: any) => { entry.turn.items.shift(); }],
    ['typed user has no valid identity', 'userIdentityInvalid', (entry: any) => {
      entry.turn.items[0].messageId = ''; entry.turn.items[0].serverMessageId = '';
    }],
    ['typed user has empty prose', 'userTextEmpty', (entry: any) => { entry.turn.items[0].message = ''; }],
    ['typed user has unsupported body', 'userTextUnsupported', (entry: any) => {
      entry.turn.items[0].message = { privateBody: 'PRIVATE_USER_VALUE' };
    }],
    ['assistant text consumes the existing user budget', 'userBudgetDropped', (entry: any) => {
      entry.turn.items.splice(1, 0, ...[INTERIM, REFERENCE_SOURCE, 'public-budget-assistant'].map(messageId => ({
        type: 'assistant-message', messageId, phase: 'commentary', completed: true, content: 'x'.repeat(256_000)
      })));
    }]
  ] as const)('reports bounded user projection metadata for %s without changing custody', async (_label, reason, mutate) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, withoutUserSlot: true,
      nativeCallMutation(_mapping, entry) { mutate?.(entry); } });
    try {
      expect(Object.fromEntries(USER_PROJECTION_KEYS.map(key => [key, page.fiber.shellScan.rejects[key]])))
        .toEqual({ ...EMPTY_USER_PROJECTION, [reason]: 1 });
      if (reason === 'userIdentityInvalid') {
        expect(page.fiber.turns).toEqual([]);
        expect(page.exchange.hasAttribute('data-clf-fiber-v2-turn')).toBe(false);
      } else {
        expect(page.fiber.turns[0].endMessageId).toBe(ASSISTANT);
        expect(page.fiber.turns[0].calls[0].answered).toBe(true);
        expect(page.fiber.turns[0].messages.filter((message: any) => message.role === 'user'))
          .toHaveLength(reason === 'userProjected' ? 1 : 0);
      }
      const diagnostic = JSON.stringify(page.fiber.shellScan);
      for (const privateValue of [USER, ASSISTANT, THREAD, 'hello shell', 'PRIVATE_USER_VALUE'])
        expect(diagnostic).not.toContain(privateValue);
    } finally { page.dom.window.close(); }
  });

  it('does not reread a typed user accessor while recording user projection metadata', async () => {
    let reads = 0;
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, withoutUserSlot: true,
      nativeCallMutation(_mapping, entry) {
        Object.defineProperty(entry.turn.items[0], 'message', { enumerable: true,
          get() { reads++; if (reads > 1) throw new Error('PRIVATE_USER_ACCESSOR'); return 'hello shell'; } });
      } });
    try {
      expect(reads).toBe(1);
      expect(page.fiber.turns[0].messages).toContainEqual(expect.objectContaining({ role: 'user', rawMessageId: USER }));
      expect(page.fiber.shellScan.rejects.userProjected).toBe(1);
      expect(JSON.stringify(page.fiber.shellScan)).not.toContain('PRIVATE_USER_ACCESSOR');
    } finally { page.dom.window.close(); }
  });

  it('resets user projection metadata per scan and withholds it for a conflicting conversation', async () => {
    const page = await shellHarness({ withoutUserSlot: true });
    try {
      const owner = (page.exchange as any).__reactFiber$shellfixture;
      owner.memoizedProps.entry.turn.items[0].message = '';
      const empty = await shellRescan(page, 'user-projection-empty');
      expect(empty.shellScan.rejects.userTextEmpty).toBe(1);
      expect(empty.shellScan.rejects.userProjected).toBe(0);
      owner.memoizedProps.entry.turn.items[0].message = 'hello shell';
      const current = await shellRescan(page, 'user-projection-current');
      expect(Object.fromEntries(USER_PROJECTION_KEYS.map(key => [key, current.shellScan.rejects[key]])))
        .toEqual({ ...EMPTY_USER_PROJECTION, userProjected: 1 });
      owner.memoizedProps.clientThreadId = '11111111-2222-4333-8444-555555555555';
      const foreign = await shellRescan(page, 'user-projection-foreign');
      expect(Object.fromEntries(USER_PROJECTION_KEYS.map(key => [key, foreign.shellScan.rejects[key]])))
        .toEqual(EMPTY_USER_PROJECTION);
      expect(foreign.turns[0].conversationConflict).toBe(true);
    } finally { page.dom.window.close(); }
  });

  it('caps repeated valid user projection observations at 400 without changing authored messages', async () => {
    const page = await shellHarness();
    try {
      for (let at = 0; at < 6; at++) {
        const section = at === 0 ? page.exchange : page.exchange.cloneNode(true) as Element;
        if (at > 0) page.exchange.parentElement!.append(section);
        const entry = shellEntry({});
        entry.id = `${TURN}-${at}`;
        section.setAttribute('data-turn-key', entry.id);
        entry.turn.items = [
          ...Array.from({ length: 399 }, (_, index) => ({ type: 'user-message',
            messageId: `public-user-${at}-${index}`, serverMessageId: `public-user-${at}-${index}`, message: 'x' })),
          entry.turn.items[1]
        ];
        installFiber(section, {}, entry);
      }
      const bounded = await shellRescan(page, 'user-projection-bounded');
      expect(bounded.shellScan.rejects.userProjected).toBe(400);
      expect(bounded.turns).toHaveLength(6);
      expect(bounded.turns.every((turn: any) => turn.messages.filter((message: any) => message.role === 'user').length === 399))
        .toBe(true);
      expect(Object.values(bounded.shellScan.rejects).every(value => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 400))
        .toBe(true);
    } finally { page.dom.window.close(); }
  });

  it.each([
    [String.raw`\[\[COS\_GOAL:COMPLETE\]\]`, '[[COS_GOAL:COMPLETE]]'],
    [String.raw`{"action":"continue","reply":"Recompute 2\^300"}`, '{"action":"continue","reply":"Recompute 2^300"}'],
    ['```python\nx = a[0] # \\[\n```\n`C:\\Users\\[x]` and \\_after\\_', '```python\nx = a[0] # \\[\n```\n`C:\\Users\\[x]` and _after_']
  ])('decodes provider fallback text while preserving code: %s', async (dilMarkdown, expected) => {
    const page = await shellHarness({ dilReference: 'exact', dilMarkdown });
    try {
      expect(page.fiber.turns[0].messages.find((message: any) => message.role === 'assistant')?.rawText).toBe(expected);
    } finally { page.dom.window.close(); }
  });
  it('does not treat available DIL text as proof a streaming answer finished', async () => {
    const page = await shellHarness({ dilReference: 'exact', status: 'in_progress' });
    try {
      expect(page.api.generating()).toBe(true);
      expect(page.exchange.getAttribute('data-clf-shell-running-v2')).toBe(`/c/${THREAD}`);
      expect(page.fiber.turns[0].messages.find((message: any) => message.role === 'assistant')?.rawText)
        .toBe('{"action":"continue","reply":"Continue the verified work."}');
    } finally { page.dom.window.close(); }
  });

  it.each(['plain', 'dil'] as const)('records public nested %s GPT-6 interim prose without ending a running turn', async nestedInterim => {
    const page = await shellHarness({ nestedInterim, status: 'in_progress' });
    try {
      expect(page.fiber.turns[0].messages.filter((message: any) => message.rawMessageId === INTERIM))
        .toEqual([expect.objectContaining({ rawText: 'Now editing `a.txt`.' })]);
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(page.api.generating()).toBe(true);
    } finally { page.dom.window.close(); }
  });

  it('does not let completed nested final-phase prose replace the exact top-level answer', async () => {
    const page = await shellHarness({ nestedInterim: 'dil', status: 'complete' });
    try {
      expect(page.fiber.turns[0].messages.filter((message: any) => message.rawMessageId === INTERIM)).toHaveLength(1);
      expect(page.fiber.turns[0].endMessageId).toBe(ASSISTANT);
    } finally { page.dom.window.close(); }
  });

  it('reads an interim message hoisted to the top level once, not its nested copies', async () => {
    const page = await shellHarness({ nestedInterim: 'hoisted' });
    try {
      expect(page.fiber.turns[0].messages.filter((message: any) => message.rawMessageId === INTERIM)).toHaveLength(1);
      expect(page.fiber.turns[0].endMessageId).toBe(ASSISTANT);
    } finally { page.dom.window.close(); }
  });

  it.each(['analysis', 'foreign'] as const)('does not expose %s nested prose as public progress', async nestedInterim => {
    const page = await shellHarness({ nestedInterim });
    try {
      expect(page.fiber.turns[0].messages.some((message: any) => message.rawMessageId === INTERIM)).toBe(false);
    } finally { page.dom.window.close(); }
  });

  it('reads the exact GPT-6 self-referenced DIL answer rather than a rendered load-error placeholder', async () => {
    const page = await shellHarness({ dilReference: 'exact' });
    try {
      expect(page.fiber.turns[0].messages.find((message: any) => message.role === 'assistant')).toMatchObject({
        rawMessageId: ASSISTANT,
        rawText: '{"action":"continue","reply":"Continue the verified work."}'
      });
    } finally { page.dom.window.close(); }
  });

  it.each(['foreign', 'duplicate', 'oversized'] as const)('does not substitute a %s DIL source', async dilReference => {
    const page = await shellHarness({ dilReference });
    try {
      expect(page.fiber.turns[0].messages.find((message: any) => message.role === 'assistant')?.rawText)
        .toBe(`::chatgpt-content-reference{index="0" source_message_id="${ASSISTANT}"}`);
    } finally { page.dom.window.close(); }
  });

  it('reads a committed turn and its query client more than 400 levels below the root (#969)', async () => {
    const page = await shellHarness({ committedRootDepth: 450, contentReference: 'public' });
    try {
      expect(page.fiber.turns).toHaveLength(1);
      expect(page.fiber.turns[0].messages.find((message: any) => message.role === 'assistant')).toEqual(
        expect.objectContaining({ rawMessageId: ASSISTANT, rawText: '{"action":"continue","reply":"Keep qualifying the production pilot."}' })
      );
    } finally { page.dom.window.close(); }
  });

  it('still refuses an unbounded committed-root walk', async () => {
    const page = await shellHarness({ committedRootDepth: 2100 });
    try { expect(page.fiber.turns).toEqual([]); }
    finally { page.dom.window.close(); }
  });

  it('normalizes one shell exchange into exact user and assistant authored turns', async () => {
    const page = await shellHarness();
    try {
      expect(page.fiber.turns).toHaveLength(1);
      const turns = page.api.turns();
      expect(turns.map((turn: any) => ({ id: turn.id, role: turn.role }))).toEqual([
        { id: TURN, role: 'user' },
        { id: TURN, role: 'assistant' }
      ]);
      expect(page.api.messages().map((message: any) => ({ id: message.id, role: message.role, text: message.text }))).toEqual([
        { id: USER, role: 'user', text: 'hello shell' },
        { id: ASSISTANT, role: 'assistant', text: 'hello back' }
      ]);
      expect(page.win.document.getElementById('user-slot')?.getAttribute('data-clf-fiber-v2-message')).toContain(encodeURIComponent(USER));
      expect(page.win.document.getElementById('assistant-slot')?.getAttribute('data-clf-fiber-v2-message')).toContain(encodeURIComponent(ASSISTANT));
      expect(page.api.firstUserMessage()).toBe(page.win.document.getElementById('user-slot'));
      expect(page.api.turnContainer(page.win.document.getElementById('cot-v5-row'))).toBe(page.exchange);
      expect(page.api.turnMutationRelevant(page.win.document.getElementById('cot-v5-row'))).toBe(true);
    } finally {
      page.dom.window.close();
    }
  });

  it('resolves an exact public content reference from the current shell conversation mapping', async () => {
    const page = await shellHarness({ contentReference: 'public' });
    try {
      expect(page.fiber.turns[0].messages.find((message: any) => message.role === 'assistant')).toEqual(
        expect.objectContaining({
          rawMessageId: ASSISTANT,
          rawText: '{"action":"continue","reply":"Keep qualifying the production pilot."}'
        })
      );
    } finally {
      page.dom.window.close();
    }
  });

  it('resolves a public reference from the exact object-keyed conversation cache when final channel is omitted', async () => {
    const page = await shellHarness({
      contentReference: 'public',
      objectConversationQuery: true,
      omitPublicReferenceChannel: true
    });
    try {
      expect(page.fiber.turns[0].messages.find((message: any) => message.role === 'assistant')).toEqual(
        expect.objectContaining({
          rawMessageId: ASSISTANT,
          rawText: '{"action":"continue","reply":"Keep qualifying the production pilot."}'
        })
      );
    } finally {
      page.dom.window.close();
    }
  });

  it('resolves a temporary helper reference when the shell retains one exact local conversation id', async () => {
    const page = await shellHarness({
      contentReference: 'public',
      objectConversationQuery: true,
      omitPublicReferenceChannel: true,
      temporaryLocalConversation: true
    });
    try {
      expect(page.fiber.turns[0]).toMatchObject({
        conversationId: THREAD,
        conversationConflict: false
      });
      expect(page.fiber.turns[0].messages.find((message: any) => message.role === 'assistant')).toEqual(
        expect.objectContaining({
          rawMessageId: ASSISTANT,
          rawText: '{"action":"continue","reply":"Keep qualifying the production pilot."}'
        })
      );
    } finally {
      page.dom.window.close();
    }
  });

  it('does not expose a referenced shell analysis message', async () => {
    const page = await shellHarness({ contentReference: 'analysis' });
    try {
      expect(page.fiber.turns[0].messages.find((message: any) => message.role === 'assistant')).toEqual(
        expect.objectContaining({
          rawMessageId: ASSISTANT,
          rawText: `::chatgpt-content-reference{index="0" source_message_id="${REFERENCE_SOURCE}"}`
        })
      );
      expect(JSON.stringify(page.fiber)).not.toContain('private reasoning');
    } finally {
      page.dom.window.close();
    }
  });

  it('harvests dynamic functions.exec request identity from the exact shell call id even when it is absent from messageIds', async () => {
    const page = await shellHarness({ withExec: true });
    try {
      expect(page.fiber.turns[0].requests).toContainEqual(expect.objectContaining({
        requestId: EXEC_REQUEST,
        messageId: EXEC
      }));
    } finally {
      page.dom.window.close();
    }
  });

  it('answers an omitted shell completion flag only from its exact finished current-branch native result', async () => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: 'missing' });
    try {
      expect(page.fiber.turns[0]).toMatchObject({
        conversationId: THREAD,
        calls: [{ messageId: CALL, tool: 'read', answered: true, requestId: REQUEST }]
      });
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it('proves a 628-node current native branch without mistaking the public-item bound for ancestry depth', async () => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        longNativeCompletionPath(mapping, entry);
        expect(Object.keys(mapping)).toHaveLength(628);
      } });
    try {
      expect(page.fiber.turns[0].calls).toHaveLength(156);
      expect(page.fiber.turns[0].calls.every((call: any) => call.answered === true)).toBe(true);
      expect(page.fiber.turns[0].endMessageId).toBe(ASSISTANT);
      expect(page.fiber.shellScan.rejects.assistantTerminalReceiptMatched).toBe(1);
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it('proves one enclosing Code Mode receipt across 156 exact child pairs without a call-count node-depth cutoff', async () => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        longPairedNativeCompletionPath(mapping, entry, true);
        expect(Object.keys(mapping)).toHaveLength(316);
      } });
    try {
      expect(page.fiber.turns[0].calls).toHaveLength(156);
      expect(page.fiber.turns[0].calls.every((call: any) => call.answered === true)).toBe(true);
      expect(page.fiber.turns[0].endMessageId).toBe(ASSISTANT);
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it('recovers identity through 156 exact prior pairs without treating that identity as completion', async () => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        longPairedNativeCompletionPath(mapping, entry, false);
        expect(Object.keys(mapping)).toHaveLength(314);
      } });
    try {
      expect(page.fiber.turns[0].calls).toHaveLength(156);
      expect(page.fiber.turns[0].calls.at(-1)).toMatchObject({ messageId: 'long-call-155', requestId: REQUEST });
      expect(page.fiber.turns[0].calls.every((call: any) => call.answered === false)).toBe(true);
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it.each(['foreign-scope', 'foreign-resource', 'approval-wrapper', 'cycle'] as const)(
    'refuses long prior-pair identity for %s without changing completion', async reason => {
      const page = await shellHarness({ withCall: true, nativeCallReceipt: true, assistantCompleted: false,
        nativeCallMutation(mapping, entry) {
          longPairedNativeCompletionPath(mapping, entry, false);
          const result = mapping['long-result-80'];
          if (reason === 'foreign-scope') result.message.metadata.turn_exchange_id = 'foreign-user';
          if (reason === 'foreign-resource') result.message.metadata.invoked_resource.app_name = 'Foreign Core';
          if (reason === 'approval-wrapper') {
            result.message.recipient = 'assistant';
            result.message.metadata.jit_plugin_data = {};
          }
          if (reason === 'cycle') {
            result.parent = 'long-call-155';
            result.message.metadata.parent_id = result.parent;
          }
        } });
      try {
        expect(page.fiber.turns[0].calls.at(-1).requestId).toBeNull();
        expect(page.fiber.turns[0].calls.every((call: any) => call.answered === false)).toBe(true);
        expect(page.fiber.turns[0].endMessageId).toBeNull();
      } finally { page.dom.window.close(); }
    }
  );

  it.each(['pending-exec', 'foreign-scope', 'explicit-false', 'missing-widget', 'approval-wrapper'] as const)(
    'refuses long enclosing Code Mode completion for %s', async reason => {
      const page = await shellHarness({ withCall: true, nativeCallReceipt: true, assistantCompleted: false,
        nativeCallMutation(mapping, entry) {
          longPairedNativeCompletionPath(mapping, entry, true);
          const first = entry.turn.items.find((item: any) => item.type === 'chatgpt-reasoning-group').items
            .find((item: any) => item.type === 'mcp-tool-call');
          if (reason === 'pending-exec') mapping['long-final-exec-result'].message.status = 'in_progress';
          if (reason === 'foreign-scope') mapping['long-result-80'].message.metadata.turn_exchange_id = 'foreign-user';
          if (reason === 'explicit-false') first.completed = false;
          if (reason === 'missing-widget') delete first.widgetStateSource;
          if (reason === 'approval-wrapper') {
            mapping[RESULT].message.recipient = 'assistant';
            mapping[RESULT].message.metadata.jit_plugin_data = {};
          }
        } });
      try {
        expect(page.fiber.turns[0].calls[0].answered).toBe(false);
        expect(page.fiber.turns[0].endMessageId).toBeNull();
      } finally { page.dom.window.close(); }
    }
  );

  it.each([1200, 1201])('keeps current native ancestry bounded at %s nodes', async nodes => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        longNativeCompletionPath(mapping, entry);
        let parent = mapping[ASSISTANT].parent;
        for (let index = 0; index < nodes - 628; index++) {
          const id = `bounded-intermediate-${index}`;
          mapping[id] = { id, parent, message: { id, author: { role: 'assistant' } } };
          parent = id;
        }
        mapping[ASSISTANT].parent = parent;
      } });
    try {
      expect(page.fiber.turns[0].calls.every((call: any) => call.answered === true)).toBe(nodes === 1200);
      expect(page.fiber.turns[0].endMessageId).toBe(nodes === 1200 ? ASSISTANT : null);
    } finally { page.dom.window.close(); }
  });

  it.each(['overflow', 'cycle', 'foreign-user', 'ambiguous-mounted', 'conflicting-cache',
    'explicit-false', 'missing-widget', 'approval-wrapper'] as const)(
    'keeps long native completion unverified for %s', async reason => {
      const page = await shellHarness({ withCall: true, nativeCallReceipt: true, assistantCompleted: false,
        nativeCallLiveConflict: reason === 'ambiguous-mounted', nativeCallCacheConflict: reason === 'conflicting-cache',
        nativeCallMutation(mapping, entry) {
          longNativeCompletionPath(mapping, entry);
          const first = entry.turn.items.find((item: any) => item.type === 'chatgpt-reasoning-group').items
            .find((item: any) => item.type === 'mcp-tool-call');
          if (reason === 'explicit-false') first.completed = false;
          if (reason === 'missing-widget') delete first.widgetStateSource;
          if (reason === 'approval-wrapper') {
            Object.assign(mapping[RESULT].message, { recipient: 'assistant', end_turn: true,
              content: { content_type: 'text', parts: ['PRIVATE_APPROVAL_WRAPPER'] } });
            delete mapping[RESULT].message.metadata.invoked_resource;
            mapping[RESULT].message.metadata.jit_plugin_data = {};
          }
          if (reason === 'cycle') mapping[EXEC].parent = ASSISTANT;
          if (reason === 'foreign-user') {
            mapping.foreign = { id: 'foreign', message: { id: 'foreign', author: { role: 'user' } } };
            mapping['long-public-0'].parent = 'foreign';
          }
          if (reason === 'overflow') {
            let parent = mapping[ASSISTANT].parent;
            // More than 400 public items + 200 invocation/result pairs of each supported kind.
            for (let index = 0; index < 1200; index++) {
              const id = `overflow-${index}`;
              mapping[id] = { id, parent, message: { id, author: { role: 'assistant' } } };
              parent = id;
            }
            mapping[ASSISTANT].parent = parent;
          }
        } });
      try {
        expect(page.fiber.turns[0].calls[0].answered).toBe(false);
        expect(page.fiber.turns[0].endMessageId).toBeNull();
        expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
        expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_APPROVAL_WRAPPER');
      } finally { page.dom.window.close(); }
    }
  );

  it('accepts an exact current provider terminal receipt only after every Core and Code Mode call is answered', async () => {
    const page = await shellHarness({
      assistantCompleted: false,
      withCall: true,
      withExec: true,
      nativeCallReceipt: true,
      callCompleted: 'missing',
      nativeCallMutation: completeExecBeforeCall
    });
    try {
      expect(page.fiber.turns[0]).toMatchObject({
        endMessageId: ASSISTANT,
        calls: [{ messageId: CALL, answered: true }]
      });
      expect(page.fiber.shellScan.rejects).toMatchObject({
        assistantTerminalReceiptChecked: 1,
        assistantTerminalReceiptMatched: 1
      });
      const diagnostic = JSON.stringify(page.fiber.shellScan);
      for (const privateValue of [USER, ASSISTANT, CALL, RESULT, EXEC, EXEC_RESULT, REQUEST, 'hello back'])
        expect(diagnostic).not.toContain(privateValue);
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['pending provider status', (mapping: any) => { mapping[ASSISTANT].message.status = 'in_progress'; }],
    ['missing provider end marker', (mapping: any) => { mapping[ASSISTANT].message.end_turn = false; }],
    ['different provider prose', (mapping: any) => { mapping[ASSISTANT].message.content.parts = ['different answer']; }],
    ['non-public provider routing', (mapping: any) => { mapping[ASSISTANT].message.recipient = 'functions.exec'; }],
    ['wrong provider assistant identity', (mapping: any) => { mapping[ASSISTANT].message.id = REFERENCE_SOURCE; }]
  ] as const)('keeps an explicit typed completion veto for %s', async (_label, mutate) => {
    const page = await shellHarness({
      assistantCompleted: false,
      withCall: true,
      withExec: true,
      nativeCallReceipt: true,
      callCompleted: 'missing',
      nativeCallMutation(mapping, entry) {
        completeExecBeforeCall(mapping, entry);
        mutate(mapping);
      }
    });
    try {
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(page.fiber.shellScan.rejects).toMatchObject({
        assistantTerminalReceiptChecked: 1,
        assistantTerminalReceiptMatched: 0
      });
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['a conflicting live branch', { nativeCallLiveConflict: true }],
    ['a conflicting cached assistant record', { nativeAssistantCacheConflict: true }],
    ['no current live mapping', { nativeCallLive: false }]
  ] as const)('keeps an explicit typed completion veto with %s', async (_label, extra) => {
    const page = await shellHarness({
      assistantCompleted: false,
      withCall: true,
      withExec: true,
      nativeCallReceipt: true,
      callCompleted: 'missing',
      nativeCallMutation: completeExecBeforeCall,
      ...extra
    });
    try {
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(page.fiber.shellScan.rejects.assistantTerminalReceiptMatched).toBe(0);
    } finally { page.dom.window.close(); }
  });

  it('does not reuse an older provider terminal when the current branch has a newer assistant', async () => {
    const page = await shellHarness({
      assistantCompleted: false,
      withCall: true,
      withExec: true,
      nativeCallReceipt: true,
      nativeCurrentNode: REFERENCE_SOURCE,
      callCompleted: 'missing',
      nativeCallMutation(mapping, entry) {
        completeExecBeforeCall(mapping, entry);
        mapping[REFERENCE_SOURCE] = {
          id: REFERENCE_SOURCE,
          parent: ASSISTANT,
          message: {
            id: REFERENCE_SOURCE,
            author: { role: 'assistant' },
            recipient: 'all',
            channel: 'final',
            status: 'in_progress',
            end_turn: false,
            content: { content_type: 'text', parts: ['newer retry'] }
          }
        };
      }
    });
    try {
      expect(page.fiber.turns[0].calls[0].answered).toBe(true);
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(page.fiber.shellScan.rejects).toMatchObject({
        assistantTerminalReceiptChecked: 1,
        assistantTerminalReceiptMatched: 0
      });
    } finally { page.dom.window.close(); }
  });

  it('does not evaluate provider status accessors while checking the optional terminal receipt', async () => {
    let reads = 0;
    const page = await shellHarness({
      assistantCompleted: false,
      withCall: true,
      withExec: true,
      nativeCallReceipt: true,
      callCompleted: 'missing',
      nativeCallMutation(mapping, entry) {
        completeExecBeforeCall(mapping, entry);
        Object.defineProperty(mapping[ASSISTANT].message, 'status', {
          enumerable: true,
          get() { reads++; return 'finished_successfully'; }
        });
      }
    });
    try {
      expect(reads).toBe(0);
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(page.fiber.shellScan.rejects.assistantTerminalReceiptMatched).toBe(0);
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['an explicit unfinished Core call', false, (mapping: any, entry: any) => completeExecBeforeCall(mapping, entry)],
    ['an unresolved enclosing Code Mode call', 'missing', (mapping: any, entry: any) => {
      const scope = { request_id: EXEC_REQUEST, working_turn_id: TURN, turn_exchange_id: USER };
      Object.assign(mapping[EXEC], { parent: USER });
      Object.assign(mapping[EXEC].message, { status: 'finished_successfully', metadata: { ...scope, parent_id: USER } });
      mapping[CALL].parent = EXEC;
      mapping[CALL].message.metadata.parent_id = EXEC;
      entry.turn.messageIds = [USER, EXEC, CALL, RESULT, ASSISTANT];
    }]
  ] as const)('does not end on a provider receipt with %s', async (_label, callCompleted, nativeCallMutation) => {
    const page = await shellHarness({
      assistantCompleted: false,
      withCall: true,
      withExec: true,
      nativeCallReceipt: true,
      callCompleted,
      nativeCallMutation
    });
    try {
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
      expect(page.fiber.shellScan.rejects.assistantTerminalReceiptChecked).toBe(1);
      expect(page.fiber.shellScan.rejects.assistantTerminalReceiptMatched).toBe(0);
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['callCompletionVeto', { callCompleted: false }],
    ['callLiveMappingMissing', { nativeCallLive: false }],
    ['callLiveMappingConflict', { nativeCallLiveConflict: true }],
    ['callPathMissing', { nativeCallMutation(mapping: any) { mapping[ASSISTANT].parent = USER; } }],
    ['callReceiptMissing', { nativeCallMutation(_mapping: any, entry: any) {
      delete entry.turn.items[1].widgetStateSource;
    } }],
    ['callReceiptConflict', { nativeCallCacheConflict: true }],
    ['callNativePending', { nativeCallMutation(mapping: any) { mapping[RESULT].message.status = 'in_progress'; } }],
    ['callScopeConflict', { nativeCallMutation(mapping: any) {
      mapping[RESULT].message.metadata.invoked_resource.resource_uri = `/${ASDK}/link_99999999222233334444555555555555/read`;
    } }],
    ['callExecUnresolved', { withExec: true, nativeCallMutation(mapping: any, entry: any) {
      const scope = { request_id: REQUEST, working_turn_id: TURN, turn_exchange_id: USER };
      Object.assign(mapping[EXEC], { parent: USER });
      Object.assign(mapping[EXEC].message, { status: 'finished_successfully', metadata: { ...scope, parent_id: USER } });
      mapping[CALL].parent = EXEC;
      mapping[CALL].message.metadata.parent_id = EXEC;
      entry.turn.messageIds = [USER, EXEC, CALL, RESULT, ASSISTANT];
    } }]
  ] as const)('reports one shape-only shell completion refusal: %s', async (reason, options) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: 'missing', ...options });
    try {
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
      expect(Object.fromEntries(CALL_REJECT_KEYS.map(key => [key, page.fiber.shellScan.rejects[key]])))
        .toEqual({ ...EMPTY_CALL_REJECTS, [reason]: 1 });
      const diagnostic = JSON.stringify(page.fiber.shellScan);
      for (const privateValue of [USER, CALL, RESULT, REQUEST, APP, LINK, 'PRIVATE_TOOL_RESULT', 'hello shell'])
        expect(diagnostic).not.toContain(privateValue);
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['callLiveMappingConflict', { nativeCallLiveConflict: true }],
    ['callReceiptConflict', { nativeCallCacheConflict: true }]
  ] as const)('keeps the upstream %s visible beside an explicit completion veto', async (reason, options) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false, ...options });
    try {
      for (const view of [page.fiber, await shellRescan(page, 'upstream-veto-reobserve')]) {
        expect(view.turns[0].calls[0].answered).toBe(false);
        expect(view.turns[0].calls[0].requestId).toBeNull();
        expect(view.shellScan.rejects.callCompletionVeto).toBe(1);
        expect(view.shellScan.rejects[reason]).toBe(1);
        for (const privateValue of [USER, CALL, RESULT, REQUEST, APP, LINK])
          expect(JSON.stringify(view.shellScan)).not.toContain(privateValue);
      }
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['false', 'callCompletedFalse', false, false],
    ['undefined', 'callCompletedUndefined', undefined, false],
    ['null', 'callCompletedNull', null, false],
    ['malformed string', 'callCompletedMalformed', 'PRIVATE_COMPLETION_VALUE', false],
    ['malformed object', 'callCompletedMalformed', { private: 'PRIVATE_COMPLETION_VALUE' }, false],
    ['pending status', 'callStatusVeto', 'in_progress', true],
    ['error status', 'callStatusVeto', 'error', true],
    ['undefined status', 'callStatusVeto', undefined, true],
    ['null status', 'callStatusVeto', null, true]
  ] as const)('splits only bounded completion veto shape for %s without overriding a receipt', async (_label, reason, value, statusOnly) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: 'missing',
      nativeCallMutation(_mapping, entry) {
        entry.turn.items[1][statusOnly ? 'status' : 'completed'] = value;
      } });
    try {
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
      expect(page.fiber.shellScan.rejects.callCompletionVeto).toBe(1);
      expect(Object.fromEntries(COMPLETION_VETO_SHAPES.map(key => [key, page.fiber.shellScan.rejects[key]])))
        .toEqual({ ...EMPTY_COMPLETION_VETO_SHAPES, [reason]: 1 });
      const status = !statusOnly ? 'callVetoStatusAbsent' : value === 'in_progress' ? 'callVetoStatusPending'
        : value === 'error' ? 'callVetoStatusError' : 'callVetoStatusUnknown';
      expect(Object.fromEntries(COMPLETION_VETO_STATUSES.map(key => [key, page.fiber.shellScan.rejects[key]])))
        .toEqual({ ...EMPTY_COMPLETION_VETO_STATUSES, [status]: 1 });
      expect(JSON.stringify(page.fiber.shellScan)).not.toContain('PRIVATE_COMPLETION_VALUE');
      expect(JSON.stringify(page.fiber.shellScan)).not.toContain(CALL);
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['pending', 'callVetoStatusPending'], ['running', 'callVetoStatusPending'],
    ['done', 'callVetoStatusDone'], ['final', 'callVetoStatusFinal'],
    ['completed', 'callVetoStatusCompleted'], ['complete', 'callVetoStatusComplete'],
    ['finished', 'callVetoStatusFinished'], ['finished_successfully', 'callVetoStatusFinishedSuccessfully'],
    ['PRIVATE_STATUS_VALUE', 'callVetoStatusUnknown']
  ] as const)('retains an explicit false completion while classifying bounded status %s', async (status, reason) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false, assistantCompleted: false,
      nativeCallMutation(_mapping, entry) { entry.turn.items[1].status = status; } });
    try {
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
      expect(page.fiber.shellScan.rejects.callCompletionVeto).toBe(1);
      expect(page.fiber.shellScan.rejects.callCompletedFalse).toBe(1);
      expect(Object.fromEntries(COMPLETION_VETO_STATUSES.map(key => [key, page.fiber.shellScan.rejects[key]])))
        .toEqual({ ...EMPTY_COMPLETION_VETO_STATUSES, [reason]: 1 });
      expect(JSON.stringify(page.fiber.shellScan)).not.toContain('PRIVATE_STATUS_VALUE');
    } finally { page.dom.window.close(); }
  });

  it.each([false, true])('never executes completion/status accessors or treats their values as proof (%s)', async completed => {
    let completionReads = 0, statusReads = 0;
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false,
      nativeCallMutation(_mapping, entry) {
        Object.defineProperty(entry.turn.items[1], 'completed', { enumerable: true,
          get() { completionReads++; return completed; } });
        Object.defineProperty(entry.turn.items[1], 'status', { enumerable: true,
          get() { statusReads++; throw new Error('PRIVATE_STATUS_VALUE'); } });
      } });
    try {
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
      expect(completionReads).toBe(0);
      expect(statusReads).toBe(0);
      expect(page.fiber.shellScan.rejects.callCompletedMalformed).toBe(1);
      expect(page.fiber.shellScan.rejects.callVetoStatusUnknown).toBe(1);
      expect(JSON.stringify(page.fiber.shellScan)).not.toContain('PRIVATE_STATUS_VALUE');
    } finally { page.dom.window.close(); }
  });

  it('does not let an optional diagnostic descriptor failure discard an authoritative veto', async () => {
    let completionDescriptors = 0;
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false,
      nativeCallMutation(_mapping, entry) {
        entry.turn.items[1] = new Proxy(entry.turn.items[1], {
          getOwnPropertyDescriptor(target, key) {
            if (key === 'completed' && ++completionDescriptors > 1) throw new Error('PRIVATE_DESCRIPTOR_VALUE');
            return Reflect.getOwnPropertyDescriptor(target, key);
          }
        });
      } });
    try {
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
      expect(completionDescriptors).toBe(2);
      expect(page.fiber.shellScan.rejects.callCompletionVeto).toBe(1);
      expect(page.fiber.shellScan.rejects.callCompletedMalformed).toBe(1);
      expect(page.fiber.shellScan.rejects.callVetoStatusUnknown).toBe(1);
      expect(JSON.stringify(page.fiber.shellScan)).not.toContain('PRIVATE_DESCRIPTOR_VALUE');
    } finally { page.dom.window.close(); }
  });

  it('reports zero shell completion refusals for exact accepted proof without ending a live generation', async () => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: 'missing', status: 'in_progress' });
    try {
      expect(page.fiber.turns[0].calls[0].answered).toBe(true);
      expect(page.api.generating()).toBe(true);
      expect(Object.fromEntries(CALL_REJECT_KEYS.map(key => [key, page.fiber.shellScan.rejects[key]])))
        .toEqual(EMPTY_CALL_REJECTS);
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['invalid explicit completion', 'callCompletionVeto', (mapping: any, entry: any) => {
      entry.turn.items[1].completed = undefined;
      mapping[RESULT].message.status = 'in_progress';
    }],
    ['typed pending status', 'callCompletionVeto', (_mapping: any, entry: any) => { entry.turn.items[1].status = 'in_progress'; }],
    ['shared widget result', 'callReceiptConflict', (mapping: any, entry: any) => {
      entry.turn.items.splice(2, 0, { ...entry.turn.items[1], callId: EXEC });
      mapping[EXEC] = { ...mapping[CALL], id: EXEC, message: { ...mapping[CALL].message, id: EXEC } };
    }],
    ['wrong request scope', 'callScopeConflict', (mapping: any) => { mapping[RESULT].message.metadata.request_id = 'foreign-request'; }],
    ['foreign result role', 'callReceiptConflict', (mapping: any) => { mapping[RESULT].message.author.role = 'assistant'; }],
    ['unselected widget', 'callReceiptMissing', (_mapping: any, entry: any) => { entry.turn.messageIds = [USER, CALL, ASSISTANT]; }]
  ] as const)('classifies only the first existing refusal gate for %s', async (label, reason, nativeCallMutation) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: 'missing', nativeCallMutation });
    try {
      const expected = label === 'shared widget result' ? 2 : 1;
      expect(Object.fromEntries(CALL_REJECT_KEYS.map(key => [key, page.fiber.shellScan.rejects[key]])))
        .toEqual({ ...EMPTY_CALL_REJECTS, [reason]: expected });
      expect(page.fiber.turns[0].calls.every((call: any) => call.answered === false)).toBe(true);
    } finally { page.dom.window.close(); }
  });

  it('resets shape-only shell completion refusals on every descriptor scan', async () => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false });
    try {
      const again = await shellRescan(page, 'diagnostic-again');
      expect(again.shellScan.rejects.callCompletionVeto).toBe(1);
      (page.exchange as any).__reactFiber$shellfixture.memoizedProps.entry.turn.items[1].completed = true;
      const current = await shellRescan(page, 'diagnostic-current');
      expect(Object.fromEntries(CALL_REJECT_KEYS.map(key => [key, current.shellScan.rejects[key]])))
        .toEqual(EMPTY_CALL_REJECTS);
      expect(Object.fromEntries(COMPLETION_VETO_SHAPES.map(key => [key, current.shellScan.rejects[key]])))
        .toEqual(EMPTY_COMPLETION_VETO_SHAPES);
      expect(Object.fromEntries(COMPLETION_VETO_STATUSES.map(key => [key, current.shellScan.rejects[key]])))
        .toEqual(EMPTY_COMPLETION_VETO_STATUSES);
      expect(current.turns[0].calls[0].answered).toBe(true);
    } finally { page.dom.window.close(); }
  });

  it('bounds shape-only shell completion refusals across current descriptor turns', async () => {
    const options: ShellOptions = { withCall: true, nativeCallReceipt: true, callCompleted: false,
      nativeCallMutation(_mapping, entry) {
        const call = entry.turn.items[1];
        entry.turn.items.splice(1, 1, ...Array.from({ length: 180 }, (_, index) => ({ ...call, callId: `${CALL}_${index}` })));
      } };
    const page = await shellHarness(options);
    try {
      for (let index = 1; index < 6; index++) {
        const section = page.exchange.cloneNode(true) as Element;
        const entry = shellEntry(options, { entryId: `${TURN}_${index}` });
        section.setAttribute('data-turn-key', entry.id);
        page.exchange.parentElement!.append(section);
        installFiber(section, options, entry);
      }
      const current = await shellRescan(page, 'diagnostic-bounded');
      expect(current.turns).toHaveLength(6);
      expect(current.shellScan.rejects.callCompletionVeto).toBe(400);
      expect(current.shellScan.rejects.callCompletedFalse).toBe(400);
      expect(current.shellScan.rejects.callVetoStatusAbsent).toBe(400);
      expect(current.shellScan.rejects.callJoinReferenceConflict).toBe(400);
      expect(Object.values(current.shellScan.rejects).every(value => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 400))
        .toBe(true);
      for (const section of page.exchange.parentElement!.querySelectorAll('[data-turn-key]')) {
        const entry = (section as any).__reactFiber$shellfixture.memoizedProps.entry;
        let index = 0;
        for (const item of entry.turn.items) if (item.type === 'mcp-tool-call') {
          item.completed = [false, undefined, null][index % 3];
          item.status = index++ % 2 ? 'finished' : 'pending';
        }
      }
      const mixed = await shellRescan(page, 'diagnostic-mixed-bounded');
      expect(mixed.shellScan.rejects.callCompletionVeto).toBe(400);
      expect(mixed.shellScan.rejects.callJoinReferenceConflict).toBe(400);
      expect(COMPLETION_VETO_SHAPES.reduce((total, key) => total + mixed.shellScan.rejects[key], 0)).toBe(400);
      expect(COMPLETION_VETO_STATUSES.reduce((total, key) => total + mixed.shellScan.rejects[key], 0)).toBe(400);
      expect(mixed.shellScan.rejects.callVetoStatusAbsent).toBe(0);
      expect(mixed.shellScan.rejects.callVetoStatusPending).toBe(200);
      expect(mixed.shellScan.rejects.callVetoStatusFinished).toBe(200);
    } finally { page.dom.window.close(); }
  });

  it.each(['finished', 'pending result', 'parent mismatch', 'request mismatch', 'wrong recipient', 'unclosed Code Mode'] as const)(
    'checks the exact native receipt diagnostically without overriding explicit false: %s', async receipt => {
      const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false,
        withExec: receipt === 'unclosed Code Mode',
        nativeCallMutation(mapping) {
          if (receipt === 'pending result') mapping[RESULT].message.status = 'in_progress';
          if (receipt === 'parent mismatch') mapping[RESULT].message.metadata.parent_id = USER;
          if (receipt === 'request mismatch') mapping[RESULT].message.metadata.request_id = 'another-request';
          if (receipt === 'wrong recipient') mapping[CALL].message.recipient = 'functions.exec';
          if (receipt === 'unclosed Code Mode') {
            const scope = { request_id: REQUEST, working_turn_id: TURN, turn_exchange_id: USER };
            Object.assign(mapping[EXEC], { parent: USER });
            Object.assign(mapping[EXEC].message, { status: 'finished_successfully', metadata: { ...scope, parent_id: USER } });
            mapping[CALL].parent = EXEC;
            mapping[CALL].message.metadata.parent_id = EXEC;
          }
        } });
      try {
        expect(page.fiber.turns[0].calls[0].answered).toBe(false);
        expect(page.fiber.shellScan.rejects.callCompletionVeto).toBe(1);
        expect(page.fiber.shellScan.rejects.callVetoReceiptChecked).toBe(1);
        expect(page.fiber.shellScan.rejects.callVetoReceiptMatched).toBe(receipt === 'finished' ? 1 : 0);
        const diagnostic = JSON.stringify(page.fiber.shellScan);
        for (const privateValue of [CALL, RESULT, REQUEST, APP, LINK, 'PRIVATE_TOOL_RESULT'])
          expect(diagnostic).not.toContain(privateValue);
      } finally { page.dom.window.close(); }
    }
  );

  it('reports an unselected widget reference even when explicit completion veto masks the early join', async () => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false,
      nativeCallMutation(_mapping, entry) { entry.turn.messageIds = [USER, CALL, ASSISTANT]; } });
    try {
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
      expect(page.fiber.shellScan.rejects).toMatchObject({ callCompletionVeto: 1, callCompletedFalse: 1,
        callVetoReceiptChecked: 0, callVetoReceiptMatched: 0, callJoinReferenceUnselected: 1 });
      const diagnostic = JSON.stringify(page.fiber.shellScan);
      for (const privateValue of [USER, CALL, RESULT, REQUEST, APP, LINK, 'PRIVATE_TOOL_RESULT'])
        expect(diagnostic).not.toContain(privateValue);
    } finally { page.dom.window.close(); }
  });

  it.each(['proven exact app and link', 'unproved app', 'foreign link', 'foreign surface', 'ambiguous app'] as const)(
    'recovers identity from an opaque native app path only with exact paired proof: %s', async variant => {
      const app = { appId: ASDK, linkId: LINK, surface: 'core', name: 'Luna Forge X7 Core' };
      const appIds = variant === 'unproved app' ? [] : [app];
      if (variant === 'foreign surface') appIds[0] = { ...app, surface: 'plugins', name: 'Luna Forge X7 Plugins' };
      if (variant === 'ambiguous app') appIds.push({ ...app, surface: 'plugins' });
      const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: false,
        callCompleted: false, assistantCompleted: false, appIds,
        nativeCallMutation(mapping, entry) {
          delete entry.turn.items[1].widgetStateSource;
          entry.turn.messageIds = [USER, CALL, ASSISTANT];
          const link = variant === 'foreign link' ? 'link_foreign' : LINK;
          mapping[CALL].message.content.text = JSON.stringify({ path: '/' + ASDK + '/' + link + '/read', args: {} });
        } });
      try {
        const call = page.fiber.turns[0].calls[0];
        expect(call).toMatchObject({ messageId: CALL, requestId: variant === 'proven exact app and link' ? REQUEST : null,
          answered: false });
        expect(page.fiber.turns[0].endMessageId).toBeNull();
        expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
      } finally { page.dom.window.close(); }
    }
  );

  it.each([true, false] as const)('joins exact opaque-app native results without display-name confusion (widget=%s)', async widget => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
      callCompleted: false, assistantCompleted: false,
      appIds: [{ appId: ASDK, linkId: LINK, surface: 'core', name: 'Luna Forge X7 Core' }],
      nativeCallMutation(mapping, entry) {
        if (!widget) delete entry.turn.items[1].widgetStateSource;
        mapping[CALL].message.content.text = JSON.stringify({ path: '/' + ASDK + '/' + LINK + '/read', args: {} });
        mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
          content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }],
          structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } } }) };
      } });
    try {
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ requestId: REQUEST, answered: true, resultReceiptId: 'a'.repeat(48) });
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it.each(['unproved app', 'foreign app proof', 'foreign link', 'foreign surface', 'ambiguous app',
    'wrong tool', 'result app conflict', 'result link conflict', 'result tool conflict',
    'request conflict', 'parent conflict', 'working conflict', 'exchange conflict',
    'pending native result', 'missing native witness', 'cached conflict', 'unselected result'] as const)(
    'keeps opaque-app completion refused with %s', async variant => {
      const app = { appId: ASDK, linkId: LINK, surface: 'core', name: 'Luna Forge X7 Core' };
      const appIds = variant === 'unproved app' ? [] : [app];
      if (variant === 'foreign app proof') appIds[0] = { ...app, appId: ASDK + '_foreign' };
      if (variant === 'foreign surface') appIds[0] = { ...app, surface: 'plugins', name: 'Luna Forge X7 Plugins' };
      if (variant === 'ambiguous app') appIds.push({ ...app, linkId: 'link_foreign' });
      const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
        nativeCallCacheConflict: variant === 'cached conflict',
        callCompleted: false, assistantCompleted: false, appIds,
        nativeCallMutation(mapping, entry) {
          mapping[CALL].message.content.text = JSON.stringify({ path: '/' + ASDK + '/' +
            (variant === 'foreign link' ? 'link_foreign' : LINK) + '/' + (variant === 'wrong tool' ? 'write' : 'read'), args: {} });
          mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
            content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }],
            structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } } }) };
          const result = mapping[RESULT].message;
          if (variant === 'result app conflict') result.metadata.invoked_resource.resource_uri = '/' + ASDK + '_foreign/' + LINK + '/read';
          if (variant === 'result link conflict') result.metadata.invoked_resource.resource_uri = '/' + ASDK + '/link_foreign/read';
          if (variant === 'result tool conflict') result.metadata.invoked_resource.resource_uri = '/' + ASDK + '/' + LINK + '/write';
          if (variant === 'request conflict') result.metadata.request_id = 'foreign-request';
          if (variant === 'parent conflict') result.metadata.parent_id = USER;
          if (variant === 'working conflict') result.metadata.working_turn_id = 'foreign-working';
          if (variant === 'exchange conflict') result.metadata.turn_exchange_id = 'foreign-exchange';
          if (variant === 'pending native result') result.status = 'in_progress';
          if (variant === 'missing native witness') result.content = { parts: ['PRIVATE_TOOL_RESULT'] };
          if (variant === 'unselected result') entry.turn.messageIds = [USER, CALL, ASSISTANT];
        } });
      try {
        expect(page.fiber.turns[0].calls[0]).toMatchObject({ answered: false });
        expect(page.fiber.turns[0].calls[0]).not.toHaveProperty('resultReceiptId');
        expect(page.fiber.turns[0].endMessageId).toBeNull();
        expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
      } finally { page.dom.window.close(); }
    });

  it.each([false, true])('keeps opaque-path prior pairs bound to the same link (foreign=%s)', async foreign => {
    const second = 'call_opaque_second';
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: false,
      callCompleted: false, assistantCompleted: false,
      appIds: [{ appId: ASDK, linkId: LINK, surface: 'core', name: 'Luna Forge X7 Core' }],
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        mapping[CALL].message.content.text = JSON.stringify({ path: '/' + ASDK + '/' + LINK + '/read', args: {} });
        if (foreign) mapping[RESULT].message.metadata.invoked_resource.resource_uri = '/' + ASDK + '/link_foreign/read';
        entry.turn.items.splice(2, 0, { type: 'mcp-tool-call', callId: second, completed: false,
          invocation: { server: APP, tool: 'read' } });
        entry.turn.messageIds = [USER, CALL, RESULT, second, ASSISTANT];
        mapping[second] = { id: second, parent: RESULT, message: { id: second, author: { role: 'assistant' },
          recipient: 'api_tool.call_tool', content: { text: JSON.stringify({ path: '/' + ASDK + '/' + LINK + '/read', args: {} }) },
          metadata: { parent_id: RESULT, request_id: 'request_opaque_second', working_turn_id: TURN, turn_exchange_id: USER } } };
      } });
    try {
      expect(page.fiber.turns[0].calls[1]).toMatchObject({ requestId: foreign ? null : 'request_opaque_second', answered: false });
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it('retains the exact request identity of a pending typed shell call without its result widget', async () => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: false,
      callCompleted: false, assistantCompleted: false,
      nativeCallMutation(_mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        entry.turn.messageIds = [USER, ASSISTANT];
      } });
    try {
      expect(page.fiber.turns[0].requests).toContainEqual({
        requestId: REQUEST, messageId: CALL, createTime: null
      });
      expect(page.fiber.turns[0].calls[0]).toMatchObject({
        messageId: CALL, requestId: REQUEST, answered: false
      });
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(page.fiber.shellScan.rejects).toMatchObject({ callJoinReferenceMissing: 1,
        callCompletionVeto: 1, callCompletedFalse: 1, callVetoReceiptMatched: 0 });
      expect(JSON.stringify(page.fiber.shellScan)).not.toContain(REQUEST);
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it.each([true, false])('diagnoses an exact pending native invocation request id (present=%s) without settling it', async present => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false,
      nativeCallMutation(mapping: any) {
        if (!present) delete mapping[CALL].message.metadata.request_id;
      } });
    try {
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
      expect(page.fiber.shellScan.rejects.callRequestIdPresent).toBe(present ? 1 : 0);
      expect(page.fiber.shellScan.rejects.callRequestIdMissing).toBe(present ? 0 : 1);
      for (const sensitive of [REQUEST, CALL, RESULT, 'PRIVATE_TOOL_RESULT'])
        expect(JSON.stringify(page.fiber.shellScan)).not.toContain(sensitive);
    } finally { page.dom.window.close(); }
  });

  it.each([false, true])('recovers a pending request from exactly one selected native user when the shell omits its typed user (object query: %s)', async objectConversationQuery => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: false,
      callCompleted: false, assistantCompleted: false, objectConversationQuery,
      nativeCallMutation(_mapping, entry) {
        entry.turn.items.shift();
        delete entry.turn.items[0].widgetStateSource;
        entry.turn.messageIds = [USER, ASSISTANT];
      } });
    try {
      expect(page.fiber.shellScan.rejects.userTypedMissing).toBe(1);
      expect(page.fiber.turns[0].messages.filter((message: any) => message.role === 'user')).toEqual([]);
      expect(page.fiber.turns[0].requests).toContainEqual({ requestId: REQUEST,
        messageId: CALL, createTime: null });
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ requestId: REQUEST, answered: false });
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      const serialized = JSON.stringify(page.fiber);
      expect(serialized).not.toContain('PRIVATE_TOOL_RESULT');
      expect(serialized).not.toContain('hello shell');
    } finally { page.dom.window.close(); }
  });

  it.each(['args-first', 'escaped-path', 'nested-only', 'foreign-root', 'truncated', 'over-budget', 'foreign-exchange',
    'duplicate-root', 'escaped-duplicate-root', 'path-in-string', 'malformed', 'accessor', 'object-text'] as const)(
    'reads only a complete top-level native request path without relaxing scope (%s)', async variant => {
      const path = `/${APP}/${LINK}/read`;
      let accessorReads = 0;
      const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
        nativeCallLive: false, callCompleted: false, assistantCompleted: false,
        nativeCallMutation(mapping, entry) {
          delete entry.turn.items[1].widgetStateSource;
          entry.turn.messageIds = [USER, CALL, ASSISTANT];
          const args = { path, note: variant === 'over-budget' ? 'x'.repeat(20_000) : 'PRIVATE_REORDERED_TOOL_ARGUMENT' };
          let text = JSON.stringify(variant === 'nested-only' ? { args }
            : { args, path: variant === 'foreign-root' ? `/Foreign_Core/${LINK}/read` : path });
          if (variant === 'escaped-path') text = text.replaceAll('/', '\\/');
          if (variant === 'truncated') text = text.slice(0, -2);
          if (variant === 'duplicate-root') text = `{"args":{},"path":${JSON.stringify(path)},"path":${JSON.stringify(path)}}`;
          if (variant === 'escaped-duplicate-root') text = `{"path":${JSON.stringify(path)},"p\\u0061th":${JSON.stringify(path)}}`;
          if (variant === 'path-in-string') text = JSON.stringify({ args: JSON.stringify({ path }) });
          if (variant === 'malformed') text = `{"path":${JSON.stringify(path)},"args":}`;
          if (variant === 'accessor') Object.defineProperty(mapping[CALL].message.content, 'text', {
            get() { accessorReads++; throw new Error('PRIVATE_ACCESSOR_MUST_NOT_RUN'); } });
          else if (variant === 'object-text') mapping[CALL].message.content.text = {
            toJSON() { accessorReads++; return { path }; } };
          else mapping[CALL].message.content.text = text;
          if (variant === 'foreign-exchange') mapping[CALL].message.metadata.turn_exchange_id = REFERENCE_SOURCE;
        } });
      try {
        const accepted = ['args-first', 'escaped-path'].includes(variant);
        expect(page.fiber.turns[0].calls[0]).toMatchObject({ answered: false, requestId: accepted ? REQUEST : null });
        expect(page.fiber.turns[0].requests.some((row: any) => row.requestId === REQUEST)).toBe(accepted);
        expect(page.fiber.turns[0].endMessageId).toBeNull();
        expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_REORDERED_TOOL_ARGUMENT');
        expect(accessorReads).toBe(0);
      } finally { page.dom.window.close(); }
    });

  it.each(['object', 'array', 'nested', 'string', 'args-first', 'nested-only', 'duplicate',
    'escaped-duplicate', 'malformed', 'foreign-root', 'foreign-exchange', 'over-depth'] as const)(
    'preserves only valid path-first truncation ending at a brace (%s)', async variant => {
      const path = JSON.stringify(`/${variant === 'foreign-root' ? 'Foreign_Core' : APP}/${LINK}/read`);
      let text = `{"path":${path},"payload":{"x":1}`;
      if (variant === 'array') text = `{"path":${path},"payload":[{}`;
      if (variant === 'nested') text = `{"path":${path},"payload":{"x":[{}`;
      if (variant === 'string') text = `{"path":${path},"payload":"PRIVATE_TRUNCATED_ARGUMENT}`;
      if (variant === 'args-first') text = `{"payload":{},"path":${path},"other":{}`;
      if (variant === 'nested-only') text = `{"payload":{"path":${path}}`;
      if (variant === 'duplicate') text = `{"path":${path},"path":${path},"payload":{}`;
      if (variant === 'escaped-duplicate') text = `{"path":${path},"p\\u0061th":${path},"payload":{}`;
      if (variant === 'malformed') text = `{"path":${path},"payload":{"x":01}`;
      if (variant === 'over-depth') text = `{"path":${path},"payload":${'['.repeat(34)}{}`;
      const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: false,
        callCompleted: false, assistantCompleted: false, nativeCallMutation(mapping, entry) {
          delete entry.turn.items[1].widgetStateSource;
          entry.turn.messageIds = [USER, CALL, ASSISTANT];
          mapping[CALL].message.content.text = text;
          if (variant === 'foreign-exchange') mapping[CALL].message.metadata.turn_exchange_id = REFERENCE_SOURCE;
        } });
      try {
        const accepted = ['object', 'array', 'nested', 'string'].includes(variant);
        expect(page.fiber.turns[0].calls[0]).toMatchObject({ requestId: accepted ? REQUEST : null, answered: false });
        expect(page.fiber.turns[0].requests.some((row: any) => row.requestId === REQUEST)).toBe(accepted);
        expect(page.fiber.turns[0].endMessageId).toBeNull();
        expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TRUNCATED_ARGUMENT');
      } finally { page.dom.window.close(); }
    });

  it.each(['function', 'accessor'] as const)('reads native paths without using a page-replaced JSON parser (%s)', async replacement => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: false,
      callCompleted: false, assistantCompleted: false, nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        entry.turn.messageIds = [USER, CALL, ASSISTANT];
        mapping[CALL].message.content.text = JSON.stringify({ args: {}, path: `/${APP}/${LINK}/read` });
      } });
    try {
      let replacedParserCalls = 0;
      const refused = () => { replacedParserCalls++; throw new Error('PRIVATE_REPLACED_PARSER'); };
      if (replacement === 'accessor') Object.defineProperty(page.win.JSON, 'parse', { get: refused });
      else page.win.JSON.parse = refused;
      const current = await shellRescan(page, 'captured-native-parser');
      expect(current.turns[0].calls[0]).toMatchObject({ requestId: REQUEST, answered: false });
      expect(replacedParserCalls).toBe(0);
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['null', true], ['true', true], ['false', true], ['-0', true], ['1.25e-3', true],
    ['[]', true], ['{}', true], ['[{"path":"nested"},[false,null,-12.3E+4]]', true],
    ['"escaped\\n\\u0000\\uD800"', true],
    ['01', false], ['-', false], ['1.', false], ['1e+', false], ['+1', false], ['.5', false],
    ['[1,]', false], ['{"x":1,}', false], ['{"x" 1}', false], ['true false', false],
    ['"invalid\\x20"', false], ['"invalid\\u00xz"', false], ['"unterminated', false],
    ['"raw\nnewline"', false], ['['.repeat(34) + '0' + ']'.repeat(34), false]
  ] as const)('validates skipped JSON syntax without materializing it (%s)', async (raw, accepted) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: false,
      callCompleted: false, assistantCompleted: false, nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        entry.turn.messageIds = [USER, CALL, ASSISTANT];
        mapping[CALL].message.content.text = `{"payload":${raw},"path":${JSON.stringify(`/${APP}/${LINK}/read`)}}`;
      } });
    try {
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ requestId: accepted ? REQUEST : null, answered: false });
      expect(page.fiber.turns[0].endMessageId).toBeNull();
    } finally { page.dom.window.close(); }
  });

  it('recovers an unreferenced Code Mode child only through its exact selected native user and typed exec owner', async () => {
    const page = await shellHarness({ withCall: true, withExec: true, nativeCallReceipt: true,
      nativeCallLive: false, callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        entry.turn.items.shift();
        delete entry.turn.items[1].widgetStateSource;
        entry.turn.messageIds = [USER, ASSISTANT];
        mapping[EXEC].parent = USER;
        mapping[EXEC].message.metadata = { request_id: EXEC_REQUEST,
          working_turn_id: TURN, turn_exchange_id: USER, parent_id: USER };
        mapping[CALL].parent = EXEC;
        mapping[CALL].message.metadata.parent_id = EXEC;
      } });
    try {
      expect(page.fiber.shellScan.rejects.userTypedMissing).toBe(1);
      expect(page.fiber.turns[0].requests).toContainEqual({ requestId: REQUEST, messageId: CALL, createTime: null });
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ answered: false, requestId: REQUEST });
      expect(page.fiber.turns[0].endMessageId).toBeNull();
    } finally { page.dom.window.close(); }
  });

  it.each([false, true])('keeps each later pending native request under one selected untyped user (second mismatches: %s)', async secondMismatches => {
    const secondCall = 'call_shell_second_read';
    const secondRequest = 'wfr_shell_second';
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: false,
      callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        entry.turn.items.shift();
        delete entry.turn.items[0].widgetStateSource;
        entry.turn.items.splice(1, 0, { type: 'mcp-tool-call', callId: secondCall,
          completed: false, invocation: { server: APP, tool: 'read' } });
        entry.turn.messageIds = [USER, ASSISTANT];
        mapping[secondCall] = { id: secondCall, parent: USER, message: {
          id: secondCall, author: { role: 'assistant' }, recipient: 'api_tool.call_tool',
          content: { text: `{"path":"/Luna Forge X7 Core/${LINK}/read","args":{}}` },
          metadata: { request_id: secondRequest, working_turn_id: TURN,
            turn_exchange_id: secondMismatches ? RESULT : USER, parent_id: USER }
        } };
      } });
    try {
      const turn = page.fiber.turns[0];
      expect(turn.requests).toContainEqual({ requestId: REQUEST, messageId: CALL, createTime: null });
      expect(turn.requests.some((row: any) => row.requestId === secondRequest)).toBe(!secondMismatches);
      expect(turn.calls).toHaveLength(2);
      expect(turn.calls[0]).toMatchObject({ requestId: REQUEST, answered: false });
      expect(turn.calls[1]).toMatchObject({ requestId: secondMismatches ? null : secondRequest, answered: false });
      expect(turn.endMessageId).toBeNull();
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['one valid native result chain', null],
    ['wrong prior tool-result role', (mapping: any) => { mapping[RESULT].message.author.name = 'functions.exec'; }],
    ['wrong prior result request', (mapping: any) => { mapping[RESULT].message.metadata.request_id = 'unrelated'; }],
    ['wrong prior result parent', (mapping: any) => { mapping[RESULT].parent = USER; }],
    ['wrong prior invocation exchange', (mapping: any) => { mapping[CALL].message.metadata.turn_exchange_id = 'unrelated'; }],
    ['wrong prior invocation tool', (mapping: any) => { mapping[CALL].message.content.text = '{"path":"/Gmail/link_private/read"}'; }],
    ['another approved connector with the same tool name', (mapping: any) => {
      mapping[CALL].message.content.text = `{"path":"/Luna Forge X7 Plugins/${LINK}/read","args":{}}`;
    }],
    ['wrong prior result connector identity', (mapping: any) => {
      mapping[RESULT].message.metadata.invoked_resource.app_name = 'Gmail';
    }],
    ['wrong prior result tool identity', (mapping: any) => {
      mapping[RESULT].message.metadata.invoked_resource.resource_uri = `/${ASDK}/${LINK}/write`;
    }],
    ['unselected prior result', (_mapping: any, entry: any) => { entry.turn.messageIds = [USER, CALL, ASSISTANT]; }],
    ['foreign intermediate user', (mapping: any) => { mapping[RESULT].message.author.role = 'user'; }]
  ] as const)('recovers only a subsequent pending request whose prior native tool chain is exact: %s', async (label, change) => {
    const secondId = 'call_shell_after_result';
    const secondRequest = 'wfr_shell_after_result';
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
      nativeCallLive: false, callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        entry.turn.items.splice(2, 0, { type: 'mcp-tool-call', callId: secondId,
          completed: false, invocation: { server: APP, tool: 'read' } });
        entry.turn.items[2].widgetStateSource = undefined;
        // A provider may preserve its historical parent chain while the newly
        // executing second call has not joined the selected messageIds yet.
        entry.turn.messageIds = [USER, CALL, RESULT, ASSISTANT];
        mapping[secondId] = { id: secondId, parent: RESULT,
          message: { id: secondId, author: { role: 'assistant' }, recipient: 'api_tool.call_tool',
            content: { text: `{"path":"/Luna Forge X7 Core/${LINK}/read","args":{}}` },
            metadata: { request_id: secondRequest, working_turn_id: TURN,
              turn_exchange_id: USER, parent_id: RESULT } } };
        change?.(mapping, entry);
      } });
    try {
      const turn = page.fiber.turns[0];
      expect(turn.calls).toHaveLength(2);
      expect(turn.calls.every((call: any) => call.answered === false)).toBe(true);
      expect(turn.endMessageId).toBeNull();
      expect(turn.requests.some((item: any) => item.requestId === secondRequest)).toBe(label === 'one valid native result chain');
      expect(turn.calls[1].requestId).toBe(label === 'one valid native result chain' ? secondRequest : null);
      if (label === 'one valid native result chain') expect(page.fiber.shellScan.rejects).toMatchObject({
        callIdentityRecovered: 2, callIdentityPriorPair: 1,
        callIdentityUserUnproved: 0, callIdentityNativeUnproved: 0,
        callIdentityScopeUnproved: 0, callIdentityParentUnproved: 0
      });
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['selected invocation, missing widget', false],
    ['selected invocation and result, mounted widget', true]
  ] as const)('does not publish a pending request through selected native IDs with a foreign exchange: %s', async (_label, withResult) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
      nativeCallLive: false, callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        if (!withResult) delete entry.turn.items[1].widgetStateSource;
        entry.turn.messageIds = withResult ? [USER, CALL, RESULT, ASSISTANT] : [USER, CALL, ASSISTANT];
        mapping[CALL].message.metadata.turn_exchange_id = REFERENCE_SOURCE;
      } });
    try {
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ answered: false, requestId: null });
      expect(page.fiber.turns[0].requests).not.toContainEqual(expect.objectContaining({ requestId: REQUEST }));
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(JSON.stringify(page.fiber.shellScan)).not.toContain(REQUEST);
      if (!withResult) expect(page.fiber.shellScan.rejects).toMatchObject({
        callIdentityScopeUnproved: 1, callIdentitySelectedWithheld: 1,
        callIdentityRecovered: 0
      });
    } finally { page.dom.window.close(); }
  });

  it('withholds the selected pending invocation when its widget result is unselected and its native user exchange conflicts', async () => {
    const diagnosticLogs: string[] = [];
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
      nativeCallLive: false, callCompleted: false, assistantCompleted: false, diagnosticLogs,
      nativeCallMutation(mapping, entry) {
        entry.turn.messageIds = [USER, CALL, ASSISTANT];
        mapping[CALL].message.metadata.turn_exchange_id = REFERENCE_SOURCE;
      } });
    try {
      expect(page.fiber.shellScan.rejects).toMatchObject({
        callJoinReferenceUnselected: 1, callIdentityScopeUnproved: 1,
        callIdentitySelectedWithheld: 1
      });
      const trace = diagnosticLogs.find(line => line.includes('native result-reference recovery diagnostic'))!;
      expect(trace).toContain('version=5');
      expect(trace).toContain('missing=0');
      expect(trace).toContain('identityRefusals=1');
      expect(trace).toContain('turnExchangeMismatch:1');
      expect(trace).toContain('requestIdPresent=1 requestIdMissing=0');
      for (const privateValue of [USER, CALL, RESULT, REQUEST, APP, LINK, REFERENCE_SOURCE])
        expect(trace).not.toContain(privateValue);
      expect(page.fiber.turns[0].requests).not.toContainEqual(expect.objectContaining({ requestId: REQUEST }));
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ answered: false, requestId: null });
      expect(page.fiber.turns[0].endMessageId).toBeNull();
    } finally { page.dom.window.close(); }
  });


  it.each(['exact folded narration', 'foreign namespace', 'wrong parent', 'foreign role', 'tool recipient', 'unsupported channel', 'missing final receipt', 'unselected result', 'metadata accessor'] as const)(
    'joins folded native narration only under an exact terminal namespace: %s', async variant => {
      let accessorReads = 0;
      const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
        callCompleted: false, assistantCompleted: false,
        nativeCallMutation(mapping, entry) {
          delete entry.turn.items[1].widgetStateSource;
          entry.turn.messageIds = [USER, CALL, RESULT, ASSISTANT];
          mapping[INTERIM] = { id: INTERIM, parent: USER, message: { id: INTERIM,
            author: { role: 'assistant' }, recipient: 'all', channel: 'commentary',
            content: { content_type: 'text', parts: ['PRIVATE_FOLDED_NARRATION'] },
            metadata: { parent_id: USER, working_turn_id: 'native-folded-working',
              turn_exchange_id: 'native-folded-exchange' } } };
          mapping[CALL].parent = INTERIM;
          for (const id of [CALL, RESULT, ASSISTANT]) Object.assign(mapping[id].message.metadata, {
            working_turn_id: 'native-folded-working', turn_exchange_id: 'native-folded-exchange',
            parent_id: mapping[id].parent
          });
          mapping[CALL].message.status = 'in_progress';
          mapping[RESULT].message.status = 'in_progress';
          if (variant === 'foreign namespace') mapping[INTERIM].message.metadata.working_turn_id = 'foreign';
          if (variant === 'wrong parent') mapping[INTERIM].message.metadata.parent_id = ASSISTANT;
          if (variant === 'foreign role') mapping[INTERIM].message.author.role = 'user';
          if (variant === 'tool recipient') mapping[INTERIM].message.recipient = 'api_tool.call_tool';
          if (variant === 'unsupported channel') mapping[INTERIM].message.channel = 'unknown';
          if (variant === 'missing final receipt') mapping[ASSISTANT].message.status = 'in_progress';
          if (variant === 'unselected result') entry.turn.messageIds = [USER, CALL, ASSISTANT];
          if (variant === 'metadata accessor') Object.defineProperty(mapping[INTERIM].message, 'channel', {
            get() { accessorReads++; throw new Error('PRIVATE_FOLDED_GETTER'); }
          });
        } });
      try {
        const turn = page.fiber.turns[0];
        expect(turn.calls[0].requestId).toBe(variant === 'exact folded narration' ? REQUEST : null);
        expect(turn.requests.some((row: any) => row.requestId === REQUEST && row.messageId === CALL))
          .toBe(variant === 'exact folded narration');
        expect(turn.calls[0].answered).toBe(false);
        expect(turn.endMessageId).toBeNull();
        expect(accessorReads).toBe(0);
        expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_FOLDED_NARRATION');
        expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_FOLDED_GETTER');
      } finally { page.dom.window.close(); }
    });

  it.each(['identity only', 'finished result', 'foreign namespace', 'wrong parent', 'foreign role',
    'tool recipient', 'unsupported channel', 'missing final receipt', 'unselected result', 'metadata accessor'] as const)(
    'keeps selected native narration on the same exact request ancestry: %s', async variant => {
      let accessorReads = 0;
      const accepted = variant === 'identity only' || variant === 'finished result';
      const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
        callCompleted: false, assistantCompleted: false,
        nativeCallMutation(mapping, entry) {
          delete entry.turn.items[1].widgetStateSource;
          entry.turn.messageIds = [USER, INTERIM, CALL, RESULT, ASSISTANT];
          mapping[INTERIM] = { id: INTERIM, parent: USER, message: { id: INTERIM,
            author: { role: 'assistant' }, recipient: 'all', channel: 'analysis',
            content: { content_type: 'text', parts: ['PRIVATE_SELECTED_NARRATION'] },
            metadata: { parent_id: USER, working_turn_id: 'native-selected-working',
              turn_exchange_id: 'native-selected-exchange' } } };
          mapping[CALL].parent = INTERIM;
          for (const id of [CALL, RESULT, ASSISTANT]) Object.assign(mapping[id].message.metadata, {
            working_turn_id: 'native-selected-working', turn_exchange_id: 'native-selected-exchange',
            parent_id: mapping[id].parent
          });
          if (variant === 'finished result') mapping[RESULT].message.content = {
            content_type: 'code', language: 'json', text: JSON.stringify({
              content: [{ type: 'text', text: 'PRIVATE_SELECTED_RESULT' }],
              structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } }
            }) };
          else { mapping[CALL].message.status = 'in_progress'; mapping[RESULT].message.status = 'in_progress'; }
          if (variant === 'foreign namespace') mapping[INTERIM].message.metadata.working_turn_id = 'foreign';
          if (variant === 'wrong parent') mapping[INTERIM].message.metadata.parent_id = ASSISTANT;
          if (variant === 'foreign role') mapping[INTERIM].message.author.role = 'user';
          if (variant === 'tool recipient') mapping[INTERIM].message.recipient = 'api_tool.call_tool';
          if (variant === 'unsupported channel') mapping[INTERIM].message.channel = 'unknown';
          if (variant === 'missing final receipt') mapping[ASSISTANT].message.status = 'in_progress';
          if (variant === 'unselected result') entry.turn.messageIds = [USER, INTERIM, CALL, ASSISTANT];
          if (variant === 'metadata accessor') Object.defineProperty(mapping[INTERIM].message, 'channel', {
            get() { accessorReads++; throw new Error('PRIVATE_SELECTED_GETTER'); }
          });
        } });
      try {
        const turn = page.fiber.turns[0];
        expect(turn.calls[0].requestId).toBe(accepted ? REQUEST : null);
        expect(turn.requests.some((row: any) => row.requestId === REQUEST && row.messageId === CALL)).toBe(accepted);
        expect(turn.calls[0].answered).toBe(variant === 'finished result');
        expect(turn.endMessageId).toBe(variant === 'finished result' ? ASSISTANT : null);
        expect(accessorReads).toBe(0);
        for (const value of ['PRIVATE_SELECTED_NARRATION', 'PRIVATE_SELECTED_RESULT', 'PRIVATE_SELECTED_GETTER'])
          expect(JSON.stringify(page.fiber)).not.toContain(value);
      } finally { page.dom.window.close(); }
    });

  it.each([
    ['identity only', true, false], ['finished exact result', true, true], ['cached mapping only', false, false]
  ] as const)('joins the virtualized native namespace only through an independently mounted branch: %s', async (_label, live, finished) => {
    const page = await shellHarness({ withCall: true, withoutUserSlot: true, nativeCallReceipt: true,
      nativeCallLive: live, callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        entry.turn.items.shift();
        delete entry.turn.items[0].widgetStateSource;
        entry.turn.messageIds = [USER, CALL, RESULT, ASSISTANT];
        for (const id of [CALL, RESULT, ASSISTANT]) Object.assign(mapping[id].message.metadata, {
          working_turn_id: 'native-virtual-working', turn_exchange_id: 'native-virtual-exchange',
          parent_id: mapping[id].parent
        });
        if (finished) mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
          content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }],
          structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } } }) };
        else { mapping[CALL].message.status = 'in_progress'; mapping[RESULT].message.status = 'in_progress'; }
      } });
    try {
      const turn = page.fiber.turns[0];
      expect(turn.messages.filter((message: any) => message.role === 'user')).toEqual([]);
      expect(turn.calls[0].requestId).toBe(live ? REQUEST : null);
      expect(turn.calls[0].answered, JSON.stringify(page.fiber.shellScan.rejects)).toBe(live && finished);
      expect(turn.requests.some((row: any) => row.requestId === REQUEST && row.messageId === CALL)).toBe(live);
      if (!live || !finished) expect(turn.endMessageId).toBeNull();
      for (const value of ['PRIVATE_TOOL_RESULT', 'hello shell', 'native-virtual-working', 'native-virtual-exchange'])
        expect(JSON.stringify(page.fiber)).not.toContain(value);
    } finally { page.dom.window.close(); }
  });

  it.each(['two native users', 'user unselected', 'foreign final scope', 'unselected result', 'cache conflict', 'user accessor'] as const)(
    'refuses the virtualized native namespace with %s', async variant => {
      let accessorReads = 0;
      const page = await shellHarness({ withCall: true, withoutUserSlot: true, nativeCallReceipt: true,
        nativeCallCacheConflict: variant === 'cache conflict', callCompleted: false, assistantCompleted: false,
        nativeCallMutation(mapping, entry) {
          entry.turn.items.shift(); delete entry.turn.items[0].widgetStateSource;
          entry.turn.messageIds = [USER, CALL, RESULT, ASSISTANT];
          for (const id of [CALL, RESULT, ASSISTANT]) Object.assign(mapping[id].message.metadata, {
            working_turn_id: 'native-virtual-working', turn_exchange_id: 'native-virtual-exchange', parent_id: mapping[id].parent
          });
          if (variant === 'two native users') {
            mapping[REFERENCE_SOURCE] = { id: REFERENCE_SOURCE, message: { id: REFERENCE_SOURCE, author: { role: 'user' } } };
            entry.turn.messageIds.push(REFERENCE_SOURCE);
          }
          if (variant === 'user unselected') entry.turn.messageIds = [CALL, RESULT, ASSISTANT];
          if (variant === 'foreign final scope') mapping[ASSISTANT].message.metadata.turn_exchange_id = 'foreign';
          if (variant === 'unselected result') entry.turn.messageIds = [USER, CALL, ASSISTANT];
          if (variant === 'user accessor') Object.defineProperty(mapping[USER].message.author, 'role', {
            get() { accessorReads++; throw new Error('PRIVATE_NATIVE_GETTER'); }
          });
        } });
      try {
        expect(page.fiber.turns[0].calls[0]).toMatchObject({ requestId: null, answered: false });
        expect(page.fiber.turns[0].requests.some((row: any) => row.requestId === REQUEST && row.messageId === CALL)).toBe(false);
        expect(page.fiber.turns[0].endMessageId).toBeNull();
        expect(accessorReads).toBe(0);
        expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
      } finally { page.dom.window.close(); }
    });

  it.each([
    ['incomplete turn before a bad final', 'nativeScopeTurnIncomplete', 'none'],
    ['unselected path before a bad final', 'nativeScopePathUnproved', 'none'],
    ['duplicate final', 'nativeScopeFinalCount', 'final-count'],
    ['final off current path', 'nativeScopeFinalPathMismatch', 'path-tail'],
    ['nonterminal final', 'nativeScopeFinalReceiptUnproved', 'native-terminal'],
    ['native routing', 'nativeScopeFinalReceiptUnproved', 'native-routing'],
    ['native terminal accessor', 'nativeScopeFinalReceiptUnproved', 'native-own-data'],
    ['native text shape', 'nativeScopeFinalReceiptUnproved', 'native-text-shape'],
    ['native text part', 'nativeScopeFinalReceiptUnproved', 'native-text-part'],
    ['empty native text', 'nativeScopeFinalReceiptUnproved', 'native-text-empty'],
    ['oversized native text', 'nativeScopeFinalReceiptUnproved', 'native-text-budget'],
    ['typed final shape', 'nativeScopeFinalReceiptUnproved', 'typed-final-shape'],
    ['different final body', 'nativeScopeFinalReceiptUnproved', 'body-or-reference'],
    ['foreign final reference', 'nativeScopeFinalReceiptUnproved', 'body-or-reference'],
    ['getter final reference', 'nativeScopeFinalReceiptUnproved', 'body-or-reference'],
    ['missing final namespace', 'nativeScopeFinalNamespaceMissing', 'none'],
    ['cached branch conflict', 'nativeScopeCacheConflict', 'none'],
    ['branch namespace conflict', 'nativeScopeBranchConflict', 'none'],
    ['branch exchange conflict', 'nativeScopeBranchConflict', 'none'],
    ['branch metadata parent conflict', 'nativeScopeBranchConflict', 'none'],
    ['namespace accessor', 'nativeScopeFinalNamespaceMissing', 'none']
  ] as const)('reports only the first attempted native scope anchor refusal: %s', async (variant, expectedReason, expectedFacet) => {
    let accessorReads = 0;
    const diagnosticLogs: string[] = [];
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
      nativeCallCacheConflict: variant === 'cached branch conflict',
      callCompleted: false, assistantCompleted: false, diagnosticLogs,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        entry.turn.messageIds = [USER, CALL, RESULT, ASSISTANT];
        for (const id of [CALL, RESULT, ASSISTANT]) Object.assign(mapping[id].message.metadata, {
          working_turn_id: 'PRIVATE_ANCHOR_WORKING', turn_exchange_id: 'PRIVATE_ANCHOR_EXCHANGE',
          parent_id: mapping[id].parent
        });
        if (variant === 'incomplete turn before a bad final') entry.turn.status = 'in_progress';
        if (variant === 'unselected path before a bad final') entry.turn.messageIds = [USER, CALL, ASSISTANT];
        if (variant === 'duplicate final') entry.turn.items.push({ type: 'assistant-message', messageId: RESULT,
          phase: 'final_answer', content: 'other final', completed: false });
        if (variant === 'final off current path') entry.turn.items.at(-1).messageId = RESULT;
        if (['incomplete turn before a bad final', 'unselected path before a bad final', 'nonterminal final'].includes(variant))
          mapping[ASSISTANT].message.status = 'in_progress';
        if (variant === 'native routing') mapping[ASSISTANT].message.recipient = 'PRIVATE_FOREIGN_RECIPIENT';
        if (variant === 'native terminal accessor') Object.defineProperty(mapping[ASSISTANT].message, 'end_turn', {
          get() { accessorReads++; throw new Error('PRIVATE_TERMINAL_GETTER'); }
        });
        if (variant === 'native text shape') mapping[ASSISTANT].message.content.content_type = 'image';
        if (variant === 'native text part') mapping[ASSISTANT].message.content.parts = [{ text: 'PRIVATE_UNSUPPORTED_TEXT' }];
        if (variant === 'empty native text') mapping[ASSISTANT].message.content.parts = [''];
        if (variant === 'oversized native text') mapping[ASSISTANT].message.content.parts = ['x'.repeat(700 * 1024)];
        if (variant === 'typed final shape') entry.turn.items.at(-1).content = { text: 'PRIVATE_TYPED_SHAPE' };
        if (variant === 'different final body') entry.turn.items.at(-1).content = 'PRIVATE_DIFFERENT_BODY';
        if (variant === 'foreign final reference' || variant === 'getter final reference') {
          const final = entry.turn.items.at(-1);
          final.content = `::chatgpt-content-reference{source_message_id="${ASSISTANT}"}`;
          final.contentReferences = [{ type: 'dil', source_message_id: 'PRIVATE_FOREIGN_FINAL',
            model_dil_v2: { fallbackMarkdown: 'PRIVATE_PREVIEW_TEXT' } }];
          if (variant === 'getter final reference') Object.defineProperty(final.contentReferences[0], 'source_message_id', {
            get() { accessorReads++; throw new Error('PRIVATE_FINAL_REFERENCE_GETTER'); }
          });
        }
        if (variant === 'missing final namespace') delete mapping[ASSISTANT].message.metadata.working_turn_id;
        if (variant === 'branch namespace conflict') mapping[RESULT].message.metadata.working_turn_id = 'PRIVATE_OTHER_WORKING';
        if (variant === 'branch exchange conflict') mapping[RESULT].message.metadata.turn_exchange_id = 'PRIVATE_OTHER_EXCHANGE';
        if (variant === 'branch metadata parent conflict') mapping[RESULT].message.metadata.parent_id = 'PRIVATE_OTHER_PARENT';
        if (variant === 'namespace accessor') Object.defineProperty(mapping[ASSISTANT].message.metadata, 'working_turn_id', {
          get() { accessorReads++; throw new Error('PRIVATE_SCOPE_GETTER'); }
        });
      } });
    try {
      const call = page.fiber.turns[0].calls[0];
      expect(call.identityRefusalReasons.filter((code: string) => code.startsWith('nativeScope'))).toEqual([expectedReason]);
      expect(call.identityRefusalReasons).toEqual(expect.arrayContaining(['workingTurnMismatch', 'turnExchangeMismatch']));
      const key = 'identityReason' + expectedReason[0]!.toUpperCase() + expectedReason.slice(1);
      expect(page.fiber.shellScan.rejects[key]).toBe(1);
      if (variant.startsWith('branch ')) {
        const stage = variant === 'branch namespace conflict' ? 'selected-working-turn'
          : variant === 'branch exchange conflict' ? 'selected-exchange' : 'selected-metadata-parent';
        expect(diagnosticLogs.some(line => line.includes(`anchorBranch=${stage}`))).toBe(true);
      }
      expect(call).toMatchObject({ requestId: null, answered: false });
      expect(page.fiber.turns[0].requests).not.toContainEqual(expect.objectContaining({ requestId: REQUEST, messageId: CALL }));
      // The existing public-reference terminal projection is independent of the
      // refused request namespace; diagnostics must preserve both facts unchanged.
      expect(page.fiber.turns[0].endMessageId).toBe(
        variant === 'foreign final reference' || variant === 'getter final reference' ? ASSISTANT : null);
      expect(accessorReads).toBe(0);
      const trace = diagnosticLogs.find(line => line.includes('native result-reference recovery diagnostic'))!;
      expect(trace).toContain(`${expectedReason}:1`);
      expect(trace).toContain(`anchorFinalFacet=${expectedFacet}`);
      if (variant === 'unselected path before a bad final') {
        expect(trace).toContain('anchorMember=core-result');
        expect(trace).toContain('anchorMemberTerminal=true');
      }
      for (const value of [USER, CALL, RESULT, REQUEST, APP, LINK, 'PRIVATE_ANCHOR_WORKING', 'PRIVATE_ANCHOR_EXCHANGE',
        'PRIVATE_OTHER_WORKING', 'PRIVATE_OTHER_EXCHANGE', 'PRIVATE_OTHER_PARENT',
        'PRIVATE_SCOPE_GETTER', 'PRIVATE_TOOL_RESULT', 'PRIVATE_FOREIGN_RECIPIENT', 'PRIVATE_TERMINAL_GETTER',
        'PRIVATE_UNSUPPORTED_TEXT', 'PRIVATE_TYPED_SHAPE', 'PRIVATE_DIFFERENT_BODY', 'PRIVATE_FOREIGN_FINAL',
        'PRIVATE_PREVIEW_TEXT', 'PRIVATE_FINAL_REFERENCE_GETTER']) expect(trace).not.toContain(value);
    } finally { page.dom.window.close(); }
  });

  it('does not invent a final-anchor facet when the typed shell is rejected before anchor inspection', async () => {
    const diagnosticLogs: string[] = [];
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
      callCompleted: false, assistantCompleted: false, diagnosticLogs,
      nativeCallMutation(_mapping, entry) { entry.turn.items.at(-1).messageId = ''; } });
    try {
      expect(page.fiber.turns).toEqual([]);
      expect(diagnosticLogs.some(line => line.includes('anchorFinalFacet='))).toBe(false);
    } finally { page.dom.window.close(); }
  });

  it.each(['matching scope', 'foreign path', 'working field missing', 'exchange field missing'] as const)(
    'does not label an unused native scope anchor as a namespace refusal: %s', async variant => {
      const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
        callCompleted: false, assistantCompleted: false,
        nativeCallMutation(mapping, entry) {
          delete entry.turn.items[1].widgetStateSource;
          entry.turn.status = 'in_progress';
          entry.turn.messageIds = [USER, CALL, RESULT, ASSISTANT];
          if (variant === 'foreign path') mapping[CALL].message.content.text = JSON.stringify({ path: '/Gmail/private/read' });
          if (variant === 'working field missing') delete mapping[CALL].message.metadata.working_turn_id;
          if (variant === 'exchange field missing') delete mapping[CALL].message.metadata.turn_exchange_id;
        } });
      try {
        const call = page.fiber.turns[0].calls[0];
        expect(call.requestId).toBe(variant === 'matching scope' ? REQUEST : null);
        expect(call.answered).toBe(false);
        if (variant === 'working field missing') expect(call.identityRefusalReasons).toContain('workingTurnMissing');
        if (variant === 'exchange field missing') expect(call.identityRefusalReasons).toContain('turnExchangeMissing');
        expect(call.identityRefusalReasons.filter((code: string) => code.startsWith('nativeScope'))).toEqual([]);
        expect(Object.entries(page.fiber.shellScan.rejects).filter(([key, count]) =>
          key.startsWith('identityReasonNativeScope') && count !== 0)).toEqual([]);
        expect(page.fiber.turns[0].endMessageId).toBeNull();
      } finally { page.dom.window.close(); }
    });

  it.each([
    ['cached only', false, 'complete', ASSISTANT, 'nativeAnchorLiveMissing'],
    ['incomplete turn', true, 'in_progress', ASSISTANT, 'nativeAnchorTurnIncomplete'],
    ['missing current path', true, 'complete', 'missing-native-node', 'nativeAnchorPathEmpty'],
    ['missing live wins first', false, 'in_progress', 'missing-native-node', 'nativeAnchorLiveMissing'],
    ['incomplete turn wins before path', true, 'in_progress', 'missing-native-node', 'nativeAnchorTurnIncomplete']
  ] as const)('narrows the native anchor prerequisite without granting identity: %s', async (_label, live, status, current, reason) => {
    const diagnosticLogs: string[] = [];
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: live,
      status, nativeCurrentNode: current, callCompleted: false, assistantCompleted: false, diagnosticLogs,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        entry.turn.messageIds = [USER, CALL, RESULT, ASSISTANT];
        for (const id of [CALL, RESULT, ASSISTANT]) Object.assign(mapping[id].message.metadata, {
          working_turn_id: 'native-working-generation', turn_exchange_id: 'native-exchange-generation',
          parent_id: mapping[id].parent
        });
      } });
    try {
      const rejects = page.fiber.shellScan.rejects;
      expect(rejects.nativeAnchorPrerequisite).toBe(1);
      expect(rejects[reason]).toBe(1);
      // The console must retain the first failed anchor when a legacy transport
      // drops additive counters. Its fixed code cannot supply missing identity.
      expect(diagnosticLogs.find(line => line.includes('native result-reference recovery diagnostic')))
        .toContain(`anchorReason=${reason}`);
      const reasons = ['nativeAnchorLiveMissing', 'nativeAnchorUserMissing', 'nativeAnchorTurnIncomplete',
        'nativeAnchorPathEmpty', 'nativeAnchorUserPathMismatch', 'nativeAnchorUnselectedPath'];
      expect(reasons.reduce((total, key) => total + (rejects[key] ?? 0), 0)).toBe(1);
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ requestId: null, answered: false });
      expect(page.fiber.turns[0].requests.some((row: any) => row.requestId === REQUEST && row.messageId === CALL)).toBe(false);
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(JSON.stringify(page.fiber.shellScan)).not.toContain('native-working-generation');
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it.each(['terminal native anchor', 'scoped native user', 'explicit widget pointer', 'pending result',
    'pending invocation', 'missing witness', 'ambiguous result children', 'foreign request', 'foreign working turn',
    'foreign exchange', 'wrong result parent', 'foreign resource connector', 'foreign resource link',
    'foreign resource tool', 'foreign invocation connector', 'cached conflict', 'foreign final namespace',
    'nonterminal final', 'unselected user', 'unselected invocation', 'unselected final', 'no mounted mapping',
    'shared result reference', 'result namespace accessor'] as const)(
    'recovers only an exact unselected missing-pointer result under an independent native namespace: %s', async variant => {
      const accepted = variant === 'terminal native anchor' || variant === 'scoped native user';
      let accessorReads = 0;
      const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
        nativeCallLive: variant !== 'no mounted mapping', nativeCallCacheConflict: variant === 'cached conflict',
        callCompleted: false, assistantCompleted: false,
        nativeCallMutation(mapping, entry) {
          if (variant !== 'explicit widget pointer') delete entry.turn.items[1].widgetStateSource;
          entry.turn.messageIds = [USER, CALL, ASSISTANT];
          for (const id of [CALL, RESULT, ASSISTANT]) Object.assign(mapping[id].message.metadata, {
            working_turn_id: 'native-recovered-working', turn_exchange_id: 'native-recovered-exchange',
            parent_id: mapping[id].parent
          });
          mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
            content: [{ type: 'text', text: 'PRIVATE_UNSELECTED_TOOL_RESULT' }],
            structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } } }) };
          if (variant === 'scoped native user') {
            Object.assign(mapping[USER].message.metadata, { working_turn_id: 'native-recovered-working',
              turn_exchange_id: 'native-recovered-exchange' });
            mapping[ASSISTANT].message.status = 'in_progress';
          }
          if (variant === 'pending result') mapping[RESULT].message.status = 'in_progress';
          if (variant === 'pending invocation') mapping[CALL].message.status = 'in_progress';
          if (variant === 'missing witness') mapping[RESULT].message.content = { parts: ['PRIVATE_UNSELECTED_TOOL_RESULT'] };
          if (variant === 'ambiguous result children') {
            const second = 'ambiguous-native-result';
            mapping[second] = { id: second, parent: RESULT, message: { ...mapping[RESULT].message,
              id: second, metadata: { ...mapping[RESULT].message.metadata, parent_id: CALL } } };
            mapping[ASSISTANT].parent = second;
            mapping[ASSISTANT].message.metadata.parent_id = second;
          }
          if (variant === 'foreign request') mapping[RESULT].message.metadata.request_id = 'foreign-request';
          if (variant === 'foreign working turn') mapping[RESULT].message.metadata.working_turn_id = 'foreign-working';
          if (variant === 'foreign exchange') mapping[RESULT].message.metadata.turn_exchange_id = 'foreign-exchange';
          if (variant === 'wrong result parent') mapping[RESULT].message.metadata.parent_id = USER;
          if (variant === 'foreign resource connector') mapping[RESULT].message.metadata.invoked_resource.app_name = 'Gmail';
          if (variant === 'foreign resource link') mapping[RESULT].message.metadata.invoked_resource.resource_uri = `/${ASDK}/link_foreign/read`;
          if (variant === 'foreign resource tool') mapping[RESULT].message.metadata.invoked_resource.resource_uri = `/${ASDK}/${LINK}/write`;
          if (variant === 'foreign invocation connector') mapping[CALL].message.content.text = '{"path":"/Gmail/private/read"}';
          if (variant === 'foreign final namespace') mapping[ASSISTANT].message.metadata.turn_exchange_id = 'foreign-final';
          if (variant === 'nonterminal final') mapping[ASSISTANT].message.status = 'in_progress';
          if (variant === 'unselected user') entry.turn.messageIds = [CALL, ASSISTANT];
          if (variant === 'unselected invocation') entry.turn.messageIds = [USER, ASSISTANT];
          if (variant === 'unselected final') entry.turn.messageIds = [USER, CALL];
          if (variant === 'shared result reference') entry.turn.items.splice(2, 0, {
            ...entry.turn.items[1], callId: 'another-typed-call', widgetStateSource: { messageId: RESULT } });
          if (variant === 'result namespace accessor') Object.defineProperty(mapping[RESULT].message.metadata, 'working_turn_id', {
            get() { accessorReads++; throw new Error('PRIVATE_RESULT_AUTHOR_GETTER'); }
          });
        } });
      try {
        const turn = page.fiber.turns[0];
        expect(turn.calls[0]).toMatchObject({ requestId: accepted ? REQUEST : null, answered: accepted });
        expect(turn.calls[0].resultReceiptId).toBe(accepted ? 'a'.repeat(48) : undefined);
        expect(turn.requests.some((row: any) => row.requestId === REQUEST && row.messageId === CALL)).toBe(accepted);
        if (variant !== 'terminal native anchor') expect(turn.endMessageId).toBeNull();
        expect(accessorReads).toBe(0);
        expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_UNSELECTED_TOOL_RESULT');
        expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_RESULT_AUTHOR_GETTER');
      } finally { page.dom.window.close(); }
    });

  it.each(['accepted successor', 'accepted streaming successor', 'accepted completed chain', 'accepted streaming chain', 'accepted streaming long chain',
    'foreign intermediate conversation', 'unclosed intermediate turn', 'intermediate final mismatch',
    'duplicate intermediate user', 'intermediate parent accessor', 'conflicting intermediate final', 'intermediate selected ids accessor',
    'intermediate selected ids duplicate', 'skipped intermediate final',
    'foreign successor branch', 'unclosed historical turn',
    'foreign successor conversation', 'missing successor user', 'duplicate successor user', 'unselected successor',
    'off-branch successor', 'cyclic successor', 'nonterminal historical final', 'duplicate historical final',
    'missing historical receipt', 'foreign historical request', 'nonadjacent historical turn',
    'successor items accessor', 'successor parent accessor', 'conflicting historical cache'] as const)(
    'retains exact older result identities after a mounted successor without reopening its final: %s', async variant => {
      let accessorReads = 0;
      const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
        callCompleted: false, assistantCompleted: false, diagnosticLogs: [],
        nativeCallMutation(mapping, entry) {
          delete entry.turn.items[1].widgetStateSource;
          entry.turn.messageIds = [USER, CALL, ASSISTANT];
          for (const id of [CALL, RESULT, ASSISTANT]) Object.assign(mapping[id].message.metadata, {
            working_turn_id: 'native-recovered-working', turn_exchange_id: 'native-recovered-exchange',
            parent_id: mapping[id].parent
          });
          mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
            content: [{ type: 'text', text: 'PRIVATE_HISTORICAL_RESULT' }],
            structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } }
          }) };
        } });
      try {
        expect(page.fiber.turns[0].calls[0]).toMatchObject({ requestId: REQUEST, answered: true });
        const owner = (page.exchange as any).__reactFiber$shellfixture;
        const snapshot = owner.memoizedState.memoizedState;
        const earlier = snapshot.renderedTurns[0];
        const nextUser = 'f0f00004-1111-4111-8111-111111111299';
        snapshot.renderedConversation.mapping[nextUser] = { id: nextUser,
          parent: variant === 'foreign successor branch' ? USER : ASSISTANT,
          message: { id: nextUser, author: { role: 'user' }, content: { parts: ['next accepted request'] } } };
        snapshot.renderedConversation.current_node = nextUser;
        snapshot.renderedTurns.push({ id: 'shell-next-turn', conversationId: THREAD,
          turn: { status: 'in_progress', messageIds: [nextUser],
            items: [{ type: 'user-message', messageId: nextUser, serverMessageId: nextUser, message: 'next accepted request' }] } });
        const latest = snapshot.renderedTurns.at(-1), mapping = snapshot.renderedConversation.mapping;
        if (variant === 'unclosed historical turn') earlier.turn.status = 'in_progress';
        if (variant === 'accepted streaming successor') {
          const nextAssistant = 'next-streaming-assistant';
          mapping[nextAssistant] = { id: nextAssistant, parent: nextUser,
            message: { id: nextAssistant, author: { role: 'assistant' }, status: 'in_progress' } };
          snapshot.renderedConversation.current_node = nextAssistant;
          latest.turn.messageIds.push(nextAssistant);
        }
        if (variant === 'foreign successor conversation') latest.conversationId = 'foreign-conversation';
        if (variant === 'missing successor user') latest.turn.items = [];
        if (variant === 'duplicate successor user') latest.turn.items.push({ ...latest.turn.items[0] });
        if (variant === 'unselected successor') latest.turn.messageIds = ['foreign-native-node'];
        if (variant === 'off-branch successor') snapshot.renderedConversation.current_node = ASSISTANT;
        if (variant === 'cyclic successor') mapping[nextUser].parent = nextUser;
        if (variant === 'nonterminal historical final') mapping[ASSISTANT].message.end_turn = false;
        if (variant === 'duplicate historical final') earlier.turn.items.push({ ...earlier.turn.items.at(-1) });
        if (variant === 'missing historical receipt') mapping[RESULT].message.content.text = '{"content":[]}';
        if (variant === 'foreign historical request') mapping[RESULT].message.metadata.request_id = 'foreign-request';
        if (variant === 'nonadjacent historical turn') snapshot.renderedTurns.push({ ...latest, id: 'another-newer-turn' });
        if (variant === 'successor items accessor') Object.defineProperty(latest.turn, 'items', {
          get() { accessorReads++; throw new Error('PRIVATE_SUCCESSOR_ITEMS'); }
        });
        if (variant === 'successor parent accessor') Object.defineProperty(mapping[nextUser], 'parent', {
          get() { accessorReads++; throw new Error('PRIVATE_SUCCESSOR_PARENT'); }
        });
        if (variant === 'conflicting historical cache') owner.memoizedProps.client = queryClient({ ...mapping,
          [RESULT]: { ...mapping[RESULT], message: { ...mapping[RESULT].message,
            metadata: { ...mapping[RESULT].message.metadata, request_id: 'conflicting-cached-request' } } }
        }, {});
        if (['accepted completed chain', 'accepted streaming chain', 'accepted streaming long chain', 'foreign intermediate conversation',
            'unclosed intermediate turn', 'intermediate final mismatch', 'duplicate intermediate user',
            'intermediate parent accessor', 'conflicting intermediate final', 'intermediate selected ids accessor',
    'intermediate selected ids duplicate', 'skipped intermediate final'].includes(variant)) {
          const middleFinal = 'closed-intermediate-final', newestUser = 'newest-chain-user';
          const finalMessage = structuredClone(mapping[ASSISTANT].message);
          finalMessage.id = middleFinal;
          finalMessage.content = { content_type: 'text', parts: ['completed intermediate answer'] };
          finalMessage.metadata.parent_id = nextUser;
          mapping[middleFinal] = { id: middleFinal, parent: nextUser, message: finalMessage };
          latest.turn.status = 'complete';
          latest.turn.messageIds.push(middleFinal);
          latest.turn.items.push({ type: 'assistant-message', messageId: middleFinal,
            phase: 'final_answer', content: 'completed intermediate answer', completed: true });
          mapping[newestUser] = { id: newestUser, parent: middleFinal,
            message: { id: newestUser, author: { role: 'user' }, content: { parts: ['next chain request'] } } };
          snapshot.renderedTurns.push({ id: 'newest-chain-turn', conversationId: THREAD,
            turn: { status: 'in_progress', messageIds: [newestUser],
              items: [{ type: 'user-message', messageId: newestUser, serverMessageId: newestUser,
                message: 'next chain request' }] } });
          snapshot.renderedConversation.current_node = newestUser;
          if (variant === 'accepted completed chain' || variant === 'accepted streaming long chain') {
            const newestFinal = 'newest-chain-final', newest = snapshot.renderedTurns.at(-1);
            const message = structuredClone(finalMessage); message.id = newestFinal;
            message.metadata.parent_id = newestUser;
            mapping[newestFinal] = { id: newestFinal, parent: newestUser, message };
            newest.turn.status = 'complete'; newest.turn.messageIds.push(newestFinal);
            newest.turn.items.push({ type: 'assistant-message', messageId: newestFinal,
              phase: 'final_answer', content: 'completed intermediate answer', completed: true });
            snapshot.renderedConversation.current_node = newestFinal;
          }
          if (variant === 'accepted streaming long chain') {
            const user = 'third-chain-user';
            mapping[user] = { id: user, parent: 'newest-chain-final',
              message: { id: user, author: { role: 'user' }, content: { parts: ['third successor'] } } };
            snapshot.renderedTurns.push({ id: 'third-chain-turn', conversationId: THREAD,
              turn: { status: 'in_progress', messageIds: [user],
                items: [{ type: 'user-message', messageId: user, serverMessageId: user, message: 'third successor' }] } });
            snapshot.renderedConversation.current_node = user;
          }
          if (variant === 'foreign intermediate conversation') latest.conversationId = 'foreign-conversation';
          if (variant === 'unclosed intermediate turn') latest.turn.status = 'in_progress';
          if (variant === 'intermediate final mismatch') latest.turn.items.at(-1).content = 'different intermediate final';
          if (variant === 'duplicate intermediate user') snapshot.renderedTurns.at(-1).turn.items[0].messageId = nextUser;
          if (variant === 'conflicting intermediate final') mapping[middleFinal].message.end_turn = false;
          if (variant === 'intermediate selected ids accessor') Object.defineProperty(snapshot.renderedTurns.at(-1).turn.messageIds, '0', {
            get() { accessorReads++; throw new Error('PRIVATE_INTERMEDIATE_IDS'); }
          });
          if (variant === 'intermediate selected ids duplicate') snapshot.renderedTurns.at(-1).turn.messageIds.push(newestUser);
          if (variant === 'skipped intermediate final') mapping[newestUser].parent = nextUser;
          if (variant === 'intermediate parent accessor') Object.defineProperty(mapping[newestUser], 'parent', {
            get() { accessorReads++; throw new Error('PRIVATE_INTERMEDIATE_PARENT'); }
          });
        }
        const frame = await shellRescan(page, `historical-result-${variant}`);
        if (variant === 'duplicate historical final') {
          // The incumbent typed-shell validator refuses this ambiguity before path recovery.
          expect(frame.turns).toEqual([]);
          expect(accessorReads).toBe(0);
          expect(JSON.stringify(frame)).not.toContain('PRIVATE_HISTORICAL_RESULT');
          return;
        }
        const accepted = variant.startsWith('accepted ');
        expect(frame.turns[0].calls[0]).toMatchObject({ requestId: accepted ? REQUEST : null, answered: accepted });
        expect(frame.turns[0].requests.some((row: any) => row.requestId === REQUEST && row.messageId === CALL)).toBe(accepted);
        // Historical result attribution never turns an older answer into a new terminal or Send ticket.
        expect(frame.turns[0].endMessageId).toBeNull();
        expect(accessorReads).toBe(0);
        expect(JSON.stringify(frame)).not.toContain('PRIVATE_HISTORICAL_RESULT');
      } finally { page.dom.window.close(); }
    });

  it.each(['exact retained sibling', 'retained sibling without user request', 'retained sibling alternate annotations',
    'retained sibling alternate annotations foreign scope', 'missing children',
    'undeclared current header', 'duplicate child', 'missing sibling node', 'foreign sibling parent',
    'foreign sibling working', 'foreign sibling exchange', 'foreign sibling request', 'visible sibling',
    'unfinished sibling', 'rebased sibling', 'ambiguous siblings', 'sibling metadata accessor',
    'children accessor', 'cached sibling conflict', 'cached sibling annotation drift', 'cached user conflict', 'missing result receipt'] as const)(
    'recovers a native Retry namespace only through a unique canonical retained sibling: %s', async variant => {
      const HEADER = 'retry-current-header', PRIOR = 'retry-prior-header';
      const diagnosticLogs: string[] = [];
      let accessorReads = 0;
      const page = await shellHarness({ withCall: true, withExec: true, nativeCallReceipt: true,
        callCompleted: false, assistantCompleted: false, diagnosticLogs,
        nativeCallMutation(mapping, entry) {
          completeExecBeforeCall(mapping, entry);
          entry.turn.items = entry.turn.items.filter((item: any) => item.callId !== EXEC);
          delete entry.turn.items.find((item: any) => item.callId === CALL).widgetStateSource;
          const scope = { request_id: REQUEST, working_turn_id: 'retry-working', turn_exchange_id: 'retry-exchange' };
          mapping[HEADER] = { id: HEADER, parent: USER, message: { id: HEADER, author: { role: 'system' },
            recipient: 'all', status: 'finished_successfully', content: { content_type: 'text', parts: ['PRIVATE_RETRY_HEADER'] },
            metadata: { ...scope, parent_id: 'retired-current-header-parent', is_visually_hidden_from_conversation: true,
              message_type: 'next', rebase_developer_message: false } } };
          mapping[EXEC].parent = HEADER;
          mapping[EXEC].message.metadata.parent_id = 'retired-exec-parent';
          mapping[CALL].parent = EXEC;
          mapping[CALL].message.metadata.parent_id = EXEC;
          mapping[EXEC_RESULT].parent = RESULT;
          mapping[EXEC_RESULT].message.metadata.parent_id = RESULT;
          mapping[ASSISTANT].parent = EXEC_RESULT;
          mapping[ASSISTANT].message.metadata.parent_id = EXEC_RESULT;
          entry.turn.messageIds = [USER, CALL, ASSISTANT];
          for (const [id, row] of Object.entries(mapping) as [string, any][]) if (id !== USER)
            Object.assign(row.message.metadata, scope);
          Object.assign(mapping[USER].message.metadata, { working_turn_id: 'prior-working',
            turn_exchange_id: 'prior-exchange', request_id: 'prior-request' });
          mapping[PRIOR] = { id: PRIOR, parent: USER, message: { id: PRIOR, author: { role: 'system' },
            recipient: 'all', status: 'finished_successfully', metadata: { working_turn_id: 'prior-working',
              turn_exchange_id: 'prior-exchange', request_id: 'prior-request',
              is_visually_hidden_from_conversation: true, message_type: 'next', rebase_developer_message: false } } };
          mapping[USER].children = [PRIOR, HEADER];
          mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
            content: [{ type: 'text', text: 'PRIVATE_RETRY_RESULT' }],
            structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } }
          }) };
          if (variant === 'retained sibling without user request') delete mapping[USER].message.metadata.request_id;
          if (variant.startsWith('retained sibling alternate annotations')) {
            mapping[HEADER].message.metadata.message_type = 'PRIVATE_CURRENT_TRANSPORT_TYPE';
            delete mapping[PRIOR].message.metadata.message_type;
            if (variant.endsWith('foreign scope')) mapping[PRIOR].message.metadata.working_turn_id = 'foreign-working';
          }
          if (variant === 'missing children') delete mapping[USER].children;
          if (variant === 'undeclared current header') mapping[USER].children = [PRIOR];
          if (variant === 'duplicate child') mapping[USER].children.push(PRIOR);
          if (variant === 'missing sibling node') delete mapping[PRIOR];
          if (variant === 'foreign sibling parent') mapping[PRIOR].parent = 'foreign-user';
          if (variant === 'foreign sibling working') mapping[PRIOR].message.metadata.working_turn_id = 'foreign-working';
          if (variant === 'foreign sibling exchange') mapping[PRIOR].message.metadata.turn_exchange_id = 'foreign-exchange';
          if (variant === 'foreign sibling request') mapping[PRIOR].message.metadata.request_id = 'foreign-request';
          if (variant === 'visible sibling') mapping[PRIOR].message.metadata.is_visually_hidden_from_conversation = false;
          if (variant === 'unfinished sibling') mapping[PRIOR].message.status = 'in_progress';
          if (variant === 'rebased sibling') mapping[PRIOR].message.metadata.rebase_developer_message = true;
          if (variant === 'ambiguous siblings') {
            const id = 'second-prior-header';
            mapping[id] = { ...mapping[PRIOR], id, message: { ...mapping[PRIOR].message, id } };
            mapping[USER].children.push(id);
          }
          if (variant === 'sibling metadata accessor') Object.defineProperty(mapping[PRIOR].message.metadata, 'working_turn_id', {
            get() { accessorReads++; throw new Error('PRIVATE_RETRY_METADATA'); }
          });
          if (variant === 'children accessor') Object.defineProperty(mapping[USER], 'children', {
            get() { accessorReads++; throw new Error('PRIVATE_RETRY_CHILDREN'); }
          });
          if (variant === 'missing result receipt') mapping[RESULT].message.content.text = '{"content":[]}';
        } });
      try {
        let frame = page.fiber;
        if (variant === 'cached sibling conflict' || variant === 'cached sibling annotation drift' || variant === 'cached user conflict') {
          const owner = (page.exchange as any).__reactFiber$shellfixture;
          const mapping = owner.memoizedState.memoizedState.renderedConversation.mapping;
          const id = variant === 'cached sibling conflict' ? PRIOR : USER;
          owner.memoizedProps.client = queryClient({ ...mapping, [id]: { ...mapping[id],
            message: { ...mapping[id].message, metadata: { ...mapping[id].message.metadata,
              ...(variant === 'cached sibling annotation drift' ? { message_type: 'PRIVATE_CACHED_TRANSPORT_TYPE' }
                : { working_turn_id: 'cached-foreign' }) } }
          } }, {});
          frame = await shellRescan(page, `retry-sibling-${variant}`);
        }
        const accepted = variant === 'exact retained sibling' || variant === 'retained sibling without user request' ||
          variant === 'retained sibling alternate annotations' || variant === 'cached sibling annotation drift';
        const identityOnly = variant === 'missing result receipt';
        expect(frame.turns[0].calls[0]).toMatchObject({ requestId: accepted || identityOnly ? REQUEST : null, answered: accepted });
        expect(frame.turns[0].requests.some((row: any) => row.requestId === REQUEST && row.messageId === EXEC)).toBe(accepted || identityOnly);
        if (accepted || identityOnly) expect(frame.turns[0].requests.filter((row: any) => row.requestId === REQUEST))
          .toEqual([expect.objectContaining({ messageId: EXEC })]);
        expect(frame.turns[0].endMessageId).toBe(accepted ? ASSISTANT : null);
        expect(accessorReads).toBe(0);
        expect(JSON.stringify(frame)).not.toContain('PRIVATE_RETRY');
        for (const value of [USER, REQUEST, PRIOR, HEADER, 'prior-working', 'retry-working', 'PRIVATE_RETRY'])
          expect(diagnosticLogs.join('\n')).not.toContain(value);
      } finally { page.dom.window.close(); }
    });

  it.each(['direct Core', 'direct Core wrong parent', 'direct Core missing receipt', 'direct Core missing receipt wrong parent', 'direct Core missing receipt foreign resource', 'direct Core foreign resource', 'exact canonical group', 'exact final reference', 'foreign final pointer', 'foreign final reference',
    'multiple final references', 'getter final reference', 'unfinished native final reference',
    'duplicate final pointer source', 'missing final reference preview',
    'duplicate final anchor', 'off-path final anchor', 'nonterminal final anchor', 'different final body anchor',
    'orphan execution result', 'execution result request mismatch', 'execution child result missing', 'execution child result extra',
    'pending canonical group', 'pending direct Core', 'pending direct Core foreign header', 'pending header mismatch', 'missing system header', 'visible system header', 'foreign header scope',
    'missing header working', 'missing header exchange', 'user header scope mismatch', 'header recipient',
    'header unfinished', 'header message type', 'header annotation absent', 'header annotation null',
    'header annotation accessor', 'pending header annotation', 'header annotation foreign scope',
    'header annotation missing receipt', 'header rebase flag', 'header rebase accessor',
    'unfinished execution', 'unfinished execution result', 'foreign retained parent',
    'exact retained commentary parent', 'exact retained execution commentary parent', 'exact retained commentary image result',
    'exact retained header parent', 'retained header transport annotation', 'retained header transport annotation foreign scope',
    'retained header missing children', 'retained header duplicate child',
    'retained header foreign user', 'retained header foreign working', 'retained header foreign exchange',
    'retained header foreign request', 'retained header visible', 'retained header unfinished',
    'retained header rebase', 'retained header accessor', 'retained header cache conflict', 'retained header missing receipt',
    'retained commentary foreign request', 'retained commentary foreign working',
    'retained commentary foreign exchange', 'retained commentary wrong parent', 'retained commentary wrong metadata parent',
    'retained commentary unfinished', 'retained commentary terminal', 'retained commentary tool',
    'retained commentary accessor', 'retained commentary cached conflict', 'retained commentary missing receipt',
    'core receipt missing', 'core receipt missing referenced widget', 'core resource foreign', 'core request foreign', 'core request and receipt foreign',
    'missing terminal exact user', 'missing terminal unscoped user', 'missing terminal foreign branch', 'missing terminal hidden final',
    'missing receipt late namespace', 'missing receipt late parent', 'missing receipt duplicate result',
    'missing receipt foreign resource', 'missing receipt late cache',
    'missing retained header parent', 'missing retained execution parent', 'off-path retained parent', 'later retained parent', 'cached conflict',
    'unselected call', 'missing live branch', 'system accessor'] as const)(
    'recovers folded native execution ownership from an exact provider group: %s', async variant => {
      let getterReads = 0;
      let observedMapping: any;
      const diagnosticLogs: string[] = [];
      const HEADER = 'native-group-header';
      const page = await shellHarness({ withCall: true, withExec: true, nativeCallReceipt: true,
        diagnosticLogs,
        status: variant.startsWith('pending ') ? 'in_progress' : 'complete',
        nativeCurrentNode: variant.startsWith('pending ') ? CALL :
          variant.startsWith('missing terminal ') && variant !== 'missing terminal hidden final' ? EXEC_RESULT : ASSISTANT,
        nativeCallLive: variant !== 'missing live branch', nativeCallCacheConflict: variant === 'cached conflict' ||
          variant === 'retained commentary cached conflict' || variant === 'retained header cache conflict' || variant === 'missing receipt late cache',
        callCompleted: false, assistantCompleted: false,
        nativeCallMutation(mapping, entry) {
          observedMapping = mapping;
          completeExecBeforeCall(mapping, entry);
          entry.turn.items = entry.turn.items.filter((item: any) => item.callId !== EXEC);
          if (variant !== 'core receipt missing referenced widget')
            delete entry.turn.items.find((item: any) => item.callId === CALL).widgetStateSource;
          const scope = { request_id: REQUEST, working_turn_id: 'native-group-working', turn_exchange_id: 'native-group-exchange' };
          mapping[HEADER] = { id: HEADER, parent: USER, message: { id: HEADER, author: { role: 'system' },
            recipient: 'all', status: 'finished_successfully', content: { content_type: 'text', parts: ['PRIVATE_SYSTEM_TEXT'] },
            metadata: { ...scope, parent_id: 'retired-header-parent', is_visually_hidden_from_conversation: true,
              message_type: 'next', rebase_developer_message: false } } };
          mapping[EXEC].parent = HEADER;
          mapping[EXEC].message.metadata.parent_id = 'retired-exec-parent';
          mapping[CALL].parent = EXEC;
          mapping[CALL].message.metadata.parent_id = EXEC;
          mapping[EXEC_RESULT].parent = RESULT;
          mapping[EXEC_RESULT].message.metadata.parent_id = RESULT;
          mapping[ASSISTANT].parent = EXEC_RESULT;
          mapping[ASSISTANT].message.metadata.parent_id = EXEC_RESULT;
          entry.turn.messageIds = [USER, CALL, ASSISTANT];
          for (const [id, row] of Object.entries(mapping) as [string, any][]) if (id !== USER)
            Object.assign(row.message.metadata, scope);
          if (variant.startsWith('missing terminal ')) {
            entry.turn.items = entry.turn.items.filter((item: any) => item.messageId !== ASSISTANT);
            entry.turn.messageIds = [USER, CALL];
            if (variant !== 'missing terminal unscoped user') Object.assign(mapping[USER].message.metadata, scope);
            if (variant === 'missing terminal foreign branch') mapping[EXEC_RESULT].message.metadata.turn_exchange_id = 'foreign';
            if (variant === 'missing terminal hidden final') {
              mapping[ASSISTANT].message.channel = 'final';
              mapping[ASSISTANT].message.end_turn = true;
            }
          }
          mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
            content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }],
            structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } } }) };
          if (variant.includes('direct Core')) {
            mapping[CALL].parent = HEADER;
            mapping[CALL].message.metadata.parent_id = HEADER;
            mapping[ASSISTANT].parent = RESULT;
            mapping[ASSISTANT].message.metadata.parent_id = RESULT;
            delete mapping[EXEC];
            delete mapping[EXEC_RESULT];
            if (variant === 'direct Core wrong parent' || variant === 'direct Core missing receipt wrong parent') mapping[RESULT].message.metadata.parent_id = HEADER;
            if (variant.startsWith('direct Core missing receipt')) mapping[RESULT].message.content.text = '{"content":[]}';
            if (variant === 'direct Core foreign resource' || variant === 'direct Core missing receipt foreign resource') mapping[RESULT].message.metadata.invoked_resource.resource_uri = `/${ASDK}/link_foreign/read`;
          }
          if (variant.startsWith('core receipt missing') || variant.startsWith('missing receipt ') || variant === 'core request and receipt foreign')
            mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: '{"content":[]}' };
          if (variant === 'core resource foreign' || variant === 'missing receipt foreign resource')
            mapping[RESULT].message.metadata.invoked_resource.app_name = 'PRIVATE_FOREIGN_RESULT_APP';
          if (variant === 'missing receipt late namespace') mapping[EXEC_RESULT].message.metadata.working_turn_id = 'foreign';
          if (variant === 'missing receipt late parent') mapping[EXEC_RESULT].message.metadata.parent_id = USER;
          if (variant === 'core receipt missing referenced widget') entry.turn.messageIds.push(RESULT);
          if (variant === 'core request foreign' || variant === 'core request and receipt foreign')
            mapping[RESULT].message.metadata.request_id = 'PRIVATE_OTHER_CORE_REQUEST';
          if (variant.startsWith('pending ')) { entry.turn.messageIds = [USER, CALL]; mapping[CALL].message.status = 'in_progress'; }
          if (variant === 'pending header mismatch' || variant === 'pending direct Core foreign header') mapping[HEADER].message.metadata.working_turn_id = 'foreign';
          if (variant === 'missing system header') { mapping[EXEC].parent = USER; delete mapping[HEADER]; }
          if (variant === 'visible system header') mapping[HEADER].message.metadata.is_visually_hidden_from_conversation = false;
          if (variant === 'foreign header scope') mapping[HEADER].message.metadata.working_turn_id = 'foreign';
          if (variant === 'missing header working') delete mapping[HEADER].message.metadata.working_turn_id;
          if (variant === 'missing header exchange') delete mapping[HEADER].message.metadata.turn_exchange_id;
          if (variant === 'user header scope mismatch') Object.assign(mapping[USER].message.metadata, {
            working_turn_id: 'PRIVATE_OTHER_USER_SCOPE', turn_exchange_id: 'PRIVATE_OTHER_USER_EXCHANGE' });
          if (variant === 'header recipient') mapping[HEADER].message.recipient = 'PRIVATE_HEADER_RECIPIENT';
          if (variant === 'header unfinished') mapping[HEADER].message.status = 'in_progress';
          if (variant === 'header message type') mapping[HEADER].message.metadata.message_type = 'PRIVATE_HEADER_TYPE';
          if (variant === 'header annotation absent') delete mapping[HEADER].message.metadata.message_type;
          if (variant === 'header annotation null') mapping[HEADER].message.metadata.message_type = null;
          if (variant === 'header annotation accessor') Object.defineProperty(mapping[HEADER].message.metadata, 'message_type', {
            get() { getterReads++; throw new Error('PRIVATE_HEADER_TYPE_GETTER'); } });
          if (variant === 'pending header annotation' || variant === 'header annotation foreign scope' || variant === 'header annotation missing receipt')
            mapping[HEADER].message.metadata.message_type = 'PRIVATE_HEADER_TYPE';
          if (variant === 'header annotation foreign scope') mapping[HEADER].message.metadata.working_turn_id = 'foreign';
          if (variant === 'header annotation missing receipt') mapping[RESULT].message.content.text = '{"content":[]}';
          if (variant === 'header rebase flag') mapping[HEADER].message.metadata.rebase_developer_message = true;
          if (variant === 'header rebase accessor') Object.defineProperty(mapping[HEADER].message.metadata, 'rebase_developer_message', {
            get() { getterReads++; throw new Error('PRIVATE_HEADER_REBASE_GETTER'); } });
          if (variant === 'unfinished execution') mapping[EXEC].message.status = 'in_progress';
          if (variant === 'unfinished execution result') mapping[EXEC_RESULT].message.status = 'in_progress';
          if (variant === 'exact retained header parent' || variant.startsWith('retained header ')) {
            const retained = 'PRIVATE_RETAINED_HEADER';
            Object.assign(mapping[USER].message.metadata, scope);
            mapping[USER].children = [HEADER, retained];
            mapping[retained] = { id: retained, parent: USER, message: { id: retained,
              author: { role: 'system' }, recipient: 'all', status: 'finished_successfully',
              content: { content_type: 'text', parts: ['PRIVATE_RETAINED_HEADER_TEXT'] },
              metadata: { ...scope, parent_id: USER, is_visually_hidden_from_conversation: true,
                message_type: 'next', rebase_developer_message: false } } };
            mapping[HEADER].message.metadata.parent_id = retained;
            if (variant.startsWith('retained header transport annotation')) {
              delete mapping[HEADER].message.metadata.message_type;
              mapping[retained].message.metadata.message_type = 'PRIVATE_RETAINED_TRANSPORT_TYPE';
              if (variant.endsWith('foreign scope')) mapping[retained].message.metadata.working_turn_id = 'foreign';
            }
            if (variant === 'retained header missing children') delete mapping[USER].children;
            if (variant === 'retained header duplicate child') mapping[USER].children.push(retained);
            if (variant === 'retained header foreign user') mapping[retained].parent = 'foreign-user';
            if (variant === 'retained header foreign working') mapping[retained].message.metadata.working_turn_id = 'foreign';
            if (variant === 'retained header foreign exchange') mapping[retained].message.metadata.turn_exchange_id = 'foreign';
            if (variant === 'retained header foreign request') mapping[retained].message.metadata.request_id = 'foreign';
            if (variant === 'retained header visible') mapping[retained].message.metadata.is_visually_hidden_from_conversation = false;
            if (variant === 'retained header unfinished') mapping[retained].message.status = 'in_progress';
            if (variant === 'retained header rebase') mapping[retained].message.metadata.rebase_developer_message = true;
            if (variant === 'retained header accessor') Object.defineProperty(mapping[retained].message.metadata, 'rebase_developer_message', {
              get() { getterReads++; throw new Error('PRIVATE_RETAINED_HEADER_GETTER'); } });
            if (variant === 'retained header missing receipt')
              mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: '{"content":[]}' };
          }
          if (variant === 'foreign retained parent') mapping[EXEC].message.metadata.parent_id = USER;
          if (variant === 'missing retained header parent') delete mapping[HEADER].message.metadata.parent_id;
          if (variant === 'missing retained execution parent') {
            mapping[EXEC].message.metadata.parent_id = '';
            // A later conflicting edge must not replace the first refusal shape.
            mapping[CALL].message.metadata.parent_id = USER;
          }
          if (variant === 'off-path retained parent') {
            mapping.PRIVATE_RETAINED_BRANCH = { id: 'PRIVATE_RETAINED_BRANCH', parent: USER,
              message: { id: 'PRIVATE_RETAINED_BRANCH', author: { role: 'assistant' }, recipient: 'all',
                status: 'finished_successfully', metadata: { ...scope, parent_id: USER },
                content: { content_type: 'text', parts: ['PRIVATE_RETAINED_BRANCH_TEXT'] } } };
            mapping[EXEC].message.metadata.parent_id = 'PRIVATE_RETAINED_BRANCH';
          }
          if (variant === 'later retained parent') mapping[CALL].message.metadata.parent_id = USER;
          if (variant === 'exact retained commentary parent' || variant === 'exact retained execution commentary parent' ||
              variant === 'exact retained commentary image result' ||
              variant.startsWith('retained commentary ')) {
            const retained = 'PRIVATE_RETAINED_COMMENTARY';
            const target = variant === 'exact retained execution commentary parent' ? EXEC : CALL;
            const parent = mapping[target].parent;
            mapping[retained] = { id: retained, parent, message: { id: retained,
              author: { role: 'assistant' }, recipient: 'all', channel: 'commentary',
              status: 'finished_successfully', end_turn: false,
              content: { content_type: 'text', parts: ['PRIVATE_RETAINED_COMMENTARY_TEXT'] },
              metadata: { ...scope, parent_id: parent } } };
            mapping[target].message.metadata.parent_id = retained;
            if (variant === 'retained commentary foreign request') mapping[retained].message.metadata.request_id = 'foreign';
            if (variant === 'retained commentary foreign working') mapping[retained].message.metadata.working_turn_id = 'foreign';
            if (variant === 'retained commentary foreign exchange') mapping[retained].message.metadata.turn_exchange_id = 'foreign';
            if (variant === 'retained commentary wrong parent') mapping[retained].parent = USER;
            if (variant === 'retained commentary wrong metadata parent') mapping[retained].message.metadata.parent_id = USER;
            if (variant === 'retained commentary unfinished') mapping[retained].message.status = 'in_progress';
            if (variant === 'retained commentary terminal') mapping[retained].message.end_turn = true;
            if (variant === 'retained commentary tool') mapping[retained].message.recipient = 'functions.exec';
            if (variant === 'retained commentary accessor') Object.defineProperty(mapping[retained].message, 'end_turn', {
              get() { getterReads++; throw new Error('PRIVATE_RETAINED_COMMENTARY_GETTER'); } });
            if (variant === 'retained commentary missing receipt')
              mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: '{"content":[]}' };
            if (variant === 'exact retained commentary image result') mapping[RESULT].message.content = {
              content_type: 'multimodal_text', parts: ['Structured tool output: ' + JSON.stringify({ cosResultReceipt: {
                version: 2, id: 'a'.repeat(48),
                invocationSha256: createHash('sha256').update(JSON.stringify(['read', {}])).digest('hex')
              } }), { content_type: 'image_asset_pointer', asset_pointer: 'PRIVATE_IMAGE_ASSET' }] };
          }
          if (variant === 'unselected call') entry.turn.messageIds = [USER, ASSISTANT];
          if (variant === 'system accessor') Object.defineProperty(mapping[HEADER].message.metadata,
            'is_visually_hidden_from_conversation', { get() { getterReads++; throw new Error('PRIVATE_SYSTEM_GETTER'); } });
          if (variant === 'duplicate final anchor') entry.turn.items.push({ type: 'assistant-message',
            messageId: RESULT, phase: 'final_answer', content: 'PRIVATE_DUPLICATE_FINAL', completed: false });
          if (variant === 'off-path final anchor') entry.turn.items.at(-1).messageId = RESULT;
          if (variant === 'nonterminal final anchor') mapping[ASSISTANT].message.status = 'in_progress';
          if (variant === 'different final body anchor') entry.turn.items.at(-1).content = 'PRIVATE_DIFFERENT_FINAL';
          if (variant === 'orphan execution result') {
            const orphan = 'PRIVATE_ORPHAN_EXEC_RESULT';
            mapping[orphan] = { id: orphan, parent: HEADER, message: { id: orphan,
              author: { role: 'tool', name: 'functions.exec' }, recipient: 'all', status: 'finished_successfully',
              metadata: { ...scope, parent_id: HEADER } } };
            mapping[EXEC].parent = orphan;
          }
          if (variant === 'execution result request mismatch')
            mapping[EXEC_RESULT].message.metadata.request_id = 'PRIVATE_OTHER_EXEC_REQUEST';
          if (variant === 'execution child result missing') {
            delete mapping[RESULT];
            mapping[EXEC_RESULT].parent = CALL;
            mapping[EXEC_RESULT].message.metadata.parent_id = CALL;
          }
          if (variant === 'execution child result extra' || variant === 'missing receipt duplicate result') {
            const extra = 'PRIVATE_EXTRA_CORE_RESULT';
            mapping[extra] = JSON.parse(JSON.stringify(mapping[RESULT]));
            mapping[extra].id = extra;
            mapping[extra].message.id = extra;
            mapping[extra].parent = RESULT;
            mapping[extra].message.metadata.parent_id = RESULT;
            mapping[extra].message.content.text = mapping[extra].message.content.text.replace('a'.repeat(48), 'b'.repeat(48));
            mapping[EXEC_RESULT].parent = extra;
            mapping[EXEC_RESULT].message.metadata.parent_id = extra;
          }
          if (variant.includes('final reference') || variant === 'foreign final pointer' || variant === 'duplicate final pointer source') {
            const final = entry.turn.items.find((item: any) => item.messageId === ASSISTANT);
            final.completed = true;
            final.content = `::chatgpt-content-reference{source_message_id="${variant === 'foreign final pointer' ? 'foreign-final' : ASSISTANT}"}`;
            final.contentReferences = [{ type: 'dil', source_message_id: variant === 'foreign final reference' ? 'foreign-final' : ASSISTANT,
              model_dil_v2: { fallbackMarkdown: 'Rendered final preview differs from the native authored body.' } }];
            if (variant === 'multiple final references') final.contentReferences.push({ ...final.contentReferences[0] });
            if (variant === 'duplicate final pointer source') final.content = `::chatgpt-content-reference{source_message_id="${ASSISTANT}" source_message_id="foreign-final"}`;
            if (variant === 'missing final reference preview') delete final.contentReferences[0].model_dil_v2.fallbackMarkdown;
            if (variant === 'getter final reference') Object.defineProperty(final.contentReferences[0], 'source_message_id',
              { get() { getterReads++; throw new Error('PRIVATE_FINAL_REFERENCE_GETTER'); } });
            if (variant === 'unfinished native final reference') mapping[ASSISTANT].message.status = 'in_progress';
          }
        } });
      try {
        const accepted = variant === 'direct Core' || variant === 'exact canonical group' || variant === 'exact final reference' ||
          variant === 'exact retained commentary parent' || variant === 'exact retained execution commentary parent' ||
          variant === 'exact retained commentary image result' || variant === 'exact retained header parent' ||
          variant === 'retained header transport annotation' ||
          ['header message type', 'header annotation absent', 'header annotation null', 'header annotation accessor'].includes(variant);
        const identityOnly = variant === 'direct Core missing receipt' || variant.startsWith('core receipt missing') ||
          variant === 'retained commentary missing receipt' || variant === 'retained header missing receipt' ||
          variant === 'missing terminal exact user' || variant === 'header annotation missing receipt';
        expect(page.fiber.turns[0].calls[0]).toMatchObject({
          requestId: accepted || identityOnly || ['pending canonical group', 'pending direct Core', 'pending header annotation'].includes(variant) ? REQUEST : null, answered: accepted });
        if (accepted || identityOnly || ['pending canonical group', 'pending direct Core', 'pending header annotation'].includes(variant))
          expect(page.fiber.turns[0].requests.filter((row: any) => row.requestId === REQUEST))
            .toEqual([expect.objectContaining({ messageId: variant.includes('direct Core') ? CALL : EXEC })]);
        if (variant.startsWith('missing terminal ')) {
          expect(page.fiber.turns[0].endMessageId).toBeNull();
          expect(page.fiber.turns[0].calls[0].resultReceiptId).toBeUndefined();
        }
        if (variant.includes('direct Core')) {
          const turn = page.fiber.turns[0];
          expect(turn.calls[0].resultReceiptId).toBe(accepted ? 'a'.repeat(48) : undefined);
          expect(turn.endMessageId).toBe(accepted ? ASSISTANT : null);
          const rescanned = await shellRescan(page, 'same-direct-call-after-hydration');
          expect(rescanned.turns[0].calls).toEqual(turn.calls);
        }
        const headerFacets: Record<string, string> = {
          'missing header working': 'working-missing', 'missing header exchange': 'exchange-missing',
          'user header scope mismatch': 'user-scope', 'header recipient': 'recipient', 'header unfinished': 'status',
          'visible system header': 'visible',
          'header rebase flag': 'rebase', 'header rebase accessor': 'rebase'
        };
        const headerFacet = headerFacets[variant];
        if (headerFacet) {
          const diagnosticKey = 'nativeHeader' + headerFacet.split('-')
            .map(part => part[0]!.toUpperCase() + part.slice(1)).join('');
          expect(page.fiber.shellScan.reader.fiberProducer).toBeGreaterThanOrEqual(171);
          expect(page.fiber.shellScan.rejects.nativeBranchHeaderShape).toBe(1);
          expect(page.fiber.shellScan.rejects[diagnosticKey]).toBe(1);
          if (variant === 'header rebase flag') expect(page.fiber.shellScan.rejects.nativeHeaderValueTrue).toBe(1);
          if (variant === 'header rebase accessor') expect(page.fiber.shellScan.rejects.nativeHeaderValueAccessor).toBe(1);
          const trace = diagnosticLogs.find(line => line.includes('native result-reference recovery diagnostic'))!;
          expect(trace).toContain('anchorBranch=header-shape');
          expect(trace).toContain(`anchorHeaderFacet=${headerFacet}`);
          expect(JSON.stringify(page.fiber)).not.toContain('anchorHeaderFacet');
          for (const value of [USER, HEADER, 'PRIVATE_OTHER_USER_SCOPE', 'PRIVATE_OTHER_USER_EXCHANGE',
            'PRIVATE_HEADER_RECIPIENT', 'PRIVATE_HEADER_TYPE', 'PRIVATE_HEADER_REBASE_GETTER']) expect(trace).not.toContain(value);
        }
        if (variant.startsWith('core ') && variant !== 'core receipt missing referenced widget') {
          const facet = variant.startsWith('core request') ? 'request' : variant.startsWith('core receipt missing') ? 'receipt' : 'resource';
          const trace = diagnosticLogs.find(line => line.includes('native result-reference recovery diagnostic'))!;
          expect(trace).toContain('anchorBranch=core-result');
          expect(trace).toContain(`anchorCoreResultFacet=${facet}`);
          expect(page.fiber.turns[0].endMessageId).toBeNull();
          expect(page.fiber.turns[0].calls[0]).toMatchObject({ requestId: identityOnly ? REQUEST : null, answered: false });
          for (const value of [USER, ASSISTANT, CALL, RESULT, REQUEST, EXEC, EXEC_RESULT, HEADER,
            'PRIVATE_TOOL_RESULT', 'PRIVATE_OTHER_CORE_REQUEST', 'PRIVATE_FOREIGN_RESULT_APP'])
            expect(trace).not.toContain(value);
          expect(JSON.stringify(page.fiber)).not.toContain('anchorCoreResultFacet');
        }
        if (variant.endsWith('final anchor') || variant === 'different final body anchor') {
          const facet = variant === 'duplicate final anchor' ? 'final-count' : variant === 'off-path final anchor'
            ? 'path-tail' : variant === 'nonterminal final anchor' ? 'native-terminal' : 'body-or-reference';
          const trace = diagnosticLogs.find(line => line.includes('native result-reference recovery diagnostic'))!;
          expect(trace).toContain('anchorReason=nativeScopeFinalReceiptUnproved');
          expect(trace).toContain(`anchorFinalFacet=${facet}`);
          expect(page.fiber.turns[0].endMessageId).toBeNull();
          for (const value of [USER, ASSISTANT, CALL, RESULT, REQUEST, EXEC, 'PRIVATE_DUPLICATE_FINAL',
            'PRIVATE_DIFFERENT_FINAL', 'PRIVATE_SYSTEM_TEXT', 'native-group-working', 'native-group-exchange'])
            expect(trace).not.toContain(value);
        }
        if (['orphan execution result', 'execution result request mismatch', 'execution child result missing', 'execution child result extra'].includes(variant)) {
          const branch = variant === 'orphan execution result' ? 'execution-result-no-owner'
            : variant.startsWith('execution child result ') ? 'execution-result-child-count' : 'execution-result-request';
          const trace = diagnosticLogs.find(line => line.includes('native result-reference recovery diagnostic'))!;
          expect(trace).toContain('anchorReason=nativeScopeBranchConflict');
          expect(trace).toContain(`anchorBranch=${branch}`);
          if (variant.startsWith('execution child result ')) {
            expect(trace).toContain('anchorExecutionCalls=1');
            expect(trace).toContain(`anchorExecutionResults=${variant.endsWith('missing') ? 0 : 2}`);
            expect(trace).toContain(`anchorExecutionBalance=${variant.endsWith('missing') ? 'missing-results' : 'extra-results'}`);
            expect(page.fiber.shellScan.rejects).toMatchObject({
              nativeExecutionCalls: 1,
              nativeExecutionResults: variant.endsWith('missing') ? 0 : 2,
              [variant.endsWith('missing') ? 'nativeExecutionMissingResults' : 'nativeExecutionExtraResults']: 1
            });
            expect(JSON.stringify(page.fiber)).not.toContain('anchorExecution');
            const before = diagnosticLogs.length;
            await shellRescan(page, 'same-child-count-refusal');
            expect(diagnosticLogs).toHaveLength(before);
          }
          expect(page.fiber.turns[0].requests).not.toContainEqual(expect.objectContaining({ requestId: REQUEST, messageId: CALL }));
          expect(page.fiber.turns[0].endMessageId).toBeNull();
          for (const value of [USER, ASSISTANT, CALL, RESULT, REQUEST, EXEC, EXEC_RESULT,
            'PRIVATE_ORPHAN_EXEC_RESULT', 'PRIVATE_OTHER_EXEC_REQUEST', 'PRIVATE_EXTRA_CORE_RESULT'])
            expect(trace).not.toContain(value);
        }
        if (['foreign retained parent', 'missing retained header parent', 'missing retained execution parent',
          'off-path retained parent', 'later retained parent'].includes(variant)) {
          const missing = variant.startsWith('missing retained');
          const header = variant === 'missing retained header parent';
          const later = variant === 'later retained parent';
          const trace = diagnosticLogs.find(line => line.includes('native result-reference recovery diagnostic'))!;
          expect(trace).toContain('anchorReason=nativeScopeBranchConflict');
          expect(trace).toContain('anchorBranch=group-retained-parent');
          expect(trace).toContain(`anchorRetainedParent=${missing ? 'missing' : 'conflict'}`);
          expect(trace).toContain(`anchorRetainedMember=${header ? 'header' : later ? 'core-call' : 'code-call'}`);
          expect(trace).toContain(`anchorRetainedPosition=${header ? 'header' : later ? 'later-member' : 'first-member'}`);
          expect(trace).toContain(`anchorRetainedLocation=${missing ? 'none' : variant === 'off-path retained parent' ? 'off-path' : 'on-path'}`);
          const counters = page.fiber.shellScan.rejects;
          expect(counters[missing ? 'nativeRetainedParentMissing' : 'nativeRetainedParentConflict']).toBe(1);
          expect(counters[header ? 'nativeRetainedPositionHeader' : later ? 'nativeRetainedPositionLaterMember' : 'nativeRetainedPositionFirstMember']).toBe(1);
          expect(counters[header ? 'nativeRetainedMemberHeader' : later ? 'nativeRetainedMemberCoreCall' : 'nativeRetainedMemberCodeCall']).toBe(1);
          expect(counters[missing ? 'nativeRetainedLocationNone' : variant === 'off-path retained parent' ? 'nativeRetainedLocationOffPath' : 'nativeRetainedLocationOnPath']).toBe(1);
          expect(page.fiber.turns[0].requests).not.toContainEqual(expect.objectContaining({ requestId: REQUEST, messageId: CALL }));
          expect(page.fiber.turns[0].endMessageId).toBeNull();
          for (const value of [USER, ASSISTANT, CALL, RESULT, REQUEST, EXEC, EXEC_RESULT, HEADER,
            'PRIVATE_RETAINED_BRANCH', 'PRIVATE_RETAINED_BRANCH_TEXT', 'PRIVATE_SYSTEM_TEXT',
            'native-group-working', 'native-group-exchange', 'retired-header-parent', 'retired-exec-parent'])
            expect(trace).not.toContain(value);
        }
        expect(getterReads).toBe(0);
        expect(JSON.stringify(page.fiber)).not.toContain('anchorRetained');
        expect(JSON.stringify(page.fiber)).not.toMatch(/PRIVATE_SYSTEM_TEXT|PRIVATE_SYSTEM_GETTER|retired-header-parent|retired-exec-parent|PRIVATE_RETAINED_COMMENTARY|PRIVATE_RETAINED_HEADER/);
        if (identityOnly && variant !== 'missing terminal exact user') {
          // Request ownership survives result hydration. It is not completion:
          // no result witness or terminal may be invented before the real receipt.
          expect(page.fiber.turns[0].endMessageId).toBeNull();
          expect(page.fiber.turns[0].calls[0].resultReceiptId).toBeUndefined();
          observedMapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
            content: [],
            structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } } }) };
          const hydrated = await shellRescan(page, 'exact-receipt-hydrated');
          expect(hydrated.turns[0].calls).toHaveLength(1);
          expect(hydrated.turns[0].calls[0]).toMatchObject({ messageId: CALL, requestId: REQUEST,
            answered: true, resultReceiptId: 'a'.repeat(48) });
          expect(hydrated.turns[0].requests.filter((row: any) => row.requestId === REQUEST))
            .toEqual([expect.objectContaining({ messageId: variant.includes('direct Core') ? CALL : EXEC })]);
        }
      } finally { page.dom.window.close(); }
    });

  it.each(['exact reordered batch', 'referenced final batch', 'referenced final legacy batch', 'wrong invocation digest', 'duplicate argument owners', 'legacy batch receipts',
    'foreign result resource', 'pending result', 'duplicate receipt token', 'source changes while hashing', 'arguments change while hashing'] as const)(
    'binds serialized repeated-tool results only by committed invocation proof: %s', async variant => {
      const HEADER = 'proof-header', CALL2 = 'proof-call-two', RESULT2 = 'proof-result-two';
      let liveMapping: any, mutated = false;
      const digest = (file: string) => createHash('sha256').update(JSON.stringify(['read', { paths: [file] }])).digest('hex');
      const receipt = (id: string, hash: string) => JSON.stringify({ content: [{ type: 'text', text: 'PRIVATE_RESULT' }],
        structuredContent: { cosResultReceipt: variant === 'legacy batch receipts' || variant === 'referenced final legacy batch' ? { version: 1, id }
          : { version: 2, id, invocationSha256: hash } } });
      const page = await shellHarness({ withCall: true, withExec: true, nativeCallReceipt: true,
        callCompleted: false, assistantCompleted: false,
        nativeDigestSettled() {
          if (mutated) return; mutated = true;
          if (variant === 'source changes while hashing') liveMapping[HEADER].message.metadata.working_turn_id = 'foreign';
          if (variant === 'arguments change while hashing') liveMapping[CALL].message.metadata.connector_tool_payload = JSON.stringify({ paths: ['changed'] });
        },
        nativeCallMutation(mapping, entry) {
          liveMapping = mapping;
          completeExecBeforeCall(mapping, entry);
          entry.turn.items = entry.turn.items.filter((item: any) => item.callId !== EXEC);
          const call = entry.turn.items.find((item: any) => item.callId === CALL);
          delete call.widgetStateSource;
          entry.turn.items.splice(2, 0, { ...call, callId: CALL2 });
          const scope = { request_id: REQUEST, working_turn_id: 'proof-working', turn_exchange_id: 'proof-exchange' };
          mapping[HEADER] = { id: HEADER, parent: USER, message: { id: HEADER, author: { role: 'system' }, recipient: 'all',
            status: 'finished_successfully', metadata: { ...scope, parent_id: 'retired-header',
              is_visually_hidden_from_conversation: true, message_type: 'next', rebase_developer_message: false } } };
          mapping[EXEC].parent = HEADER; mapping[EXEC].message.metadata.parent_id = 'retired-execution';
          mapping[CALL].parent = EXEC; mapping[CALL].message.metadata.parent_id = EXEC;
          mapping[CALL].message.metadata.connector_tool_payload = JSON.stringify({ paths: ['one'] });
          mapping[CALL2] = { id: CALL2, parent: CALL, message: { ...mapping[CALL].message, id: CALL2,
            metadata: { ...scope, parent_id: CALL, connector_tool_payload: JSON.stringify({ paths: [variant === 'duplicate argument owners' ? 'one' : 'two'] }) } } };
          mapping[RESULT].parent = CALL2;
          mapping[RESULT].message.metadata.parent_id = CALL2;
          mapping[RESULT].message.content = { content_type: 'code', language: 'json',
            text: receipt('a'.repeat(48), variant === 'wrong invocation digest' ? 'f'.repeat(64) : digest('one')) };
          mapping[RESULT2] = { id: RESULT2, parent: RESULT, message: { ...mapping[RESULT].message, id: RESULT2,
            metadata: { ...mapping[RESULT].message.metadata, parent_id: RESULT },
            content: { content_type: 'code', language: 'json', text: receipt(variant === 'duplicate receipt token' ? 'a'.repeat(48) : 'b'.repeat(48), digest('two')) } } };
          mapping[EXEC_RESULT].parent = RESULT2; mapping[EXEC_RESULT].message.metadata.parent_id = RESULT2;
          mapping[ASSISTANT].parent = EXEC_RESULT; mapping[ASSISTANT].message.metadata.parent_id = EXEC_RESULT;
          for (const [id, row] of Object.entries(mapping) as [string, any][]) if (id !== USER) Object.assign(row.message.metadata, scope);
          entry.turn.messageIds = [USER, CALL, CALL2, ASSISTANT];
          if (variant === 'foreign result resource') mapping[RESULT].message.metadata.invoked_resource = {
            app_name: APP, resource_uri: '/' + ASDK + '/link_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/read' };
          if (variant === 'pending result') mapping[RESULT].message.status = 'in_progress';
          if (variant.startsWith('referenced final')) {
            const final = entry.turn.items.find((item: any) => item.messageId === ASSISTANT);
            final.completed = true;
            final.content = `::chatgpt-content-reference{source_message_id="${ASSISTANT}"}`;
            final.contentReferences = [{ type: 'dil', source_message_id: ASSISTANT,
              model_dil_v2: { fallbackMarkdown: 'Rendered final preview differs from the native authored body.' } }];
          }
        } });
      try {
        if (variant === 'exact reordered batch') expect(page.fiber.turns[0].calls.map((call: any) => call.answered)).toEqual([true, true]);
        let observed = page.fiber;
        for (let tries = 0; tries < 8 && !observed.turns[0]?.calls.some((call: any) => call.invocationSha256); tries++) {
          await new Promise(resolve => setTimeout(resolve, 1));
          observed = await shellRescan(page, 'proof-scan-' + tries);
        }
        const calls = observed.turns[0].calls;
        const expected = variant === 'exact reordered batch' || variant === 'referenced final batch' ? [true, true]
          : ['wrong invocation digest', 'foreign result resource', 'arguments change while hashing'].includes(variant) ? [false, true] : [false, false];
        expect(calls.map((call: any) => call.answered)).toEqual(expected);
        if (variant === 'exact reordered batch' || variant === 'referenced final batch') {
          expect(calls[0]).toMatchObject({ requestId: REQUEST, resultReceiptId: 'a'.repeat(48), invocationSha256: digest('one') });
          expect(calls[1]).toMatchObject({ requestId: REQUEST, resultReceiptId: 'b'.repeat(48), invocationSha256: digest('two') });
        }
        if (variant === 'referenced final legacy batch') {
          expect(calls.map((call: any) => call.requestId)).toEqual([REQUEST, REQUEST]);
          expect(calls.every((call: any) => call.resultReceiptId === undefined)).toBe(true);
        }
        expect(JSON.stringify(observed)).not.toMatch(/PRIVATE_RESULT|connector_tool_payload|"paths"/);
      } finally { page.dom.window.close(); }
    });

  it.each(['prior execution', 'enclosing execution', 'folded prior execution', 'folded enclosing execution',
    'pending execution', 'pending execution result',
    'foreign execution scope', 'wrong execution parent', 'foreign typed execution', 'untyped execution',
    'unselected user', 'foreign final namespace', 'no live mapping'] as const)(
    'retains exact Code Mode ancestry when only its result is folded out of selected ids: %s', async variant => {
      const accepted = ['prior execution', 'enclosing execution', 'folded prior execution', 'folded enclosing execution'].includes(variant);
      const enclosing = variant.endsWith('enclosing execution');
      let renderedEntry: any;
      const page = await shellHarness({ withCall: true, withExec: true, nativeCallReceipt: true,
        nativeCallLive: variant !== 'no live mapping', callCompleted: false, assistantCompleted: false,
        nativeCallMutation(mapping, entry) {
          renderedEntry = entry;
          completeExecBeforeCall(mapping, entry);
          delete entry.turn.items.find((item: any) => item.callId === CALL).widgetStateSource;
          mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
            content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }],
            structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } } }) };
          entry.turn.messageIds = [USER, EXEC, CALL, RESULT, ASSISTANT];
          if (enclosing) {
            mapping[CALL].parent = EXEC;
            mapping[CALL].message.metadata.parent_id = EXEC;
            mapping[EXEC_RESULT].parent = RESULT;
            mapping[EXEC_RESULT].message.metadata.parent_id = RESULT;
            mapping[EXEC].message.metadata.request_id = REQUEST;
            mapping[EXEC_RESULT].message.metadata.request_id = REQUEST;
            mapping[ASSISTANT].parent = EXEC_RESULT;
          }
          for (const [id, row] of Object.entries(mapping) as [string, any][]) if (id !== USER)
            Object.assign(row.message.metadata, { working_turn_id: 'native-folded-exec-working',
              turn_exchange_id: 'native-folded-exec-exchange', parent_id: row.parent });
          if (variant === 'pending execution') mapping[EXEC].message.status = 'in_progress';
          if (variant === 'pending execution result') mapping[EXEC_RESULT].message.status = 'in_progress';
          if (variant === 'foreign execution scope') mapping[EXEC_RESULT].message.metadata.request_id = 'foreign-exec';
          if (variant === 'wrong execution parent') mapping[EXEC_RESULT].message.metadata.parent_id = USER;
          if (variant.startsWith('folded ')) entry.turn.messageIds = [USER, CALL, RESULT, ASSISTANT];
          if (variant === 'foreign typed execution') {
            entry.turn.messageIds = [USER, CALL, RESULT, ASSISTANT];
            entry.turn.items.find((item: any) => item.callId === EXEC).callId = 'foreign-typed-execution';
          }
          if (variant === 'untyped execution') entry.turn.items = entry.turn.items.filter((item: any) => item.callId !== EXEC);
          if (variant === 'unselected user') entry.turn.messageIds = [EXEC, CALL, RESULT, ASSISTANT];
          if (variant === 'foreign final namespace') mapping[ASSISTANT].message.metadata.turn_exchange_id = 'foreign-final';
        } });
      try {
        expect(page.fiber.turns[0].calls[0]).toMatchObject({ requestId: accepted ? REQUEST : null,
          answered: accepted });
        // An enclosing execution owns the shared request ID; its child must not
        // create a second ingress association for the same workflow request.
        const requestOwner = enclosing ? EXEC : CALL;
        expect(page.fiber.turns[0].requests.some((row: any) => row.requestId === REQUEST && row.messageId === requestOwner))
          .toBe(accepted);
        if (accepted) {
          // Folding/rehydration cannot rebind a shared workflow ID to its child.
          renderedEntry.turn.messageIds = variant.startsWith('folded ')
            ? [USER, EXEC, EXEC_RESULT, CALL, RESULT, ASSISTANT] : [USER, CALL, RESULT, ASSISTANT];
          const next = await shellRescan(page, 'same-native-owner-' + variant.replaceAll(' ', '-'));
          expect(next.turns[0].calls[0]).toMatchObject({ requestId: REQUEST, answered: true });
          expect(next.turns[0].requests.filter((row: any) => row.requestId === REQUEST))
            .toEqual([expect.objectContaining({ messageId: requestOwner })]);
        }
        if (!accepted) expect(page.fiber.turns[0].endMessageId).toBeNull();
        expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
      } finally { page.dom.window.close(); }
    });

  it.each([
    ['identity only', true, false],
    ['finished exact result', true, true],
    ['cached mapping only', false, false]
  ] as const)('joins an independently anchored native scope namespace: %s', async (_label, live, finished) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: live,
      callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        entry.turn.messageIds = [USER, CALL, RESULT, ASSISTANT];
        for (const id of [CALL, RESULT, ASSISTANT]) {
          Object.assign(mapping[id].message.metadata, {
            working_turn_id: 'native-working-generation', turn_exchange_id: 'native-exchange-generation',
            parent_id: mapping[id].parent
          });
        }
        if (finished) mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
          content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }],
          structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } } }) };
        else {
          mapping[CALL].message.status = 'in_progress';
          mapping[RESULT].message.status = 'in_progress';
        }
      } });
    try {
      const turn = page.fiber.turns[0];
      expect(turn.calls[0].requestId).toBe(live ? REQUEST : null);
      expect(turn.calls[0].identityRefusalReasons.filter((code: string) => code.startsWith('nativeScope'))).toEqual([]);
      expect(turn.calls[0].answered).toBe(live && finished);
      expect(turn.requests.some((row: any) => row.requestId === REQUEST && row.messageId === CALL)).toBe(live);
      if (!finished || !live) expect(turn.endMessageId).toBeNull();
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
      expect(JSON.stringify(page.fiber.shellScan)).not.toContain('native-working-generation');
      expect(JSON.stringify(page.fiber.shellScan)).not.toContain('native-exchange-generation');
    } finally { page.dom.window.close(); }
  });

  it.each([
    'foreign final scope', 'missing final scope', 'final parent conflict', 'foreign original user',
    'unselected final', 'unselected invocation', 'unselected result', 'changed result scope',
    'conflicting cached request', 'scope getter', 'duplicate final'
  ] as const)('refuses native scope namespace without an independent exact current anchor: %s', async variant => {
    let accessorReads = 0;
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
      nativeCallCacheConflict: variant === 'conflicting cached request',
      callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        entry.turn.messageIds = [USER, CALL, RESULT, ASSISTANT];
        for (const id of [CALL, RESULT, ASSISTANT]) Object.assign(mapping[id].message.metadata, {
          working_turn_id: 'native-working-generation', turn_exchange_id: 'native-exchange-generation',
          parent_id: mapping[id].parent
        });
        mapping[CALL].message.status = 'in_progress';
        mapping[RESULT].message.status = 'in_progress';
        if (variant === 'foreign final scope') mapping[ASSISTANT].message.metadata.turn_exchange_id = 'foreign-exchange';
        if (variant === 'missing final scope') delete mapping[ASSISTANT].message.metadata.working_turn_id;
        if (variant === 'final parent conflict') mapping[ASSISTANT].message.metadata.parent_id = USER;
        if (variant === 'foreign original user') {
          mapping[USER].message.author.role = 'assistant';
        }
        if (variant === 'unselected final') entry.turn.messageIds = [USER, CALL, RESULT];
        if (variant === 'unselected invocation') entry.turn.messageIds = [USER, RESULT, ASSISTANT];
        if (variant === 'unselected result') entry.turn.messageIds = [USER, CALL, ASSISTANT];
        if (variant === 'changed result scope') mapping[RESULT].message.metadata.working_turn_id = 'other-generation';
        if (variant === 'scope getter') Object.defineProperty(mapping[ASSISTANT].message.metadata, 'working_turn_id', {
          get() { accessorReads++; throw new Error('PRIVATE_SCOPE_GETTER'); }
        });
        if (variant === 'duplicate final') entry.turn.items.push({
          type: 'assistant-message', messageId: RESULT, phase: 'final_answer', content: 'other final', completed: false
        });
      } });
    try {
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ requestId: null, answered: false });
      expect(page.fiber.turns[0].requests.some((row: any) => row.requestId === REQUEST && row.messageId === CALL)).toBe(false);
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(accessorReads).toBe(0);
    } finally { page.dom.window.close(); }
  });


  it.each(['server', 'tool'] as const)('separates a selected %s mismatch from the same mismatch in an ancestor', async mismatch => {
    const nextId = 'call_after_refused_scope';
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true,
      callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items.find((item: any) => item.callId === CALL).widgetStateSource;
        entry.turn.items.splice(2, 0, { type: 'mcp-tool-call', callId: nextId,
          completed: false, invocation: { server: APP, tool: 'read' } });
        mapping[nextId] = { id: nextId, parent: RESULT, message: { id: nextId,
          author: { role: 'assistant' }, recipient: 'api_tool.call_tool',
          content: { text: JSON.stringify({ path: '/' + APP + '/' + LINK + '/read' }) },
          metadata: { request_id: REQUEST, parent_id: RESULT } } };
        mapping[ASSISTANT].parent = nextId;
        entry.turn.messageIds = [USER, CALL, RESULT, nextId, ASSISTANT];
        for (const [id, row] of Object.entries(mapping) as [string, any][]) if (id !== USER)
          Object.assign(row.message.metadata, { working_turn_id: 'native-working-generation',
            turn_exchange_id: 'native-exchange-generation', parent_id: row.parent });
        mapping[CALL].message.content.text = JSON.stringify({ path: mismatch === 'server'
          ? '/Luna Forge X7 Plugins/' + LINK + '/read' : '/' + APP + '/' + LINK + '/write' });
        mapping[CALL].message.status = 'in_progress';
        mapping[RESULT].message.status = 'in_progress';
      } });
    try {
      const calls = page.fiber.turns[0].calls;
      const selectedReason = mismatch === 'server' ? 'serverMismatch' : 'toolMismatch';
      expect(calls[0].identityRefusalReasons).toContain(selectedReason);
      expect(calls[1].identityRefusalReasons).toContain('priorToolScopeMismatch');
      expect(calls[1].identityRefusalReasons).not.toContain(selectedReason);
      expect(calls.every((call: any) => call.requestId === null && call.answered === false)).toBe(true);
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it.each(['prior pair', 'Code Mode', 'off-branch sibling', 'cached scope conflict'] as const)(
    'keeps native scope namespace request joins on their exact selected branch: %s', async variant => {
      const secondId = 'call_native_scope_second', secondRequest = 'wfr_native_scope_second';
      const page = await shellHarness({ withCall: true, withExec: variant === 'Code Mode', nativeCallReceipt: true,
        callCompleted: false, assistantCompleted: false,
        nativeCallMutation(mapping, entry) {
          if (variant === 'Code Mode') completeExecBeforeCall(mapping, entry);
          const call = entry.turn.items.find((item: any) => item.callId === CALL);
          delete call.widgetStateSource;
          if (variant === 'prior pair' || variant === 'off-branch sibling') {
            entry.turn.items.splice(2, 0, { type: 'mcp-tool-call', callId: secondId,
              completed: false, invocation: { server: APP, tool: 'read' } });
            mapping[secondId] = { id: secondId,
              parent: variant === 'prior pair' ? RESULT : USER,
              message: { id: secondId, author: { role: 'assistant' }, recipient: 'api_tool.call_tool',
                content: { text: JSON.stringify({ path: '/' + APP + '/' + LINK + '/read' }) },
                metadata: { request_id: secondRequest,
                  parent_id: variant === 'prior pair' ? RESULT : USER } } };
            if (variant === 'prior pair') mapping[ASSISTANT].parent = secondId;
          }
          entry.turn.messageIds = [USER,
            ...(variant === 'Code Mode' ? [EXEC, EXEC_RESULT] : []), CALL, RESULT,
            ...(variant === 'prior pair' ? [secondId] : []), ASSISTANT];
          for (const [id, row] of Object.entries(mapping) as [string, any][]) if (id !== USER) {
            Object.assign(row.message.metadata, { working_turn_id: 'native-working-generation',
              turn_exchange_id: 'native-exchange-generation', parent_id: row.parent });
          }
          mapping[CALL].message.status = 'in_progress';
          mapping[RESULT].message.status = 'in_progress';
        } });
      try {
        if (variant === 'cached scope conflict') {
          const fiber = (page.win.document.getElementById('exchange') as any).__reactFiber$shellfixture;
          const mapping = fiber.memoizedState.memoizedState.renderedConversation.mapping;
          const cached = { ...mapping, [CALL]: { ...mapping[CALL],
            message: { ...mapping[CALL].message, metadata: { ...mapping[CALL].message.metadata,
              working_turn_id: 'foreign-cache-generation' } } } };
          fiber.memoizedProps.client = queryClient(cached, {});
          const fresh = await shellRescan(page, 'native-scope-cache-conflict');
          expect(fresh.turns[0].calls[0].requestId).toBeNull();
          expect(fresh.turns[0].calls[0].answered).toBe(false);
        } else {
          expect(page.fiber.turns[0].calls[0]).toMatchObject({ requestId: REQUEST, answered: false });
          if (variant === 'prior pair' || variant === 'off-branch sibling')
            expect(page.fiber.turns[0].calls[1]).toMatchObject({
              requestId: variant === 'prior pair' ? secondRequest : null, answered: false });
        }
        expect(page.fiber.turns[0].endMessageId).toBeNull();
        expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
      } finally { page.dom.window.close(); }
    });

  it.each([
    ['decoded path missing', (mapping: any, _entry: any) => {
      mapping[CALL].message.content.text = JSON.stringify({ args: { secret: 'PRIVATE_ARGUMENT_SENTINEL' } });
    }, 'decodedPathMissing', 'present'],
    ['decoded path foreign', (mapping: any, _entry: any) => {
      mapping[CALL].message.content.text = JSON.stringify({ path: '/Gmail/link_foreign/read', args: { secret: 'PRIVATE_ARGUMENT_SENTINEL' } });
    }, 'decodedPathForeign', 'present'],
    ['server mismatch', (mapping: any, _entry: any) => {
      mapping[CALL].message.content.text = JSON.stringify({ path: `/Luna Forge X7 Plugins/${LINK}/read`, args: { secret: 'PRIVATE_ARGUMENT_SENTINEL' } });
    }, 'serverMismatch', 'present'],
    ['tool mismatch', (mapping: any, _entry: any) => {
      mapping[CALL].message.content.text = JSON.stringify({ path: `/Luna Forge X7 Core/${LINK}/write`, args: { secret: 'PRIVATE_ARGUMENT_SENTINEL' } });
    }, 'toolMismatch', 'present'],
    ['request id missing', (mapping: any, _entry: any) => { delete mapping[CALL].message.metadata.request_id; }, 'requestIdMissing', 'missing'],
    ['working turn missing', (mapping: any, _entry: any) => { delete mapping[CALL].message.metadata.working_turn_id; }, 'workingTurnMissing', 'present'],
    ['working turn mismatch', (mapping: any, _entry: any) => { mapping[CALL].message.metadata.working_turn_id = 'PRIVATE_TURN_ID'; }, 'workingTurnMismatch', 'present'],
    ['turn exchange missing', (mapping: any, _entry: any) => { delete mapping[CALL].message.metadata.turn_exchange_id; }, 'turnExchangeMissing', 'present'],
    ['turn exchange mismatch', (mapping: any, _entry: any) => { mapping[CALL].message.metadata.turn_exchange_id = 'PRIVATE_EXCHANGE_ID'; }, 'turnExchangeMismatch', 'present'],
    ['native ancestry mismatch', (mapping: any, _entry: any) => { mapping[CALL].parent = RESULT; }, 'nativeAncestryUnproved', 'present'],
    ['current question unselected', (_mapping: any, entry: any) => { entry.turn.messageIds = [CALL, ASSISTANT]; }, 'currentQuestionUnselected', 'present'],
    ['current question role conflict', (mapping: any, _entry: any) => { mapping[USER].message.author.role = 'assistant'; }, 'currentQuestionConflict', 'present'],
    ['current question missing', (_mapping: any, entry: any) => {
      entry.turn.items.shift();
      entry.turn.messageIds = [CALL, ASSISTANT];
    }, 'currentQuestionMissing', 'present'],
    ['native invocation missing', (mapping: any, _entry: any) => { delete mapping[CALL]; }, 'nativeInvocationMissing', 'unavailable'],
    ['native invocation role conflict', (mapping: any, _entry: any) => { mapping[CALL].message.author.role = 'tool'; }, 'nativeInvocationMismatch', 'unavailable']
  ] as const)('reports bounded reason enums for a refused native identity join: %s', async (_label, mutation, expectedReason, requestIds) => {
    const diagnosticLogs: string[] = [];
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: false,
      callCompleted: false, assistantCompleted: false, diagnosticLogs,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        entry.turn.messageIds = [USER, CALL, ASSISTANT];
        mutation(mapping, entry);
      } });
    try {
      expect(page.fiber.turns[0].calls[0].identityRefusalReasons).toContain(expectedReason);
      const reasonKey = 'identityReason' + expectedReason[0]!.toUpperCase() + expectedReason.slice(1);
      expect(page.fiber.shellScan.rejects[reasonKey]).toBe(1);
      const trace = diagnosticLogs.find(line => line.includes('native result-reference recovery diagnostic'))!;
      expect(trace).toContain('version=5');
      expect(trace).toContain('identityRefusals=1');
      expect(trace).toContain(`${expectedReason}:1`);
      if (requestIds === 'present') expect(trace).toContain('requestIdPresent=1 requestIdMissing=0');
      else if (requestIds === 'missing') expect(trace).toContain('requestIdPresent=0 requestIdMissing=1');
      else expect(trace).toContain('requestIdPresent=0 requestIdMissing=0');
      for (const privateValue of [USER, CALL, RESULT, REQUEST, APP, LINK, REFERENCE_SOURCE,
        'PRIVATE_ARGUMENT_SENTINEL', 'PRIVATE_TURN_ID', 'PRIVATE_EXCHANGE_ID'])
        expect(trace).not.toContain(privateValue);
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ answered: false, requestId: null });
      expect(page.fiber.turns[0].endMessageId).toBeNull();
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['sequential ordinary calls with a missing typed user', false, true, false],
    ['sequential calls through typed Code Mode', true, false, false],
    ['Code Mode and a missing typed user together', true, true, false],
    ['foreign prior Code Mode result scope', true, true, true]
  ] as const)('joins the third pending call through two selected prior tool pairs: %s', async (_case, exec, missingUser, corruptExec) => {
    const secondId = 'call_shell_second';
    const secondResult = 'result_shell_second';
    const thirdId = 'call_shell_third';
    const thirdRequest = 'wfr_shell_third';
    const page = await shellHarness({ withCall: true, withExec: exec, nativeCallReceipt: true,
      nativeCallLive: false, callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        if (exec) completeExecBeforeCall(mapping, entry);
        delete entry.turn.items[exec ? 2 : 1].widgetStateSource;
        if (missingUser) entry.turn.items.shift();
        const nativeCall = (id: string, parent: string, requestId: string) => ({
          id, parent, message: { id, author: { role: 'assistant' }, recipient: 'api_tool.call_tool',
            content: { text: `{"path":"/Luna Forge X7 Core/${LINK}/read","args":{}}` },
            metadata: { request_id: requestId, working_turn_id: TURN, turn_exchange_id: USER, parent_id: parent } }
        });
        mapping[secondId] = nativeCall(secondId, RESULT, 'wfr_shell_second');
        mapping[secondResult] = { id: secondResult, parent: secondId, message: {
          id: secondResult, author: { role: 'tool', name: 'api_tool.call_tool' }, recipient: 'all',
          metadata: { request_id: 'wfr_shell_second', working_turn_id: TURN,
            turn_exchange_id: USER, parent_id: secondId } } };
        mapping[thirdId] = nativeCall(thirdId, secondResult, thirdRequest);
        if (corruptExec) mapping[EXEC_RESULT].message.metadata.turn_exchange_id = REFERENCE_SOURCE;
        const assistantAt = entry.turn.items.findIndex((item: any) => item.type === 'assistant-message');
        entry.turn.items.splice(assistantAt, 0, { type: 'mcp-tool-call', callId: secondId,
          completed: false, invocation: { server: APP, tool: 'read' }, widgetStateSource: { messageId: secondResult } },
        { type: 'mcp-tool-call', callId: thirdId, completed: false, invocation: { server: APP, tool: 'read' } });
        entry.turn.messageIds = exec ? [USER, EXEC, EXEC_RESULT, CALL, RESULT, secondId, secondResult, ASSISTANT]
          : [USER, CALL, RESULT, secondId, secondResult, ASSISTANT];
      } });
    try {
      const turn = page.fiber.turns[0];
      expect(turn.calls).toHaveLength(3);
      expect(turn.calls.every((call: any) => call.answered === false)).toBe(true);
      expect(turn.endMessageId).toBeNull();
      expect(turn.calls[2].requestId).toBe(corruptExec ? null : thirdRequest);
      expect(turn.requests.some((r: any) => r.requestId === thirdRequest)).toBe(!corruptExec);
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
      expect(JSON.stringify(page.fiber.shellScan)).not.toContain(thirdRequest);
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['two selected native users', (mapping: any, entry: any) => {
      mapping[REFERENCE_SOURCE] = { id: REFERENCE_SOURCE, message: { id: REFERENCE_SOURCE, author: { role: 'user' }, metadata: {} } };
      entry.turn.messageIds = [USER, REFERENCE_SOURCE, ASSISTANT];
    }],
    ['no selected native user', (_mapping: any, entry: any) => { entry.turn.messageIds = [ASSISTANT]; }],
    ['deleted native user', (mapping: any) => { delete mapping[USER]; }],
    ['native user with foreign role', (mapping: any) => { mapping[USER].message.author.role = 'assistant'; }],
    ['native user id disagreement', (mapping: any) => { mapping[USER].message.id = REFERENCE_SOURCE; }],
    ['inconsistent native user parent', (mapping: any) => { mapping[CALL].parent = RESULT; }],
    ['native call exchange differs', (mapping: any) => { mapping[CALL].message.metadata.turn_exchange_id = REFERENCE_SOURCE; }],
    ['native call turn differs', (mapping: any) => { mapping[CALL].message.metadata.working_turn_id = 'different'; }],
    ['missing current mapping invocation', (mapping: any) => { delete mapping[CALL]; }]
  ] as const)('refuses untyped-user request ownership with %s', async (_label, mutate) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: false,
      callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        entry.turn.items.shift();
        delete entry.turn.items[0].widgetStateSource;
        entry.turn.messageIds = [USER, ASSISTANT];
        mutate(mapping, entry);
      } });
    try {
      expect(page.fiber.turns[0].requests).toEqual([]);
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ requestId: null, answered: false });
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it('does not evaluate accessor-backed native user identity during untyped-user recovery', async () => {
    let reads = 0;
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: false,
      callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        entry.turn.items.shift();
        delete entry.turn.items[0].widgetStateSource;
        entry.turn.messageIds = [USER, ASSISTANT];
        Object.defineProperty(mapping[USER].message.author, 'role', {
          configurable: true, get() { reads++; throw new Error('PRIVATE_NATIVE_USER_ROLE'); }
        });
      } });
    try {
      expect(reads).toBe(0);
      expect(page.fiber.turns[0].requests).toEqual([]);
      expect(page.fiber.turns[0].calls[0].requestId).toBeNull();
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_NATIVE_USER_ROLE');
    } finally { page.dom.window.close(); }
  });

  it('retains an unanswered Code Mode child request only through its exact typed exec ancestor', async () => {
    const page = await shellHarness({ withCall: true, withExec: true, nativeCallReceipt: true,
      nativeCallLive: false, callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[2].widgetStateSource;
        entry.turn.messageIds = [USER, ASSISTANT];
        Object.assign(mapping[EXEC], { parent: USER });
        Object.assign(mapping[EXEC].message, { metadata: { request_id: EXEC_REQUEST,
          working_turn_id: TURN, turn_exchange_id: USER, parent_id: USER } });
        mapping[CALL].parent = EXEC;
        mapping[CALL].message.metadata.parent_id = EXEC;
      } });
    try {
      expect(page.fiber.turns[0].requests).toContainEqual({ requestId: REQUEST,
        messageId: CALL, createTime: null });
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
      expect(page.fiber.turns[0].endMessageId).toBeNull();
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['wrong turn', (mapping: any) => { mapping[CALL].message.metadata.working_turn_id = 'other-turn'; }],
    ['wrong user exchange', (mapping: any) => { mapping[CALL].message.metadata.turn_exchange_id = RESULT; }],
    ['wrong native parent', (mapping: any) => { mapping[CALL].message.metadata.parent_id = ASSISTANT; }],
    ['foreign connector', (mapping: any) => { mapping[CALL].message.content.text = '{"path":"/Gmail/link_unrelated/read"}'; }],
    ['foreign tool', (mapping: any) => { mapping[CALL].message.content.text = '{"path":"/Luna Forge X7 Core/' + LINK + '/write"}'; }],
    ['absent request identity', (mapping: any) => { delete mapping[CALL].message.metadata.request_id; }],
    ['unavailable native invocation', (mapping: any) => { delete mapping[CALL]; }]
  ] as const)('does not attribute a typed pending call from %s without a result widget', async (_reason, mutation) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: false,
      callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        entry.turn.messageIds = [USER, ASSISTANT];
        mutation(mapping);
      } });
    try {
      expect(page.fiber.turns[0].requests).toEqual([]);
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ answered: false, requestId: null });
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it('does not inspect an accessor-backed native request while looking for pending call identity', async () => {
    let privateReads = 0;
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: false,
      callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        entry.turn.messageIds = [USER, ASSISTANT];
        Object.defineProperty(mapping[CALL].message.metadata, 'request_id', {
          get() { privateReads++; throw new Error('PRIVATE_METADATA'); }
        });
      } });
    try {
      expect(privateReads).toBe(0);
      expect(page.fiber.turns[0].requests).toEqual([]);
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_METADATA');
    } finally { page.dom.window.close(); }
  });

  it('does not borrow a pending Code Mode request from an untyped enclosing result', async () => {
    const page = await shellHarness({ withCall: true, withExec: true, nativeCallReceipt: true,
      nativeCallLive: false, callCompleted: false, assistantCompleted: false,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[2].widgetStateSource;
        entry.turn.messageIds = [USER, ASSISTANT];
        mapping[EXEC_RESULT] = { id: EXEC_RESULT, parent: USER, message: {
          id: EXEC_RESULT, author: { role: 'tool', name: 'functions.exec' }, recipient: 'all',
          metadata: { request_id: EXEC_REQUEST, working_turn_id: TURN, turn_exchange_id: USER, parent_id: USER }
        } };
        mapping[CALL].parent = EXEC_RESULT;
        mapping[CALL].message.metadata.parent_id = EXEC_RESULT;
      } });
    try {
      expect(page.fiber.turns[0].requests).not.toContainEqual(expect.objectContaining({ requestId: REQUEST }));
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ answered: false, requestId: null });
      expect(page.fiber.turns[0].endMessageId).toBeNull();
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['absent reference', 'callJoinReferenceMissing', (_mapping: any, entry: any) => { delete entry.turn.items[1].widgetStateSource; }],
    ['malformed reference', 'callJoinReferenceMissing', (_mapping: any, entry: any) => { entry.turn.items[1].widgetStateSource.messageId = 42; }],
    ['conflicting reference', 'callJoinReferenceConflict', (mapping: any, entry: any) => {
      entry.turn.items.splice(2, 0, { ...entry.turn.items[1], callId: EXEC });
      mapping[EXEC] = { ...mapping[CALL], id: EXEC, message: { ...mapping[CALL].message, id: EXEC } };
    }],
    ['missing result', 'callJoinResultMissing', (mapping: any) => { delete mapping[RESULT]; }],
    ['conflicting result role', 'callJoinResultIdentity', (mapping: any) => { mapping[RESULT].message.author.role = 'assistant'; }]
  ] as const)('reports the masked early join reason without overriding explicit false: %s', async (label, key, nativeCallMutation) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false, nativeCallMutation });
    try {
      const count = label === 'conflicting reference' ? 2 : 1;
      expect(page.fiber.turns[0].calls.every((call: any) => call.answered === false)).toBe(true);
      expect(page.fiber.shellScan.rejects).toMatchObject({ ...EMPTY_CALL_JOINS, [key]: count,
        ...(['absent reference', 'malformed reference'].includes(label) ? { callIdentityRecovered: 1 } : {}),
        ...(label === 'conflicting reference' ? { callIdentitySelectedWithheld: 1 } : {}),
        callCompletionVeto: count, callCompletedFalse: count, callVetoReceiptChecked: 0, callVetoReceiptMatched: 0 });
      const diagnostic = JSON.stringify(page.fiber.shellScan);
      for (const privateValue of [USER, CALL, RESULT, REQUEST, APP, LINK, 'PRIVATE_TOOL_RESULT'])
        expect(diagnostic).not.toContain(privateValue);
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['absent reference', 'callJoinReferenceMissing', (_mapping: any, entry: any) => { delete entry.turn.items[1].widgetStateSource; }],
    ['malformed reference', 'callJoinReferenceMissing', (_mapping: any, entry: any) => { entry.turn.items[1].widgetStateSource.messageId = 42; }],
    ['conflicting reference', 'callJoinReferenceConflict', (mapping: any, entry: any) => {
      entry.turn.items.splice(2, 0, { ...entry.turn.items[1], callId: EXEC });
      mapping[EXEC] = { ...mapping[CALL], id: EXEC, message: { ...mapping[CALL].message, id: EXEC } };
    }],
    ['missing result', 'callJoinResultMissing', (mapping: any) => { delete mapping[RESULT]; }],
    ['conflicting result role', 'callJoinResultIdentity', (mapping: any) => { mapping[RESULT].message.author.role = 'assistant'; }]
  ] as const)('reports the early join reason for settled native calls without lifting identity guards: %s', async (label, key, nativeCallMutation) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: true, nativeCallMutation });
    try {
      const count = label === 'conflicting reference' ? 2 : 1;
      expect(page.fiber.turns[0].calls.every((call: any) => call.answered === true)).toBe(true);
      expect(page.fiber.shellScan.rejects[key]).toBe(count);
      expect(page.fiber.shellScan.rejects.callCompletionVeto).toBe(0);
      if (label === 'conflicting reference') {
        expect(page.fiber.turns[0].calls.every((call: any) => call.requestId == null)).toBe(true);
      }
      const diagnostic = JSON.stringify(page.fiber.shellScan);
      for (const privateValue of [USER, CALL, RESULT, REQUEST, APP, LINK, 'PRIVATE_TOOL_RESULT'])
        expect(diagnostic).not.toContain(privateValue);
    } finally { page.dom.window.close(); }
  });


  it.each([true, 'missing'] as const)('leaves accepted native results and join counters unchanged: %s', async callCompleted => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted });
    try {
      expect(page.fiber.turns[0].calls[0].answered).toBe(true);
      expect(page.fiber.shellScan.rejects).toMatchObject(EMPTY_CALL_JOINS);
    } finally { page.dom.window.close(); }
  });

  it.each(['invocation', 'result'] as const)('leaves vetoed receipt diagnostics uninspected rather than evaluating native %s status getters', async source => {
    let reads = 0;
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false,
      nativeCallMutation(mapping) {
        Object.defineProperty(mapping[source === 'result' ? RESULT : CALL].message, 'status', { enumerable: true,
          get() { reads++; return 'finished_successfully'; } });
      } });
    try {
      expect(reads).toBe(0);
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
      expect(page.fiber.turns[0].calls[0].resultReceiptId).toBeUndefined();
      expect(page.fiber.shellScan.rejects.callVetoReceiptChecked).toBe(0);
      expect(page.fiber.shellScan.rejects.callVetoReceiptMatched).toBe(0);
      expect(page.fiber.shellScan.rejects).toMatchObject({ ...EMPTY_CALL_JOINS, callJoinDescriptorUnsupported: 1 });
    } finally { page.dom.window.close(); }
  });

  it('does not retain a vetoed native receipt match after a later cache contradiction', async () => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false,
      nativeCallCacheConflict: true });
    try {
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
      expect(page.fiber.shellScan.rejects.callVetoReceiptChecked).toBe(1);
      expect(page.fiber.shellScan.rejects.callVetoReceiptMatched).toBe(0);
    } finally { page.dom.window.close(); }
  });

  it.each(['absent', 'returned-without-witness', 'returned-with-witness'] as const)(
    'distinguishes missing-reference native result custody using only bounded shape counts: %s', async variant => {
    const diagnosticLogs: string[] = [];
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false,
      diagnosticLogs, nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        if (variant === 'absent') {
          entry.turn.messageIds = [USER, CALL, ASSISTANT];
          delete mapping[RESULT];
          mapping[ASSISTANT].parent = CALL;
          mapping[ASSISTANT].message.metadata.parent_id = CALL;
        } else if (variant === 'returned-with-witness') {
          mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
            content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }],
            structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } } }) };
        }
      } });
    try {
      const trace = diagnosticLogs.find(line => line.includes('native result-reference recovery diagnostic'))!;
      expect(trace).toContain('version=5');
      expect(trace).toContain(`missingWithChild=${variant === 'absent' ? 0 : 1}`);
      expect(trace).toContain(`missingWithWitness=${variant === 'returned-with-witness' ? 1 : 0}`);
      expect(trace).toContain(`witnessedResults=${variant === 'returned-with-witness' ? 1 : 0}`);
      for (const privateValue of [USER, CALL, RESULT, REQUEST, APP, LINK, 'PRIVATE_TOOL_RESULT', 'a'.repeat(48)])
        expect(trace).not.toContain(privateValue);
      expect(page.fiber.turns[0].calls[0].answered).toBe(variant === 'returned-with-witness');
    } finally { page.dom.window.close(); }
  });

  it.each(['parts', 'status', 'structured', 'envelope', 'receipt', 'oversized'] as const)(
    'classifies the exact native result witness refusal without exporting content: %s', async variant => {
      const diagnosticLogs: string[] = [];
      const page = await shellHarness({withCall:true, nativeCallReceipt:true, callCompleted:false, diagnosticLogs, nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        const message = mapping[RESULT].message;
        message.content = {content_type:'code',language:'json',text:JSON.stringify({content:[{type:'text',text:'PRIVATE_SHAPE_SENTINEL'}],structuredContent:{cosResultReceipt:{version:1,id:'a'.repeat(48)}}})};
        if(variant==='parts')message.content={content_type:'text',parts:['PRIVATE_SHAPE_SENTINEL']};
        if(variant==='status')message.status='in_progress';
        if(variant==='structured')message.content.text=JSON.stringify({content:[{type:'text',text:'PRIVATE_SHAPE_SENTINEL'}]});
        if(variant==='envelope')message.content.text=JSON.stringify({structuredContent:{cosResultReceipt:{version:1,id:'a'.repeat(48)}}});
        if(variant==='receipt')message.content.text=JSON.stringify({content:[],structuredContent:{cosResultReceipt:{version:2,id:'PRIVATE_SHAPE_SENTINEL'}}});
        if(variant==='oversized')message.content.text='PRIVATE_SHAPE_SENTINEL'.repeat(30_000);
      }});
      try {
        const trace=diagnosticLogs.find(line=>line.includes('native result-reference recovery diagnostic'))!;
        expect(trace).toContain('version=5');
        expect(trace).toMatch(new RegExp('resultShapes=.*'+variant+':1'));
        expect(trace).not.toMatch(/PRIVATE_SHAPE_SENTINEL|a{48}/);
        expect(page.fiber.turns[0].calls[0].resultReceiptId).toBeUndefined();
      }finally{page.dom.window.close();}
    });

  it.each([false, 'missing'] as const)('recovers a missing native result widget through a committed resource when structuredContent is absent (%s)', async callCompleted => {
    const witness = 'b'.repeat(48);
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
          content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }, { type: 'resource', resource: {
            uri: 'urn:cos:result-receipt:v1:' + witness,
            mimeType: 'application/vnd.chat-on-steroids.result-receipt+json',
            text: JSON.stringify({ version: 1, id: witness })
          } }]
        }) };
      } });
    try {
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ messageId: CALL, answered: true,
        requestId: REQUEST, resultReceiptId: witness });
      expect(page.fiber.turns[0].endMessageId).toBe(ASSISTANT);
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
      expect(JSON.stringify(page.fiber)).not.toContain('urn:cos');
    } finally { page.dom.window.close(); }
  });

  it.each([false, 'missing'] as const)('recovers a flattened structured native result receipt without exporting output (%s)', async callCompleted => {
    const witness = 'bc'.repeat(24);
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
          cosResultReceipt: { version: 1, id: witness }, output: 'PRIVATE_FLATTENED_RESULT'
        }) };
      } });
    try {
      expect(page.fiber.turns[0].calls[0]).toMatchObject({
        messageId: CALL, answered: true, requestId: REQUEST, resultReceiptId: witness
      });
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_FLATTENED_RESULT');
    } finally { page.dom.window.close(); }
  });

  it.each([true, false])('anchors a native request namespace to its exact user without inventing a final (receipt=%s)', async returned => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false,
      assistantCompleted: false, nativeCallMutation(mapping, entry) {
        entry.turn.status = 'in_progress';
        delete entry.turn.items.find((item: any) => item.callId === CALL).widgetStateSource;
        for (const row of Object.values(mapping) as any[])
          Object.assign(row.message.metadata, {
            working_turn_id: 'native-working', turn_exchange_id: 'native-exchange', parent_id: row.parent
          });
        mapping[RESULT].message.status = returned ? 'finished_successfully' : 'in_progress';
        mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
          cosResultReceipt: { version: 1, id: 'bc'.repeat(24) }
        }) };
      } });
    try {
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ requestId: REQUEST, answered: returned });
      expect(page.fiber.turns[0].endMessageId).toBeNull();
    } finally { page.dom.window.close(); }
  });

  it.each(['partial-user-scope', 'user-scope-getter', 'different-call-scope'] as const)(
    'refuses an inconsistent native-user namespace (%s)', async fault => {
    let reads = 0;
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false,
      assistantCompleted: false, nativeCallMutation(mapping, entry) {
        entry.turn.status = 'in_progress';
        delete entry.turn.items.find((item: any) => item.callId === CALL).widgetStateSource;
        for (const row of Object.values(mapping) as any[])
          Object.assign(row.message.metadata, {
            working_turn_id: 'native-working', turn_exchange_id: 'native-exchange', parent_id: row.parent
          });
        if (fault === 'partial-user-scope') delete mapping[USER].message.metadata.turn_exchange_id;
        if (fault === 'user-scope-getter') Object.defineProperty(mapping[USER].message.metadata,
          'working_turn_id', { get() { reads++; return 'native-working'; } });
        if (fault === 'different-call-scope') mapping[CALL].message.metadata.working_turn_id = 'foreign-working';
      } });
    try {
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ requestId: null, answered: false });
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(reads).toBe(0);
    } finally { page.dom.window.close(); }
  });

  it.each(['unfinished', 'no-status', 'invalid-receipt', 'nested', 'mixed-envelope', 'foreign-parent'] as const)(
    'refuses an unproved flattened native receipt (%s)', async fault => {
    const witness = 'bc'.repeat(24);
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        const message = mapping[RESULT].message;
        const value: Record<string, unknown> = { cosResultReceipt: { version: 1, id: witness } };
        if (fault === 'unfinished') message.status = 'in_progress';
        if (fault === 'no-status') delete message.status;
        if (fault === 'invalid-receipt') value.cosResultReceipt = { version: 1, id: witness, extra: true };
        if (fault === 'mixed-envelope') value.content = [];
        if (fault === 'nested') {
          delete value.cosResultReceipt;
          value.output = { cosResultReceipt: { version: 1, id: witness } };
        }
        if (fault === 'foreign-parent') message.metadata.parent_id = 'foreign-native-parent';
        message.content = { content_type: 'code', language: 'json', text: JSON.stringify(value) };
      } });
    try {
      expect(page.fiber.turns[0].calls[0].resultReceiptId).toBeUndefined();
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
    } finally { page.dom.window.close(); }
  });

  it.each([false, true])('proves a returned native MCP envelope independently of its success flag (isError=%s)', async isError => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
          isError, content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }],
          structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } } }) };
      } });
    try {
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ messageId: CALL, answered: true,
        requestId: REQUEST, resultReceiptId: 'a'.repeat(48) });
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it.each([false, 'missing'] as const)('recovers an exact finished native result when its widget reference is absent (%s)', async callCompleted => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
          content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }],
          structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } } }) };
      } });
    try {
      expect(page.fiber.turns[0].calls[0]).toMatchObject({ messageId: CALL, answered: true, requestId: REQUEST });
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it.each([false, 'missing'] as const)('retains a genuinely pending native result when its widget reference is absent (%s)', async callCompleted => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
          content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }],
          structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } } }) };
        mapping[RESULT].message.status = 'in_progress';
      } });
    try { expect(page.fiber.turns[0].calls[0].answered).toBe(false); }
    finally { page.dom.window.close(); }
  });

  it.each([
    ['foreign connector link', (mapping: any) => { mapping[RESULT].message.metadata.invoked_resource.resource_uri = `/${ASDK}/link_99999999222233334444555555555555/read`; }],
    ['different request', (mapping: any) => { mapping[RESULT].message.metadata.request_id = 'another-request'; }],
    ['different exchange', (mapping: any) => { mapping[RESULT].message.metadata.turn_exchange_id = 'another-question'; }],
    ['different working turn', (mapping: any) => { mapping[RESULT].message.metadata.working_turn_id = 'another-turn'; }],
    ['incomplete selected branch', (mapping: any) => { mapping[ASSISTANT].parent = USER; }],
    ['typed execution still pending', (_mapping: any, entry: any) => { entry.turn.items[1].status = 'in_progress'; }],
    ['malformed widget reference', (_mapping: any, entry: any) => { entry.turn.items[1].widgetStateSource = { messageId: 42 }; }],
    ['two native result parents', (mapping: any) => {
      const id = 'second-native-result';
      mapping[id] = { id, parent: RESULT, message: { ...mapping[RESULT].message, id } };
      mapping[ASSISTANT].parent = id;
      mapping[ASSISTANT].message.metadata.parent_id = id;
    }]
  ] as const)('keeps missing-widget completion held for %s despite a structured witness', async (_reason, mutation) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: false,
      nativeCallMutation(mapping, entry) {
        delete entry.turn.items[1].widgetStateSource;
        mapping[RESULT].message.content = { content_type: 'code', language: 'json', text: JSON.stringify({
          content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }],
          structuredContent: { cosResultReceipt: { version: 1, id: 'a'.repeat(48) } } }) };
        mutation(mapping, entry);
      } });
    try {
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
      expect(page.fiber.turns[0].calls[0].resultReceiptId).toBeUndefined();
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it.each([false, null, 'invalid'] as const)('does not override an explicit shell completion value: %s', async callCompleted => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted });
    try { expect(page.fiber.turns[0].calls[0].answered).toBe(false); }
    finally { page.dom.window.close(); }
  });

  it.each([
    ['explicit undefined completion', (_mapping: any, entry: any) => { entry.turn.items[1].completed = undefined; }],
    ['pending typed step', (_mapping: any, entry: any) => { entry.turn.items[1].status = 'in_progress'; }],
    ['errored typed step', (_mapping: any, entry: any) => { entry.turn.items[1].status = 'error'; }],
    ['pending result', (mapping: any) => { mapping[RESULT].message.status = 'in_progress'; }],
    ['errored native result', (mapping: any) => { mapping[RESULT].message.status = 'error'; }],
    ['untyped result status', (mapping: any) => { delete mapping[RESULT].message.status; }],
    ['pending invocation', (mapping: any) => { mapping[CALL].message.status = 'in_progress'; }],
    ['untyped invocation status', (mapping: any) => { delete mapping[CALL].message.status; }],
    ['foreign result role', (mapping: any) => { mapping[RESULT].message.author.role = 'assistant'; }],
    ['foreign result recipient', (mapping: any) => { mapping[RESULT].message.recipient = 'functions.exec'; }],
    ['foreign result tool author', (mapping: any) => { mapping[RESULT].message.author.name = 'functions.exec'; }],
    ['foreign connector', (mapping: any) => { mapping[RESULT].message.metadata.invoked_resource.app_name = 'Gmail'; }],
    ['another resource tool', (mapping: any) => { mapping[RESULT].message.metadata.invoked_resource.resource_uri = `/${ASDK}/${LINK}/search`; }],
    ['another connector link', (mapping: any) => { mapping[RESULT].message.metadata.invoked_resource.resource_uri = `/${ASDK}/link_99999999222233334444555555555555/read`; }],
    ['missing result resource', (mapping: any) => { delete mapping[RESULT].message.metadata.invoked_resource; }],
    ['result metadata parent mismatch', (mapping: any) => { mapping[RESULT].message.metadata.parent_id = EXEC; }],
    ['result branch parent mismatch', (mapping: any) => { mapping[RESULT].parent = USER; }],
    ['invocation metadata parent mismatch', (mapping: any) => { mapping[CALL].message.metadata.parent_id = EXEC; }],
    ['request mismatch', (mapping: any) => { mapping[RESULT].message.metadata.request_id = 'another-request'; }],
    ['missing request', (mapping: any) => { delete mapping[RESULT].message.metadata.request_id; }],
    ['working turn mismatch', (mapping: any) => { mapping[RESULT].message.metadata.working_turn_id = 'another-work'; }],
    ['missing working turn', (mapping: any) => { delete mapping[RESULT].message.metadata.working_turn_id; }],
    ['exchange mismatch', (mapping: any) => { mapping[RESULT].message.metadata.turn_exchange_id = 'another-exchange'; }],
    ['missing exchange', (mapping: any) => { delete mapping[RESULT].message.metadata.turn_exchange_id; }],
    ['current branch ends elsewhere', (mapping: any) => { mapping[ASSISTANT].parent = USER; }],
    ['another current latest user', (mapping: any, entry: any) => {
      mapping[REFERENCE_SOURCE] = { id: REFERENCE_SOURCE, message: { id: REFERENCE_SOURCE, author: { role: 'user' } } };
      mapping[ASSISTANT].parent = REFERENCE_SOURCE;
      entry.turn.messageIds = [USER, CALL, RESULT, ASSISTANT];
    }],
    ['unselected widget result', (_mapping: any, entry: any) => { entry.turn.messageIds = [USER, CALL, ASSISTANT]; }],
    ['same widget result for two calls', (mapping: any, entry: any) => {
      entry.turn.items.splice(2, 0, { ...entry.turn.items[1], callId: EXEC });
      mapping[EXEC] = { ...mapping[CALL], id: EXEC, message: { ...mapping[CALL].message, id: EXEC } };
    }]
  ] as const)('leaves an omitted shell completion unanswered for %s', async (_label, nativeCallMutation) => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: 'missing', nativeCallMutation });
    try {
      expect(page.fiber.turns[0].calls.every((call: any) => call.answered === false)).toBe(true);
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
    } finally { page.dom.window.close(); }
  });

  it('does not infer an omitted shell completion from a cached result without its mounted current branch', async () => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, nativeCallLive: false, callCompleted: 'missing' });
    try { expect(page.fiber.turns[0].calls[0].answered).toBe(false); }
    finally { page.dom.window.close(); }
  });

  it('does not mistake a completed answer for a native result receipt', async () => {
    const page = await shellHarness({ withCall: true, callCompleted: 'missing' });
    try {
      expect(page.fiber.turns[0].endMessageId).toBe(ASSISTANT);
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
    } finally { page.dom.window.close(); }
  });

  it('does not apply a native shell result receipt before a conflicting cached request is rejected', async () => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: 'missing', nativeCallCacheConflict: true });
    try {
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
      expect(page.fiber.turns[0].calls[0].requestId).toBeNull();
    } finally { page.dom.window.close(); }
  });

  it('does not borrow native result completion before an exact provisional shell conversation is established', async () => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: 'missing', provisional: true });
    try {
      expect(page.fiber.turns[0].conversationId).toBeNull();
      expect(page.fiber.turns[0].calls[0].answered).toBe(false);
    } finally { page.dom.window.close(); }
  });

  it.each(['complete', 'missing', 'pending', 'error', 'scope-conflict', 'unknown-parent', 'unknown-parent-scope-conflict', 'anchored narration', 'foreign narration'] as const)(
    'keeps omitted shell completion dependent on its exact enclosing Code Mode receipt: %s', async receipt => {
      const page = await shellHarness({ withCall: true, withExec: true, nativeCallReceipt: true, callCompleted: 'missing',
        nativeCallMutation(mapping, entry) {
          const scope = { request_id: REQUEST, working_turn_id: TURN, turn_exchange_id: USER };
          Object.assign(mapping[EXEC], { parent: USER });
          Object.assign(mapping[EXEC].message, { status: receipt === 'pending' ? 'in_progress' : 'finished_successfully',
            metadata: { ...scope, parent_id: USER } });
          mapping[CALL].parent = EXEC;
          mapping[CALL].message.metadata.parent_id = EXEC;
          if (receipt !== 'missing') {
            mapping[EXEC_RESULT] = { id: EXEC_RESULT, parent: RESULT, message: {
              id: EXEC_RESULT, author: { role: 'tool', name: 'functions.exec' }, recipient: 'all',
              status: receipt === 'error' ? 'error' : 'finished_successfully',
              metadata: { ...scope, parent_id: RESULT,
                ...(receipt === 'scope-conflict' ? { request_id: 'another-exec-request' } : {}) }
            } };
            mapping[ASSISTANT].parent = EXEC_RESULT;
          }
          entry.turn.messageIds = [USER, EXEC, CALL, RESULT, ...(receipt === 'missing' ? [] : [EXEC_RESULT]), ASSISTANT];
          if (receipt === 'anchored narration' || receipt === 'foreign narration') {
            mapping[INTERIM] = { id: INTERIM, parent: EXEC, message: { id: INTERIM,
              author: { role: 'assistant' }, recipient: 'all', channel: 'commentary',
              metadata: { ...scope, parent_id: EXEC,
                working_turn_id: receipt === 'foreign narration' ? 'foreign' : TURN } } };
            mapping[CALL].parent = INTERIM;
            mapping[CALL].message.metadata.parent_id = INTERIM;
            Object.assign(mapping[ASSISTANT].message.metadata, { ...scope, parent_id: EXEC_RESULT });
          }
          if (receipt === 'unknown-parent' || receipt === 'unknown-parent-scope-conflict') {
            mapping[INTERIM] = { id: INTERIM, parent: EXEC, message: { id: INTERIM,
              author: { role: 'assistant' }, recipient: 'all', metadata: { ...scope, parent_id: EXEC } } };
            mapping[CALL].parent = INTERIM;
            mapping[CALL].message.metadata.parent_id = INTERIM;
            if (receipt === 'unknown-parent-scope-conflict') {
              for (const id of [CALL, RESULT]) mapping[id].message.metadata.request_id = 'conflicting-child-request';
            }
          }
        } });
      try {
        expect(page.fiber.turns[0].calls[0].answered).toBe(receipt === 'complete' || receipt === 'anchored narration');
        expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
      } finally { page.dom.window.close(); }
    }
  );

  it.each(['complete', 'pending', 'error', 'missing', 'contradictory-parent', 'two-complete', 'two-second-pending'] as const)(
    'permits a later ordinary call only after concrete prior exec closure: %s', async receipt => {
      const page = await shellHarness({ withCall: true, withExec: true, nativeCallReceipt: true, callCompleted: 'missing',
        nativeCallMutation(mapping, entry) {
          const scope = { request_id: REQUEST, working_turn_id: TURN, turn_exchange_id: USER };
          Object.assign(mapping[EXEC], { parent: USER });
          Object.assign(mapping[EXEC].message, { status: 'finished_successfully', metadata: { ...scope, parent_id: USER } });
          const hasResult = receipt !== 'missing';
          if (hasResult) mapping[EXEC_RESULT] = { id: EXEC_RESULT, parent: EXEC, message: {
            id: EXEC_RESULT, author: { role: 'tool', name: 'functions.exec' }, recipient: 'all',
            status: receipt === 'pending' ? 'in_progress' : receipt === 'error' ? 'error' : 'finished_successfully',
            metadata: { ...scope, parent_id: receipt === 'contradictory-parent' ? USER : EXEC }
          } };
          let parent = hasResult ? EXEC_RESULT : EXEC;
          const before = [USER, EXEC, ...(hasResult ? [EXEC_RESULT] : [])];
          if (receipt === 'two-complete' || receipt === 'two-second-pending') {
            const nextExec = 'call_shell_exec_next', nextResult = 'f0f00004-1111-4111-8111-111111111207';
            const nextScope = { ...scope, request_id: 'wfr_shell_exec_next' };
            entry.turn.items.splice(2, 0, { type: 'dynamic-tool-call', tool: 'exec', callId: nextExec, completed: true });
            mapping[nextExec] = { id: nextExec, parent, message: { id: nextExec, author: { role: 'assistant' },
              recipient: 'functions.exec', status: 'finished_successfully', metadata: { ...nextScope, parent_id: parent } } };
            mapping[nextResult] = { id: nextResult, parent: nextExec, message: { id: nextResult,
              author: { role: 'tool', name: 'functions.exec' }, recipient: 'all',
              status: receipt === 'two-second-pending' ? 'in_progress' : 'finished_successfully',
              metadata: { ...nextScope, parent_id: nextExec } } };
            before.push(nextExec, nextResult);
            parent = nextResult;
          }
          mapping[CALL].parent = parent;
          mapping[CALL].message.metadata.parent_id = parent;
          entry.turn.messageIds = [...before, CALL, RESULT, ASSISTANT];
        } });
      try { expect(page.fiber.turns[0].calls[0].answered).toBe(receipt === 'complete' || receipt === 'two-complete'); }
      finally { page.dom.window.close(); }
    }
  );

  it.each(['missing', 'pending', 'error', 'inner-only'] as const)(
    'does not release a child through unresolved nested exec owners: %s', async receipt => {
      const page = await shellHarness({ withCall: true, withExec: true, nativeCallReceipt: true, callCompleted: 'missing',
        nativeCallMutation(mapping, entry) {
          const inner = 'call_shell_exec_inner', scope = { request_id: REQUEST, working_turn_id: TURN, turn_exchange_id: USER };
          Object.assign(mapping[EXEC], { parent: USER });
          Object.assign(mapping[EXEC].message, { status: receipt === 'error' ? 'error' : 'finished_successfully',
            metadata: { ...scope, parent_id: USER } });
          entry.turn.items.splice(2, 0, { type: 'dynamic-tool-call', tool: 'exec', callId: inner, completed: true });
          mapping[inner] = { id: inner, parent: EXEC, message: { id: inner, author: { role: 'assistant' },
            recipient: 'functions.exec', status: receipt === 'pending' ? 'in_progress' : 'finished_successfully',
            metadata: { ...scope, parent_id: EXEC } } };
          mapping[CALL].parent = inner;
          mapping[CALL].message.metadata.parent_id = inner;
          if (receipt === 'inner-only') {
            mapping[EXEC_RESULT] = { id: EXEC_RESULT, parent: RESULT, message: { id: EXEC_RESULT,
              author: { role: 'tool', name: 'functions.exec' }, recipient: 'all', status: 'finished_successfully',
              metadata: { ...scope, parent_id: RESULT } } };
            mapping[ASSISTANT].parent = EXEC_RESULT;
          }
          entry.turn.messageIds = [USER, EXEC, inner, CALL, RESULT, ...(receipt === 'inner-only' ? [EXEC_RESULT] : []), ASSISTANT];
        } });
      try { expect(page.fiber.turns[0].calls[0].answered).toBe(false); }
      finally { page.dom.window.close(); }
    }
  );

  it('records a returned tool error as answered without exposing its body or ending a live generation', async () => {
    const page = await shellHarness({ withCall: true, nativeCallReceipt: true, callCompleted: 'missing', status: 'in_progress',
      nativeCallMutation(mapping) { mapping[RESULT].message.content = { parts: ['PRIVATE_TOOL_RESULT'], isError: true }; } });
    try {
      expect(page.fiber.turns[0].calls[0].answered).toBe(true);
      expect(page.fiber.turns[0].endMessageId).toBeNull();
      expect(page.api.generating()).toBe(true);
      expect(JSON.stringify(page.fiber)).not.toContain('PRIVATE_TOOL_RESULT');
      expect(JSON.stringify(page.fiber)).not.toContain('isError');
    } finally { page.dom.window.close(); }
  });

  it('carries exact shell connector request provenance and requires an owner handshake while the conversation is provisional', async () => {
    const concrete = await shellHarness({ withCall: true });
    try {
      expect(concrete.fiber.turns[0]).toMatchObject({
        conversationId: THREAD,
        calls: [{ messageId: CALL, tool: 'read', answered: true, requestId: REQUEST }]
      });
    } finally {
      concrete.dom.window.close();
    }

    const provisional = await shellHarness({ withCall: true, provisional: true });
    try {
      expect(provisional.fiber.turns[0]).toMatchObject({
        conversationId: null,
        requestOwnerRequired: true,
        calls: [{ messageId: CALL, tool: 'read', answered: true }]
      });
    } finally {
      provisional.dom.window.close();
    }
  });

  it('ignores a retained local shell identity once the same branch exposes the exact server conversation', async () => {
    const page = await shellHarness({ withCall: true, retainedLocalIdentity: true });
    try {
      expect(page.fiber.turns[0]).toMatchObject({
        conversationId: THREAD,
        conversationConflict: false,
        calls: [{ messageId: CALL, tool: 'read', answered: true, requestId: REQUEST }]
      });
    } finally {
      page.dom.window.close();
    }
  });

  it('uses typed shell running state and recognizes cot-v5 activity without trusting translated Stop text', async () => {
    const running = await shellHarness({ status: 'in_progress' });
    try {
      expect(running.exchange.getAttribute('data-clf-shell-running-v2')).toBe(`/c/${THREAD}`);
      expect(running.api.generating()).toBe(true);
      const assistant = running.api.turns().find((turn: any) => turn.role === 'assistant');
      expect(running.api.toolBlocks(assistant)).toContain(running.win.document.getElementById('cot-v5-row'));
    } finally {
      running.dom.window.close();
    }

    const visualOnly = await shellHarness({ status: 'complete', visualStopText: true });
    try {
      expect(visualOnly.exchange.hasAttribute('data-clf-shell-running-v2')).toBe(false);
      expect(visualOnly.api.generating()).toBe(false);
    } finally {
      visualOnly.dom.window.close();
    }
  });

  it('uses the shell turn key when the search index exposes only a positional fallback', async () => {
    const page = await shellHarness();
    try {
      page.exchange.querySelector('[data-content-search-turn-key]')!
        .setAttribute('data-content-search-turn-key', 'fallback-turn-0');
      expect([...new Set(page.api.turns().filter((turn: any) => turn.id).map((turn: any) => turn.id))])
        .toEqual([TURN]);

      page.exchange.setAttribute('data-turn-key', 'fallback-turn-3');
      page.exchange.querySelector('[data-content-search-turn-key]')!
        .setAttribute('data-content-search-turn-key', 'stable-search-key');
      expect(page.api.turns().filter((turn: any) => turn.id).map((turn: any) => turn.id))
        .toContain('stable-search-key');
    } finally {
      page.dom.window.close();
    }
  });

  it.each([false, true])('records exact final evidence when positional layout keys exist before the Fiber scan (call=%s)', async withCall => {
    const page = await shellHarness({ layoutKey: 'fallback-turn-0', withCall });
    try {
      expect(page.fiber.turns).toHaveLength(1);
      expect(page.fiber.turns[0]).toMatchObject({ turnId: TURN, conversationId: THREAD, endMessageId: ASSISTANT });
      expect(page.api.messages().map((message: any) => message.id)).toEqual([USER, ASSISTANT]);
      expect(page.win.document.getElementById('user-slot')!.getAttribute('data-clf-fiber-v2-message')).toMatch(new RegExp(`:${USER}$`));
      expect(page.win.document.getElementById('assistant-slot')!.getAttribute('data-clf-fiber-v2-message')).toMatch(new RegExp(`:${ASSISTANT}$`));
      expect(page.fiber.turns[0].calls).toHaveLength(withCall ? 1 : 0);
    } finally { page.dom.window.close(); }
  });

  it('finds the exact typed shell owner beyond the legacy 16-ancestor cap', async () => {
    const page = await shellHarness({ shellOwnerDepth: 24, committedRootDepth: 1, layoutKey: 'fallback-turn-0' });
    try {
      expect(page.fiber.turns).toHaveLength(1);
      expect(page.fiber.turns[0]).toMatchObject({
        turnId: TURN,
        conversationId: THREAD,
        endMessageId: ASSISTANT
      });
      expect(page.exchange.getAttribute('data-clf-fiber-v2-turn')).toBe('shell-scan:0');
      expect(page.fiber.shellScan).toEqual({
        reader: { fiberWire: 19, fiberProducer: currentFiberProducer, fiberKeys: Object.keys(page.fiber.shellScan.rejects).length },
        selectorMatches: 1,
        mapped: 1,
        rejects: { ...EMPTY_CALL_REJECTS, ...EMPTY_CALL_JOINS, ...EMPTY_COMPLETION_VETO_SHAPES, ...EMPTY_COMPLETION_VETO_STATUSES,
          ...EMPTY_USER_PROJECTION, ...EMPTY_REQUEST_ID_SHAPES, ...EMPTY_VETO_RECEIPT_CHECKS, ...EMPTY_ASSISTANT_TERMINAL_RECEIPTS, userProjected: 1,
          fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0 }
      });
    } finally { page.dom.window.close(); }
  });

  it('joins a shell exchange whose public turn key is its exact typed user message id', async () => {
    const page = await shellHarness({
      domTurnKey: USER,
      layoutKey: 'fallback-turn-0',
      shellOwnerDepth: 24,
      committedRootDepth: 1
    });
    try {
      expect(page.fiber.turns).toHaveLength(1);
      expect(page.fiber.turns[0]).toMatchObject({
        turnId: TURN,
        conversationId: THREAD,
        endMessageId: ASSISTANT
      });
      expect(page.exchange.getAttribute('data-clf-fiber-v2-turn')).toBe('shell-scan:0');
      expect(page.fiber.shellScan).toEqual({
        reader: { fiberWire: 19, fiberProducer: currentFiberProducer, fiberKeys: Object.keys(page.fiber.shellScan.rejects).length },
        selectorMatches: 1,
        mapped: 1,
        rejects: { ...EMPTY_CALL_REJECTS, ...EMPTY_CALL_JOINS, ...EMPTY_COMPLETION_VETO_SHAPES, ...EMPTY_COMPLETION_VETO_STATUSES,
          ...EMPTY_USER_PROJECTION, ...EMPTY_REQUEST_ID_SHAPES, ...EMPTY_VETO_RECEIPT_CHECKS, ...EMPTY_ASSISTANT_TERMINAL_RECEIPTS, userProjected: 1,
          fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0 }
      });
    } finally { page.dom.window.close(); }
  });

  it.each(['exact', 'completed exact', 'no live owner', 'conflicting live owner', 'missing native user', 'two native users',
    'foreign branch', 'discordant native user', 'foreign public key'] as const)(
    'joins a virtualized user key only through its exact mounted native request branch: %s', async variant => {
      const page = await shellHarness({ domTurnKey: variant === 'foreign public key' ? 'foreign-public-key' : USER,
        layoutKey: 'fallback-turn-0', withoutUserSlot: true, withCall: true, nativeCallReceipt: true,
        nativeCallLive: variant !== 'no live owner', nativeCallLiveConflict: variant === 'conflicting live owner',
        nativeCurrentNode: variant === 'completed exact' ? ASSISTANT : variant === 'conflicting live owner' ? USER : CALL,
        status: variant === 'completed exact' ? 'complete' : 'in_progress',
        callCompleted: variant === 'completed exact' ? 'missing' : false, assistantCompleted: variant === 'completed exact',
        nativeCallMutation(mapping, entry) {
          entry.turn.items = entry.turn.items.filter((item: any) => item.type !== 'user-message');
          if (variant !== 'completed exact') {
            entry.turn.items = entry.turn.items.filter((item: any) => item.type === 'mcp-tool-call');
            delete entry.turn.items[0].widgetStateSource;
            entry.turn.messageIds = [USER, CALL];
            delete mapping[RESULT]; delete mapping[ASSISTANT];
            mapping[CALL].message.status = 'in_progress';
          }
          if (variant === 'missing native user') delete mapping[USER];
          if (variant === 'discordant native user') mapping[USER].message.id = 'foreign-message-id';
          if (variant === 'two native users' || variant === 'foreign branch') {
            const id = 'foreign-native-user';
            mapping[id] = { id, message: { id, author: { role: 'user' } } };
            if (variant === 'two native users') entry.turn.messageIds.push(id);
            else { mapping[CALL].parent = id; mapping[CALL].message.metadata.parent_id = id; }
          }
        } });
      try {
        for (const view of [page.fiber, await shellRescan(page, 'virtualized-user-key-reobserve')]) {
          if (variant === 'exact' || variant === 'completed exact') {
            expect(view.shellScan.mapped).toBe(1);
            expect(view.turns[0]).toMatchObject({ turnId: TURN, conversationId: THREAD,
              endMessageId: variant === 'completed exact' ? ASSISTANT : null,
              calls: [{ messageId: CALL, requestId: REQUEST, answered: variant === 'completed exact' }] });
            expect(view.turns[0].messages.some((message: any) => message.role === 'user')).toBe(false);
          } else {
            expect(view.shellScan.mapped).toBe(0);
            expect(view.turns).toEqual([]);
          }
          expect(JSON.stringify(view)).not.toContain('PRIVATE_TOOL_RESULT');
        }
        if (variant === 'exact') {
          const owner = (page.exchange as any).__reactFiber$shellfixture;
          owner.memoizedState.memoizedState.renderedConversation.current_node = 'gone-native-parent';
          const changed = await shellRescan(page, 'virtualized-user-key-branch-changed');
          expect(changed.shellScan.mapped).toBe(0);
          expect(changed.turns).toEqual([]);
          expect(page.exchange.hasAttribute('data-clf-fiber-v2-turn')).toBe(false);
        }
      } finally { page.dom.window.close(); }
    });

  it('joins the exact public turn key when the typed user exposes only its server message id', async () => {
    const page = await shellHarness({
      domTurnKey: USER,
      layoutKey: 'fallback-turn-0',
      userIdentity: 'server-only'
    });
    try {
      expect(page.fiber.turns).toHaveLength(1);
      expect(page.fiber.turns[0]).toMatchObject({ turnId: TURN, endMessageId: ASSISTANT });
      expect(page.fiber.shellScan).toEqual({
        reader: { fiberWire: 19, fiberProducer: currentFiberProducer, fiberKeys: Object.keys(page.fiber.shellScan.rejects).length },
        selectorMatches: 1,
        mapped: 1,
        rejects: { ...EMPTY_CALL_REJECTS, ...EMPTY_CALL_JOINS, ...EMPTY_COMPLETION_VETO_SHAPES, ...EMPTY_COMPLETION_VETO_STATUSES,
          ...EMPTY_USER_PROJECTION, ...EMPTY_REQUEST_ID_SHAPES, ...EMPTY_VETO_RECEIPT_CHECKS, ...EMPTY_ASSISTANT_TERMINAL_RECEIPTS, userProjected: 1,
          fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 0, itemsOverLimit: 0 }
      });
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['discordant user ids', { domTurnKey: USER, layoutKey: 'fallback-turn-0', userIdentity: 'discordant' }],
    ['two typed user items', { domTurnKey: USER, layoutKey: 'fallback-turn-0', userIdentity: 'duplicate' }],
    ['a matching positional key on a foreign exchange', { domTurnKey: 'foreign-shell-turn', layoutKey: USER }]
  ] as const)('rejects %s as shell stable identity', async (_label, options) => {
    const page = await shellHarness(options);
    try {
      expect(page.fiber.turns).toEqual([]);
      expect(page.exchange.hasAttribute('data-clf-fiber-v2-turn')).toBe(false);
      expect(page.fiber.shellScan).toEqual({
        reader: { fiberWire: 19, fiberProducer: currentFiberProducer, fiberKeys: Object.keys(page.fiber.shellScan.rejects).length },
        selectorMatches: 1,
        mapped: 0,
        rejects: { ...EMPTY_CALL_REJECTS, ...EMPTY_CALL_JOINS, ...EMPTY_COMPLETION_VETO_SHAPES, ...EMPTY_COMPLETION_VETO_STATUSES,
          ...EMPTY_USER_PROJECTION, ...EMPTY_REQUEST_ID_SHAPES, ...EMPTY_VETO_RECEIPT_CHECKS, ...EMPTY_ASSISTANT_TERMINAL_RECEIPTS,
          fiberMissing: 0, ownerMissing: 0, stableKeyMismatch: 1, itemsOverLimit: 0 }
      });
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['retains', 'exact', true, 2, 0],
    ['rejects', 'foreign-entry', false, 1, 1],
    ['rejects', 'foreign-conversation', false, 1, 1],
    ['rejects', 'foreign-assistant', false, 1, 1]
  ] as const)('%s an adjacent same-key shell container only when its stable owner also matches',
    async (_label, secondShell, secondStamped, mapped, stableKeyMismatch) => {
      const page = await shellHarness({
        domTurnKey: USER,
        layoutKey: 'fallback-turn-0',
        secondShell
      });
      try {
        expect(page.fiber.turns).toHaveLength(1);
        expect(page.fiber.turns[0]).toMatchObject({ turnId: TURN, endMessageId: ASSISTANT });
        expect(page.exchange.getAttribute('data-clf-fiber-v2-turn')).toBe('shell-scan:0');
        expect(page.secondExchange?.hasAttribute('data-clf-fiber-v2-turn')).toBe(secondStamped);
        expect(page.fiber.shellScan).toEqual({
        reader: { fiberWire: 19, fiberProducer: currentFiberProducer, fiberKeys: Object.keys(page.fiber.shellScan.rejects).length },
          selectorMatches: 2,
          mapped,
          rejects: { ...EMPTY_CALL_REJECTS, ...EMPTY_CALL_JOINS, ...EMPTY_COMPLETION_VETO_SHAPES, ...EMPTY_COMPLETION_VETO_STATUSES,
            ...EMPTY_USER_PROJECTION, ...EMPTY_REQUEST_ID_SHAPES, ...EMPTY_VETO_RECEIPT_CHECKS, ...EMPTY_ASSISTANT_TERMINAL_RECEIPTS, userProjected: 1,
          fiberMissing: 0, ownerMissing: 0, stableKeyMismatch, itemsOverLimit: 0 }
        });
      } finally { page.dom.window.close(); }
    });

  it('rejects a foreign stable shell turn even when its positional layout slots match', async () => {
    const page = await shellHarness({
      domTurnKey: 'foreign-shell-turn',
      layoutKey: 'fallback-turn-0',
      shellOwnerDepth: 24,
      committedRootDepth: 1
    });
    try {
      expect(page.fiber.turns).toEqual([]);
      expect(page.exchange.hasAttribute('data-clf-fiber-v2-turn')).toBe(false);
      expect(page.win.document.getElementById('assistant-slot')!.hasAttribute('data-clf-fiber-v2-message')).toBe(false);
      expect(page.fiber.shellScan.rejects).toEqual({
        ...EMPTY_CALL_REJECTS,
        ...EMPTY_CALL_JOINS,
        ...EMPTY_COMPLETION_VETO_SHAPES,
        ...EMPTY_COMPLETION_VETO_STATUSES,
        ...EMPTY_VETO_RECEIPT_CHECKS,
        ...EMPTY_ASSISTANT_TERMINAL_RECEIPTS,
        ...EMPTY_USER_PROJECTION, ...EMPTY_REQUEST_ID_SHAPES,
        fiberMissing: 0,
        ownerMissing: 0,
        stableKeyMismatch: 1,
        itemsOverLimit: 0
      });
    } finally { page.dom.window.close(); }
  });

  it.each([
    ['selector missing', { omitShellSelector: true }, { selectorMatches: 0, mapped: 0 }],
    ['Fiber missing', { omitFiber: true }, { selectorMatches: 1, mapped: 0, fiberMissing: 1 }],
    ['owner missing', { missingShellEntry: true }, { selectorMatches: 1, mapped: 0, ownerMissing: 1 }],
    ['items over limit', { oversizedShellItems: true }, { selectorMatches: 1, mapped: 0, itemsOverLimit: 1 }]
  ] as const)('reports bounded shape-only diagnostics when the shell %s', async (_label, options, expected) => {
    const page = await shellHarness(options);
    try {
      expect(page.fiber.turns).toEqual([]);
      expect(page.fiber.shellScan.selectorMatches).toBe(expected.selectorMatches);
      expect(page.fiber.shellScan.mapped).toBe(expected.mapped);
      if ('fiberMissing' in expected)
        expect(page.fiber.shellScan.rejects.fiberMissing).toBe(expected.fiberMissing);
      if ('ownerMissing' in expected)
        expect(page.fiber.shellScan.rejects.ownerMissing).toBe(expected.ownerMissing);
      if ('itemsOverLimit' in expected)
        expect(page.fiber.shellScan.rejects.itemsOverLimit).toBe(expected.itemsOverLimit);
      expect(JSON.stringify(page.fiber.shellScan)).not.toContain(USER);
      expect(JSON.stringify(page.fiber.shellScan)).not.toContain('hello shell');
    } finally { page.dom.window.close(); }
  });

  it.each(['pending Core', 'completed Core', 'pending Code', 'duplicate Core'] as const)(
    'retains public output but marks an omitted %s beyond the row budget incomplete', async kind => {
      const page = await shellHarness({ shellItemsMutation(items) {
        const existing = { type: 'mcp-tool-call', callId: 'overflow-first', completed: true,
          invocation: { server: APP, tool: 'read' } };
        items.splice(1, 0, existing);
        const steps: any[] = Array.from({ length: 400 }, () => ({ type: 'unknown-fixture-item' }));
        steps.push(kind === 'pending Code'
          ? { type: 'dynamic-tool-call', tool: 'exec', callId: 'overflow-code', completed: false }
          : { type: 'mcp-tool-call', callId: kind === 'duplicate Core' ? 'overflow-first' : 'overflow-next',
            completed: kind === 'completed Core', invocation: { server: APP, tool: 'read' } });
        items.splice(2, 0, { type: 'chatgpt-reasoning-group', items: steps });
      } });
      try {
        if (kind === 'duplicate Core') expect(page.fiber.turns).toEqual([]);
        else {
          expect(page.fiber.turns).toHaveLength(1);
          expect(page.fiber.turns[0].callEvidenceComplete).toBe(false);
          expect(page.fiber.turns[0].messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: 'assistant', rawMessageId: ASSISTANT })
          ]));
        }
      } finally { page.dom.window.close(); }
    });

  it.each(['Core', 'Code'] as const)('marks the 201st %s call as an incomplete bounded inventory', async kind => {
    const page = await shellHarness({ shellItemsMutation(items) {
      const calls = Array.from({ length: 201 }, (_, at) => kind === 'Core'
        ? { type: 'mcp-tool-call', callId: `many-core-${at}`, completed: at < 200,
          invocation: { server: APP, tool: 'read' } }
        : { type: 'dynamic-tool-call', tool: 'exec', callId: `many-code-${at}`, completed: at < 200 });
      items.splice(1, 0, { type: 'chatgpt-reasoning-group', items: calls });
    } });
    try {
      expect(page.fiber.turns).toHaveLength(1);
      expect(page.fiber.turns[0].callEvidenceComplete).toBe(false);
    } finally { page.dom.window.close(); }
  });

  it('retains a complete public answer beyond many non-tool reasoning rows', async () => {
    const page = await shellHarness({ shellItemsMutation(items) {
      items.splice(1, 0, { type: 'chatgpt-reasoning-group', items:
        Array.from({ length: 450 }, () => ({ type: 'unknown-fixture-item' })) });
    } });
    try {
      expect(page.fiber.turns).toHaveLength(1);
      expect(page.fiber.turns[0].callEvidenceComplete).not.toBe(false);
      expect(page.fiber.turns[0].endMessageId).toBe(ASSISTANT);
    } finally { page.dom.window.close(); }
  });

  it('keeps the exact shell answer when its question slot unmounts', async () => {
    const page = await shellHarness();
    try {
      page.win.document.getElementById('user-slot')!.remove();
      expect(page.api.turns().map((turn: any) => ({ id: turn.id, role: turn.role }))).toEqual([
        { id: TURN, role: 'assistant' }
      ]);
      expect(page.api.messages().map((message: any) => ({ id: message.id, role: message.role })))
        .toContainEqual({ id: ASSISTANT, role: 'assistant' });
    } finally {
      page.dom.window.close();
    }
  });

  it('names the exact page-model user when ChatGPT draws the exchange without its user slot', async () => {
    const page = await shellHarness({ withoutUserSlot: true });
    try {
      const stamp = page.exchange.getAttribute('data-clf-fiber-v2-turn');
      expect(stamp).toBeTruthy();
      expect(page.exchange.getAttribute('data-clf-fiber-v2-user'))
        .toBe(`${stamp}:${encodeURIComponent(USER)}`);
      expect(page.api.turns().map((turn: any) => ({ id: turn.id, role: turn.role }))).toEqual([
        { id: TURN, role: 'user' },
        { id: TURN, role: 'assistant' }
      ]);
      expect(page.api.messages().map((message: any) => ({ id: message.id, role: message.role, text: message.text })))
        .toEqual([
          { id: USER, role: 'user', text: '' },
          { id: ASSISTANT, role: 'assistant', text: 'hello back' }
        ]);
      expect(page.fiber.turns[0].messages).toContainEqual(expect.objectContaining({
        rawMessageId: USER,
        role: 'user',
        stable: true,
        rawText: 'hello shell'
      }));
    } finally {
      page.dom.window.close();
    }
  });

  it('rejects a stale or foreign unrendered-user stamp', async () => {
    const page = await shellHarness({ withoutUserSlot: true });
    try {
      expect(page.api.messages()).toContainEqual(expect.objectContaining({ id: USER, role: 'user' }));
      page.exchange.setAttribute('data-clf-fiber-v2-user', `foreign-scan:0:${encodeURIComponent(USER)}`);
      expect(page.api.messages().some((message: any) => message.role === 'user')).toBe(false);
    } finally {
      page.dom.window.close();
    }
  });

  it('does not attribute a nested shell answer to an outer exchange whose question unmounted', async () => {
    const page = await shellHarness();
    try {
      page.win.document.getElementById('user-slot')!.remove();
      page.exchange.querySelector('[data-chatgpt-agent-turn-start]')!.remove();
      page.win.document.getElementById('assistant-slot')!.remove();

      const nested = page.win.document.createElement('div');
      nested.setAttribute('data-turn-key', 'nested-shell-turn');
      nested.innerHTML = `
        <div data-content-search-turn-key="nested-shell-turn"></div>
        <div data-content-search-unit-key="nested-shell-turn:1:assistant">
          <div class="markdown" data-markdown-text-style="assistant-message">nested answer</div>
        </div>`;
      page.exchange.append(nested);

      const turns = page.api.turns();
      expect(turns.some((turn: any) => turn.id === TURN)).toBe(false);
      expect(turns).toContainEqual(expect.objectContaining({
        node: nested,
        id: 'nested-shell-turn',
        role: 'assistant'
      }));
    } finally {
      page.dom.window.close();
    }
  });

  it('still rejects a shell exchange with ambiguous user slots', async () => {
    const page = await shellHarness();
    try {
      const user = page.win.document.getElementById('user-slot')!;
      user.after(user.cloneNode(true));
      expect(page.api.turns()).toEqual([]);
    } finally {
      page.dom.window.close();
    }
  });

  it('rejects a reused DOM Fiber pointer when the committed React branch no longer owns the shell exchange', async () => {
    const page = await shellHarness({ staleFiber: true });
    try {
      expect(page.fiber.turns).toEqual([]);
      expect(page.exchange.hasAttribute('data-clf-fiber-v2-turn')).toBe(false);
      expect(page.api.messages()).toEqual([]);
    } finally {
      page.dom.window.close();
    }
  });
});

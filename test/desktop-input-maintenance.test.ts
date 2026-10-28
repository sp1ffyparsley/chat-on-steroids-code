import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_PROTOCOL } from '../src/main/version.js';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
// Model the recorder the package actually ships. The worker under test must still
// independently accept that content version; a mismatched production pair fails.
const recorderSource = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const recorderVersionMatch = /const RECORDER_VERSION = (\d+);/.exec(recorderSource);
if (!recorderVersionMatch) throw new Error('Packaged content recorder version is missing');
const currentRecorderVersion = Number(recorderVersionMatch[1]);
// This focused harness executes the service worker as a classic script so it can expose a
// deliberately small set of otherwise-private maintenance functions. The shipped worker is an
// MV3 module, however, and Node's classic `vm` parser cannot parse its static imports. Browser
// control is outside this harness (the fake Chrome surface intentionally has no debugger API), so
// leave its binding as an explicit fail-fast test double and evaluate only the worker body here.
const vmSource = source.replace(/^[ \t]*import[ \t]+[^\r\n]+;[ \t]*(?:\r?\n|$)/gm, '');
const firstId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const secondId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

it('missing models retain the elected Work document without a New Chat or helper fallback', async () => {
  const h = await worker([]);
  const original = { id: 8, url: `https://chatgpt.com/c/${secondId}` }; h.tabs.push(original);
  await h.authorizeDocument({ tab: { id: 8 }, documentId: 'work-page', frameId: 0, url: original.url }, { navigationEpoch: 1 });
  h.sendMessage.mockImplementation(async (tabId, message): Promise<any> => {
    const tab = h.tabs.find(row => row.id === tabId)!;
    if (message.type === 'clf-model-catalog-state') return { ok: true, ready: true };
    if (message.type === 'clf-model-catalog') {
      if (tabId === 8) return { ok: false, prepare: true, preSend: true, url: tab.url };
      return { ok: true };
    }
    if (message.type === 'clf-prepare-model-catalog') return { ready: false, fallback: true, preSend: true, url: tab.url };
    if (message.type === 'clf-input-reuse-state') return { safe: tabId !== 8, navigationEpoch: 1 };
    if (message.type === 'clf-prepare-desktop-input') { tab.url = `https://chatgpt.com/?cos-input=${firstId}`; return { ready: true }; }
    return { ok: true };
  });
  const request = { nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: true };
  await h.inspectModels(request, true);
  await h.inspectModels(request, true);
  expect(h.saved.modelCatalogOwner).toMatchObject({ nonce: firstId, tab: 8 });
  expect(h.create).not.toHaveBeenCalled();
  expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-model-catalog')).toHaveLength(0);
  expect(original.url).toBe(`https://chatgpt.com/c/${secondId}`);
});

it.each(['passive', 'missing-receipt', 'closed', 'cancelled'])('catalog %s cannot authorize a fallback tab', async reason => {
  const h = await worker([]);
  h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
  await h.authorizeDocument({ tab: { id: 8 }, documentId: 'work-page', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
  h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> => {
    if (message.type === 'clf-model-catalog-state') return { ready: true };
    if (message.type === 'clf-model-catalog') return { prepare: true, preSend: true, url: h.tabs[0]?.url };
    if (message.type === 'clf-prepare-model-catalog') {
      if (reason === 'closed') h.tabs.splice(0);
      if (reason === 'missing-receipt') return undefined;
      return { ready: false, fallback: reason !== 'cancelled', preSend: true, url: `https://chatgpt.com/c/${secondId}` };
    }
    return { ok: true };
  });
  const request = { nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: reason !== 'passive' };
  await h.inspectModels(request, true); await h.inspectModels(request, true);
  expect(h.create).not.toHaveBeenCalled();
  expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-model-catalog')).toHaveLength(0);
});
it('waits for an existing hydrating or busy ChatGPT tab rather than opening another catalog helper', async () => {
  const h = await worker([]);
  h.tabs.push({ id: 8, url: 'https://chatgpt.com/' });
  h.sendMessage.mockResolvedValue({ ok: true, ready: false });
  await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: true }, true);
  expect(h.create).not.toHaveBeenCalled();
});
it('elects the usable chat when an older Settings tab reports its composer hidden', async () => {
  const h = await worker([]);
  h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}#settings/Plugins` }, { id: 8, url: `https://chatgpt.com/c/${secondId}` });
  h.sendMessage.mockImplementation(async (id, message) => message.type === 'clf-model-catalog-state' ? { ok: true, ready: id === 8 } : { ok: true });
  await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: true }, true);
  expect(h.saved.modelCatalogOwner).toMatchObject({ nonce: firstId, tab: 8 });
  expect(h.sendMessage).toHaveBeenCalledWith(8, expect.objectContaining({ type: 'clf-model-catalog' }));
  expect(h.sendMessage.mock.calls.filter(([id, message]) => id === 7 && message.type === 'clf-model-catalog')).toHaveLength(0);
  expect(h.create).not.toHaveBeenCalled();
});
it('accepts the elected model catalog from the same document after ChatGPT changes its SPA URL', async () => {
  const h = await worker([]);
  const tab = { id: 8, url: 'https://chatgpt.com/' }; h.tabs.push(tab);
  const sender = { tab: { id: tab.id }, documentId: 'catalog-document', frameId: 0, url: tab.url };
  const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
  let rejectedOffOrigin = false, acceptedSameDocument = false, rejectedReplacedDocument = false;
  h.sendMessage.mockImplementation(async (_id, message) => {
    if (message.type === 'clf-model-catalog-state') return { ok: true, ready: true };
    if (message.type === 'clf-model-catalog') {
      tab.url = 'https://example.com/';
      rejectedOffOrigin = (await h.catalog({ nonce: firstId, models: [] }, sender, source)).ok === false;
      tab.url = 'https://chatgpt.com/?model=gpt-5.6-sol';
      acceptedSameDocument = (await h.catalog({ nonce: firstId, models: [] }, sender, source)).ok === true;
      const replacementSender = { ...sender, documentId: 'replacement-document', url: tab.url };
      const replacementSource = await h.authorizeDocument(replacementSender, { navigationEpoch: 2 });
      rejectedReplacedDocument = (await h.catalog({ nonce: firstId, models: [] }, replacementSender, replacementSource)).ok === false;
    }
    return { ok: true };
  });

  await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 60_000, allowOpen: true }, true);

  expect(rejectedOffOrigin).toBe(true);
  expect(acceptedSameDocument).toBe(true);
  expect(rejectedReplacedDocument).toBe(true);
  expect(h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/models')).toHaveLength(1);
  expect(h.create).not.toHaveBeenCalled();
});
it.each(['empty', 'draft', 'navigated', 'rejected', 'transport', 'pinned', 'pinned-during-proof'])('terminal worker failure retires only the exact empty document (%s)', async mode => {
  const h = await worker([]);
  const source = { tab: 8, documentId: 'failed-worker', navigationEpoch: 1 };
  h.tabs.push({ id: 8, url: `https://chatgpt.com/?clf=${firstId}`, pinned: mode === 'pinned' });
  await h.authorizeDocument({ tab: { id: 8 }, documentId: source.documentId, frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
  h.fetch.mockImplementation(async input => ({ ok: mode !== 'transport', status: mode === 'transport' ? 503 : 200,
    json: async () => new URL(input).pathname === '/hello'
      ? { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
      : { ok: true, outcome: mode === 'rejected' ? 'committed' : 'terminal-failure', committed: false } }));
  h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> => {
    if (message.type === 'clf-tab-close-check') {
      if (mode === 'navigated') h.tabs[0]!.url = `https://chatgpt.com/c/${secondId}`;
      if (mode === 'pinned-during-proof') h.tabs[0]!.pinned = true;
      return { safe: mode !== 'draft', conversationId: null, navigationEpoch: 1 };
    }
    return { ok: true };
  });
  await (h as any).ackCommand(firstId, 'failed', 'model unavailable', null, null, 'worker-client', source);
  expect(h.remove).toHaveBeenCalledTimes(mode === 'empty' ? 1 : 0);
  if (mode === 'empty') expect(h.sendMessage).toHaveBeenCalledWith(8, { type: 'clf-tab-close-check', conversationId: null, failedCommand: { id: firstId, client: 'worker-client' } }, { documentId: source.documentId });
});
it.each(['owned', 'unmarked', 'foreign', 'draft', 'pinned'])('terminal Project-entry failure retires only its exact empty owned tab (%s)', async mode => {
  const h = await worker([]);
  const source = { tab: 8, documentId: 'failed-entry', navigationEpoch: 1 };
  const marker = mode === 'unmarked' ? '' : `?clf=${mode === 'foreign' ? 'someone-else' : firstId}&clf_project=1`;
  h.tabs.push({ id: 8, url: `https://chatgpt.com/g/g-p-11111111222233334444555555555555-example/c/${secondId}${marker}`, pinned: mode === 'pinned' });
  await h.authorizeDocument({ tab: { id: 8 }, documentId: source.documentId, frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
  h.fetch.mockImplementation(async input => ({ ok: true, status: 200,
    json: async () => new URL(input).pathname === '/hello'
      ? { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
      : { ok: true, outcome: 'terminal-failure', committed: false } }));
  h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> =>
    message.type === 'clf-tab-close-check' ? { safe: mode !== 'draft', conversationId: secondId, navigationEpoch: 1 } : { ok: true });
  await (h as any).ackCommand(firstId, 'failed', 'project entry', null, null, 'resume-client', source);
  expect(h.remove).toHaveBeenCalledTimes(mode === 'owned' ? 1 : 0);
});

it('executes a due refresh before an unrelated input readiness probe settles', async () => {
  const h = await worker([{ id: firstId, conversationId: null }]);
  h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` }, { id: 9, url: 'https://chatgpt.com/' });
  await h.authorizeDocument({ tab: { id: 9 }, documentId: 'idle-page', frameId: 0, url: h.tabs[1]!.url }, { navigationEpoch: 1 });
  const originalFetch = h.fetch.getMockImplementation()!;
  h.fetch.mockImplementation(async (url, init) => {
    const reply = await originalFetch(url, init);
    if (new URL(url).pathname === '/status') return { ...reply, json: async () => ({ ok: true,
      inputs: [{ id: firstId, conversationId: null }], repairs: [{ conversationId: secondId, token: 'due-repair' }] }) };
    return reply;
  });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  h.sendMessage.mockImplementation(async (_tabId, message) => {
    if (message.type === 'clf-input-reuse-state') { entered(); await held; }
    return { ok: true };
  });
  const flight = h.maintain();
  try {
    await reached;
    expect(h.reload).toHaveBeenCalledExactlyOnceWith(8);
    expect(h.fetch.mock.calls.some(([url]) => new URL(url).searchParams.get('repaired') === 'due-repair')).toBe(true);
  } finally { release(); await flight; }
});

it('prefers the active duplicate tab when electing a new durable input', async () => {
  const h = await worker([{ id: firstId, conversationId: secondId }]);
  h.tabs.push(
    { id: 7, active: false, url: `https://chatgpt.com/c/${secondId}` },
    { id: 8, active: true, url: `https://chatgpt.com/c/${secondId}` }
  );

  await h.maintain();

  expect(h.sendMessage).toHaveBeenCalledWith(8, {
    type: 'clf-desktop-input', id: firstId, conversationId: secondId
  });
  expect(h.sendMessage.mock.calls.some(([id, message]) => id === 7 && message.type === 'clf-desktop-input')).toBe(false);
  expect(h.create).not.toHaveBeenCalled();
});

it('finishes root cleanup and grouping before unresolved input preparation can block hygiene', async () => {
  const inputs: Array<{ id: string; conversationId: string | null }> = [];
  const h = await worker(inputs);
  const idle = await h.createChatTab(`https://chatgpt.com/?cos-input=${secondId}`, false);
  idle.windowId = 7;
  idle.groupId = -1;
  idle.url = 'https://chatgpt.com/';
  delete idle.pendingUrl;
  idle.active = false;
  idle.lastAccessed = Date.now() - 60 * 60_000;
  const reusable = { id: 7, windowId: 7, groupId: -1, url: `https://chatgpt.com/c/${secondId}`, active: false };
  h.tabs.push(reusable);
  await h.authorizeDocument({ tab: { id: idle.id }, documentId: 'idle-root', frameId: 0, url: idle.url }, { navigationEpoch: 1 });
  await h.authorizeDocument({ tab: { id: reusable.id }, documentId: 'reusable-chat', frameId: 0, url: reusable.url }, { navigationEpoch: 1 });
  // This root is eligible only because the app authored it. A bare personal New Chat tab is
  // deliberately never enrolled by the current cleanup policy.
  (h.saved.appOwnedOpeningTabs as Record<string, { createdAt: number }>)[String(idle.id)]!.createdAt =
    Date.now() - 5 * 60_000;
  h.fetch.mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () =>
    new URL(url).pathname === '/hello'
      ? { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
      : { ok: true, inputs, background: true, reusableConversations: [secondId],
          managedConversations: [secondId], workerConversations: [secondId] }
  }));
  h.remove.mockImplementation(async id => { const index = h.tabs.findIndex(tab => tab.id === id); if (index >= 0) h.tabs.splice(index, 1); });

  inputs.push({ id: firstId, conversationId: null });

  let entered!: () => void;
  let release!: () => void;
  const preparing = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  h.sendMessage.mockImplementation(async (tabId, message): Promise<any> => {
    if (message.type === 'clf-tab-close-check') return { safe: true, conversationId: null, navigationEpoch: 1 };
    if (message.type === 'clf-input-reuse-state') return { safe: true, navigationEpoch: 1 };
    if (message.type === 'clf-prepare-desktop-input') {
      entered();
      await preparing;
      const tab = h.tabs.find(row => row.id === tabId)!;
      tab.url = `https://chatgpt.com/?cos-input=${firstId}`;
      return { ready: true };
    }
    return { ok: true };
  });

  const flight = h.maintain();
  try {
    await reached;
    expect(h.remove).toHaveBeenCalledWith(idle.id);
    expect(h.group).toHaveBeenCalledWith(expect.objectContaining({ tabIds: [7] }));
  } finally {
    release();
    await flight;
  }
});

it('does not retire an active queued input election after ChatGPT strips its UUID marker', async () => {
  const input = { id: firstId, conversationId: null };
  const h = await worker([input], undefined, {
    inputOpenings: { [firstId]: { tab: 1, stage: 'ready' } }
  });
  const tab = await h.createChatTab(`https://chatgpt.com/?cos-input=${firstId}#cos-input=${firstId}`, false);
  tab.url = 'https://chatgpt.com/';
  delete tab.pendingUrl;
  tab.active = false;
  tab.pinned = false;
  await h.authorizeDocument({ tab: { id: tab.id }, documentId: 'queued-input-root', frameId: 0, url: tab.url }, { navigationEpoch: 1 });
  // The shared session object is the durable worker state in this harness. Age the provenance
  // beyond ordinary UUID cleanup so the active input election is the only remaining veto.
  (h.saved.appOwnedOpeningTabs as Record<string, { createdAt: number; marker: string }>)[String(tab.id)]!.createdAt =
    Date.now() - 5 * 60_000;
  h.fetch.mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () =>
    new URL(url).pathname === '/hello'
      ? { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
      : { ok: true, inputs: [input], inputOpeningIds: [firstId], background: false }
  }));
  h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> =>
    message.type === 'clf-tab-close-check'
      ? { safe: true, conversationId: null, navigationEpoch: 1 }
      : { ok: true }
  );

  await h.maintain();

  expect(h.remove).not.toHaveBeenCalled();
  expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-tab-close-check')).toBe(false);
  expect((h.localSaved.inputOpenings as any)[firstId]).toMatchObject({ tab: 1, stage: 'ready' });
});

it.each(['plain-home', 'temporary-marker-only'])('hands a stripped temporary helper to its same safely empty elected document (%s)', async route => {
  const input = { id: firstId, conversationId: null, lifetime: 'temporary-planner' } as any;
  const h = await worker([input], undefined, {
    inputOpenings: {
      [firstId]: { tab: 1, stage: 'ready', electedAt: Date.now() - 60_000 }
    }
  });
  const tab = await h.createChatTab(
    `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}#cos-input=${firstId}`,
    false
  );
  tab.url = route === 'plain-home' ? 'https://chatgpt.com/' : 'https://chatgpt.com/?temporary-chat=true';
  delete tab.pendingUrl;
  tab.active = false;
  tab.pinned = false;
  await h.authorizeDocument(
    { tab: { id: tab.id }, documentId: 'stripped-temporary-helper', frameId: 0, url: tab.url },
    { navigationEpoch: 1 }
  );
  h.fetch.mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () =>
    new URL(url).pathname === '/hello'
      ? { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
      : { ok: true, inputs: [input], inputOpeningIds: [firstId], background: true }
  }));
  h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> => {
    if (message.type === 'clf-tab-close-check') return { safe: true, conversationId: null, navigationEpoch: 1 };
    return { ok: true };
  });

  await h.maintain();

  expect(h.update).not.toHaveBeenCalled();
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(h.remove).not.toHaveBeenCalled();
  expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-input-reuse-state')).toBe(false);
  expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-tab-close-check'))
    .toEqual([[tab.id, { type: 'clf-tab-close-check', conversationId: null },
      { documentId: 'stripped-temporary-helper' }]]);
  expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input'))
    .toEqual([[tab.id, expect.objectContaining({
      id: firstId,
      conversationId: null,
      lifetime: 'temporary-planner',
      strippedTemporaryHelper: true
    })]]);
  expect((h.localSaved.inputOpenings as any)[firstId]).toMatchObject({
    tab: tab.id,
    stage: 'ready',
    conversationId: null
  });
});

it.each(['draft', 'pinned', 'stale-document'])('does not restore a stripped temporary helper without exact safe custody (%s)', async mode => {
  const input = { id: firstId, conversationId: null, lifetime: 'temporary-planner' } as any;
  const h = await worker([input], undefined, {
    inputOpenings: {
      [firstId]: { tab: 1, stage: 'ready', electedAt: Date.now() - 60_000 }
    }
  });
  const tab = await h.createChatTab(
    `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}#cos-input=${firstId}`,
    false
  );
  tab.url = 'https://chatgpt.com/';
  delete tab.pendingUrl;
  tab.active = false;
  tab.pinned = mode === 'pinned';
  await h.authorizeDocument(
    { tab: { id: tab.id }, documentId: 'temporary-helper-document', frameId: 0, url: tab.url },
    { navigationEpoch: 1 }
  );
  h.fetch.mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () =>
    new URL(url).pathname === '/hello'
      ? { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
      : { ok: true, inputs: [input], inputOpeningIds: [firstId], background: true }
  }));
  h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> =>
    message.type === 'clf-tab-close-check'
      ? { safe: mode !== 'draft', conversationId: null,
        navigationEpoch: mode === 'stale-document' ? 2 : 1 }
      : { ok: true }
  );

  await h.maintain();

  expect(h.update).not.toHaveBeenCalled();
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(h.remove).not.toHaveBeenCalled();
  expect((h.localSaved.inputOpenings as any)[firstId]).toMatchObject({ tab: tab.id, stage: 'ready' });
});

it.each(['catalog', 'plugin'])('does not retire the current %s helper owner before its workflow runs', async kind => {
  const h = await worker([]);
  const marker = firstId;
  const authored = kind === 'catalog'
    ? `https://chatgpt.com/?cos-model-catalog=${marker}`
    : `https://chatgpt.com/?cos-plugin-refresh=${marker}#settings/Plugins`;
  const tab = await h.createChatTab(authored, false);
  tab.url = 'https://chatgpt.com/';
  delete tab.pendingUrl;
  tab.active = false;
  await h.authorizeDocument({ tab: { id: tab.id }, documentId: `${kind}-root`, frameId: 0, url: tab.url }, { navigationEpoch: 1 });
  (h.saved.appOwnedOpeningTabs as Record<string, { createdAt: number; marker: string }>)[String(tab.id)]!.createdAt =
    Date.now() - 5 * 60_000;
  if (kind === 'catalog') h.saved.modelCatalogOwner = { nonce: marker, tab: tab.id };
  else h.saved.pluginRefreshOwner = { id: marker, tab: tab.id };
  h.fetch.mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () => {
    if (new URL(url).pathname === '/hello') {
      return { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true };
    }
    return { ok: true, inputs: [], inputOpeningIds: [],
      ...(kind === 'catalog'
        ? { modelCatalogRequest: { nonce: marker, expiresAt: Date.now() + 60_000 } }
        : { pluginRefreshRequests: [{ surface: 'plugins', schemaId: 'schema', connectorName: 'test' }] }) };
  } }));
  h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> =>
    message.type === 'clf-tab-close-check'
      ? { safe: true, conversationId: null, navigationEpoch: 1 }
      : { ok: true, ready: false }
  );

  await h.maintain();

  expect(h.remove).not.toHaveBeenCalled();
  expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-tab-close-check')).toBe(false);
});

it('withholds queued input from a document being refreshed in the same pass', async () => {
  const h = await worker([{ id: firstId, conversationId: secondId }]);
  h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
  const originalFetch = h.fetch.getMockImplementation()!;
  h.fetch.mockImplementation(async (url, init) => {
    const reply = await originalFetch(url, init);
    if (new URL(url).pathname === '/status') return { ...reply, json: async () => ({ ok: true,
      inputs: [{ id: firstId, conversationId: secondId }], repairs: [{ conversationId: secondId, token: 'due-repair' }] }) };
    return reply;
  });
  await h.maintain();
  expect(h.reload).toHaveBeenCalledExactlyOnceWith(8);
  expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-desktop-input')).toBe(false);
  expect(h.create).not.toHaveBeenCalled();
});

it('carries the direct-turn offer only to the elected existing conversation', async () => {
  const directTurn = { id: 'tool-free-turn', startedAt: 1000 };
  const h = await worker([{ id: firstId, conversationId: secondId, directTurn }]);
  h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
  await h.maintain();
  expect(h.sendMessage).toHaveBeenCalledWith(8, { type: 'clf-desktop-input', id: firstId, conversationId: secondId, directTurn });
  expect(h.create).not.toHaveBeenCalled();
});

type Tab = { id: number; url?: string; pendingUrl?: string; windowId?: number; groupId?: number; active?: boolean; pinned?: boolean; lastAccessed?: number; status?: string };
async function worker(inputs: Array<{ id: string; conversationId: string | null; purpose?: 'rotation'; project?: string; directTurn?: { id: string; startedAt: number }; supersededConversationId?: string }>, modelCatalogRequest?: { nonce: string; expiresAt: number }, priorLocal: Record<string, unknown> = {}) {
  const tabs: Tab[] = [];
  const event = { addListener: () => {} };
  const localSaved: Record<string, unknown> = { port: 8765, token: 'test-pairing', ...priorLocal };
  const local = { get: async () => ({ ...localSaved }), set: vi.fn(async (value: object) => { Object.assign(localSaved, value); }), remove: async () => {} };
  const saved: Record<string, unknown> = {};
  const session = { get: async () => ({ ...saved }), set: async (value: object) => { Object.assign(saved, value); }, remove: async (key: string) => { delete saved[key]; } };
  const create = vi.fn(async ({ url, windowId }: { url: string; windowId?: number; active?: boolean }) => {
    const tab = { id: tabs.length + 1, pendingUrl: url, windowId }; tabs.push(tab); return tab;
  });
  const windows = {
    get: vi.fn(async (id: number) => ({ id })),
    getAll: vi.fn(async () => [] as Array<{ id: number; focused?: boolean; tabs?: Tab[] }>),
    create: vi.fn(async ({ url }: { url: string }) => ({ id: 80, tabs: [await create({ url, windowId: 80 })] })),
    update: vi.fn()
  };
  const remove = vi.fn(async (_id: number) => {});
  const query = vi.fn(async () => [...tabs]);
  const reload = vi.fn(async (_id: number) => {});
  const group = vi.fn(async ({ tabIds }: { tabIds: number[] }) => 100 + (tabIds[0] ?? 0));
  const updateGroup = vi.fn(async (_id: number, _properties: Record<string, unknown>) => undefined);
  const sendMessage = vi.fn(async (_id: number, _message: any): Promise<any> => ({ ok: true, ready: true }));
  const executeScript = vi.fn(async () => []);
  const insertCSS = vi.fn(async () => {});
  const update = vi.fn(async (id: number, patch: Partial<Tab>) => { const tab = tabs.find(tab => tab.id === id)!; Object.assign(tab, patch); delete tab.pendingUrl; return tab; });
  const fetch = vi.fn(async (input: string, _init?: RequestInit): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => ({
    ok: true, status: 200,
    json: async () => new URL(input).pathname === '/hello'
      ? { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
      : { ok: true, inputs, background: true, modelCatalogRequest }
  }));
  const context = vm.createContext({
    createBrowserControl: () => { throw new Error('browser control is outside the maintenance harness'); },
    chrome: {
      storage: { local, session },
      windows,
      runtime: { getManifest: () => ({ version: '2.0.5' }), onMessage: event, onInstalled: event, onStartup: event },
      tabs: { query, get: async (id: number) => tabs.find(tab => tab.id === id), remove, reload, create, update, sendMessage, group, onCreated: event, onUpdated: event, onRemoved: event },
      tabGroups: { query: async () => [], update: updateGroup },
      alarms: { onAlarm: event, create: () => {}, clear: async () => true },
      scripting: { executeScript, insertCSS }
    },
    fetch, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, TextEncoder, console,
    crypto: webcrypto
  });
  vm.runInContext(`${vmSource}\nretireAutomaticTab = async tabId => { await chrome.tabs.remove(tabId); return true; };\nglobalThis.testMaintenance = { load, maintain, releaseTab, serializeTab, noteTabConversation, createChatTab, authorizeDocument, ackDesktopInput, drainCommandAcks, inspectRequestedModels, inspectProjectCreates, desktopInput: HANDLERS.desktop_input, catalog: HANDLERS.model_catalog, events: HANDLERS.events, applyRequestedBrowserPreferences };`, context);
  const api = context.testMaintenance as { releaseTab(...args: any[]): Promise<any>; serializeTab(tab: number, operation: () => Promise<any>): Promise<any>; noteTabConversation(source: any, conversationId: string): Promise<any>; applyRequestedBrowserPreferences(request: object): Promise<void>; authorizeDocument(sender: unknown, message: unknown): Promise<any>; catalog(message: unknown, sender: unknown, source: unknown): Promise<any>; load(): Promise<void>; maintain(): Promise<void>; createChatTab(url: string, background: boolean): Promise<Tab> };
  await api.load();
  // Browser-generation initialization is part of worker boot, not the preference action each
  // focused test measures.
  local.set.mockClear();
  Object.assign(api, { query });
  vm.runInContext('Object.assign(testMaintenance, { offerStopTurns, noteTabConversation, ackCommand })', context);
  return { ...api, update, inspectModels: (context.testMaintenance as any).inspectRequestedModels as (request: unknown, background: boolean) => Promise<void>, inspectProjects: (context.testMaintenance as any).inspectProjectCreates as (requests: unknown[], dispatchAllowed?: boolean) => Promise<void>, ackDesktopInput: (context.testMaintenance as any).ackDesktopInput as (...args: string[]) => Promise<any>, drainCommandAcks: (context.testMaintenance as any).drainCommandAcks as () => Promise<any>, desktopInput: (context.testMaintenance as any).desktopInput as (...args: any[]) => Promise<any>, events: (context.testMaintenance as any).events as (message: any, sender: any, source: any) => Promise<any>, create, sendMessage, executeScript, insertCSS, group, updateGroup, tabs, fetch, windows, remove, reload, local, localSaved, saved };
}

describe('native ChatGPT Project browser ownership', () => {
  const project = `g-p-${'1'.repeat(32)}`;

  it('opens one exact helper only for Main-published requested work', async () => {
    const h = await worker([]);
    await h.inspectProjects([]);
    expect(h.create).not.toHaveBeenCalled();
    await h.inspectProjects([{ id: firstId, projectId: secondId, name: 'Alpha', state: 'requested' }]);
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      url: `https://chatgpt.com/?cos-project-create=${firstId}`
    }));
    expect(h.saved.projectCreateOwner).toMatchObject({ id: firstId });
  });

  it('closes only the exact idle Project helper document and retains a busy owner while dispatch is withheld', async () => {
    const h = await worker([]);
    const url = `https://chatgpt.com/?cos-project-create=${firstId}`;
    h.tabs.push({ id: 7, url, status: 'complete' });
    const source = await h.authorizeDocument({ tab: { id: 7 }, documentId: 'project-helper', frameId: 0, url }, { navigationEpoch: 1 });
    h.saved.projectCreateOwner = { id: firstId, tab: 7, openedAt: Date.now(), documentId: source.documentId, navigationEpoch: 1 };
    h.sendMessage.mockResolvedValue({ ok: true, id: firstId, chatgptId: null,
      navigationEpoch: 1, owned: true, busy: true, safe: false });
    await h.inspectProjects([], false);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.saved.projectCreateOwner).toMatchObject({ id: firstId, documentId: 'project-helper', navigationEpoch: 1 });

    h.sendMessage.mockResolvedValue({ ok: true, id: firstId, chatgptId: null,
      navigationEpoch: 1, owned: true, busy: false, safe: true });
    await h.inspectProjects([], false);
    expect(h.remove).toHaveBeenCalledExactlyOnceWith(7);
    expect(h.saved.projectCreateOwner).toBeUndefined();
  });

  it('never closes an unrelated page after the exact Project helper document navigates', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: 'https://chatgpt.com/', status: 'complete' });
    const source = await h.authorizeDocument({ tab: { id: 7 }, documentId: 'project-helper', frameId: 0,
      url: 'https://chatgpt.com/' }, { navigationEpoch: 1 });
    h.saved.projectCreateOwner = { id: firstId, tab: 7, openedAt: Date.now(), documentId: source.documentId, navigationEpoch: 1 };
    h.sendMessage.mockResolvedValue({ ok: true, id: firstId, chatgptId: null,
      navigationEpoch: 1, owned: true, busy: false, safe: true });
    await h.inspectProjects([], false);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.saved.projectCreateOwner).toMatchObject({ id: firstId });

    h.sendMessage.mockResolvedValue({ ok: true, id: firstId, chatgptId: null,
      navigationEpoch: 1, owned: false, busy: false, safe: false });
    await h.inspectProjects([], false);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.saved.projectCreateOwner).toBeUndefined();
  });

  it.each([
    ['pinned', true],
    ['draft-bearing', false]
  ] as const)('detaches a terminal %s helper without closing it so the next request can start', async (_label, pinned) => {
    const h = await worker([]);
    const url = `https://chatgpt.com/?cos-project-create=${firstId}`;
    h.tabs.push({ id: 7, url, status: 'complete', pinned });
    const source = await h.authorizeDocument({ tab: { id: 7 }, documentId: 'project-helper', frameId: 0, url }, { navigationEpoch: 1 });
    h.saved.projectCreateOwner = { id: firstId, tab: 7, openedAt: Date.now(), documentId: source.documentId, navigationEpoch: 1 };
    h.sendMessage.mockResolvedValue({ ok: true, id: firstId, chatgptId: null,
      navigationEpoch: 1, owned: true, busy: false, safe: false });

    await h.inspectProjects([{ id: secondId, projectId: secondId, name: 'Next Project', state: 'requested' }], true);

    expect(h.remove).not.toHaveBeenCalled();
    expect(h.tabs.some(tab => tab.id === 7)).toBe(true);
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      url: `https://chatgpt.com/?cos-project-create=${secondId}`
    }));
    expect(h.saved.projectCreateOwner).toMatchObject({ id: secondId });
  });

  it('detaches an accepted terminal helper during a policy hold without closing its pinned tab', async () => {
    const h = await worker([]);
    const url = `https://chatgpt.com/g/${project}/project`;
    h.tabs.push({ id: 7, url, status: 'complete', pinned: true });
    const source = await h.authorizeDocument({ tab: { id: 7 }, documentId: 'project-helper', frameId: 0, url }, { navigationEpoch: 1 });
    h.saved.projectCreateOwner = { id: firstId, tab: 7, openedAt: Date.now(), documentId: source.documentId,
      navigationEpoch: 1, chatgptId: project };

    await h.inspectProjects([{ id: secondId, projectId: secondId, name: 'Held Project', state: 'requested' }], false);

    expect(h.remove).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.tabs.some(tab => tab.id === 7)).toBe(true);
    expect(h.saved.projectCreateOwner).toBeUndefined();
  });

  it('skips a lapsed claimed request and opens the next explicitly requested Project helper', async () => {
    const h = await worker([]);
    await h.inspectProjects([
      { id: firstId, projectId: firstId, name: 'Claimed elsewhere', state: 'claimed' },
      { id: secondId, projectId: secondId, name: 'Ready here', state: 'requested' }
    ]);
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      url: `https://chatgpt.com/?cos-project-create=${secondId}`
    }));
    expect(h.saved.projectCreateOwner).toMatchObject({ id: secondId });
  });

  it('never reuses a root tab for linked-Project input and opens the exact provider Project route', async () => {
    const h = await worker([{ id: firstId, conversationId: null, project }]);
    h.tabs.push({ id: 8, url: 'https://chatgpt.com/' });
    await h.maintain();
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      url: `https://chatgpt.com/g/${project}/project?cos-input=${firstId}#cos-input=${firstId}`
    }));
    expect(h.sendMessage.mock.calls.some(([id, message]) => id === 8 && message.type === 'clf-desktop-input')).toBe(false);
  });

  it('discards an old Project election when the same durable input is explicitly retried for a new Project', async () => {
    const oldProject = `g-p-${'2'.repeat(32)}`;
    const h = await worker([{ id: firstId, conversationId: null, project }], undefined, {
      inputOpenings: { [firstId]: { tab: 7, stage: 'ready', project: oldProject } }
    });
    h.tabs.push({ id: 7, url: `https://chatgpt.com/g/${oldProject}/project` });
    await h.maintain();
    expect(h.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      url: `https://chatgpt.com/g/${project}/project?cos-input=${firstId}#cos-input=${firstId}`
    }));
    expect((h.localSaved.inputOpenings as Record<string, any>)[firstId]).toMatchObject({ project, stage: 'ready' });
  });

  it.each([true, false])('reports a gone linked Project only from its elected registered document (registered=%s)', async registered => {
    const h = await worker([{ id: firstId, conversationId: null, project }], undefined, {
      inputOpenings: { [firstId]: { tab: 7, stage: 'ready', project } }
    });
    h.tabs.push({ id: 7, url: 'https://chatgpt.com/', status: 'complete' });
    if (registered) await h.authorizeDocument({ tab: { id: 7 }, documentId: 'project-document', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    await h.maintain();
    const gone = h.fetch.mock.calls
      .filter(([url, init]) => new URL(url).pathname === '/project-create' && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(gone).toEqual(registered
      ? [{ action: 'gone', inputId: firstId, chatgptId: project, client: 'project-document' }]
      : []);
  });
});

describe('one browser maintenance flight per desktop outbox publication', () => {
  it.each(['repaired', 'repaired-last-predecessor', 'repaired-immediate-predecessor', 'repaired-predecessor', 'repaired-old-predecessor', 'repaired-currently-installed-predecessor', 'busy', 'unknown', 'undefined-ping', 'malformed-ping', 'refused-ping',
    'nonresponsive', 'repair-failed', 'changed-after-status', 'missing-prompt', 'missing-approval', 'unknown-features', 'busy-missing-health'] as const)(
    'requires this loaded document to support fresh turns before status custody and offers (%s)', async mode => {
      const input = { id: firstId, conversationId: secondId, purpose: 'rotation' as const,
        directTurn: { id: 'original-tool-turn', startedAt: 1000 } };
      const h = await worker([input]);
      const tab = { id: 8, url: `https://chatgpt.com/c/${secondId}`, status: 'complete' };
      h.tabs.push(tab);
      await h.authorizeDocument({ tab, documentId: 'same-native-document', frameId: 0, url: tab.url }, { navigationEpoch: 1 });
      let capable = false;
      const completes = ['repaired', 'missing-prompt', 'missing-approval', 'unknown-features'].includes(mode);
      const offers: string[] = [], statusCapabilities: unknown[] = [];
      h.executeScript.mockImplementation(async (options?: any) => {
        if (options.files?.includes('content.js') && mode !== 'repair-failed') capable = true;
        return [];
      });
      h.sendMessage.mockImplementation(async (_tab, message): Promise<any> => {
        if (message.type === 'clf-recorder-ping' && mode === 'nonresponsive') return new Promise(() => {});
        if (message.type === 'clf-recorder-ping' && mode === 'undefined-ping') return undefined;
        if (message.type === 'clf-recorder-ping' && mode === 'malformed-ping') return {};
        if (message.type === 'clf-recorder-ping' && mode === 'refused-ping') return { ok: false };
        if (message.type === 'clf-recorder-ping' && !capable && ['missing-prompt', 'missing-approval', 'unknown-features', 'busy-missing-health'].includes(mode))
          return { ok: true, recorderVersion: currentRecorderVersion, freshTurnProtocol: 1,
            requiredFeatures: mode === 'unknown-features' || mode === 'busy-missing-health' ? undefined :
              { promptEnvelope: mode !== 'missing-prompt', nativeAllowOnce: mode !== 'missing-approval' } };
        if (message.type === 'clf-recorder-ping') return capable
          ? { ok: true, recorderVersion: mode === 'repaired-old-predecessor' ? 61 : mode === 'repaired-predecessor' ? 62 : mode === 'repaired-immediate-predecessor' ? 63 : mode === 'repaired-currently-installed-predecessor' ? 65 : mode === 'repaired-last-predecessor' ? currentRecorderVersion - 1 : currentRecorderVersion, freshTurnProtocol: 1, requiredFeatures: { promptEnvelope: true, nativeAllowOnce: true } }
          : { ok: true, recorderVersion: 51 };
        if (message.type === 'clf-page-status') return mode === 'unknown' ? { ok: true } : {
          ok: true, streaming: ['busy', 'busy-missing-health'].includes(mode), generating: ['busy', 'busy-missing-health'].includes(mode), pendingTools: 0,
          jobBusy: false, goalBusy: false, projectCreateBusy: false, pluginRefreshBusy: false,
          modelCatalogBusy: false, desktopInputBusy: false
        };
        if (message.type === 'clf-desktop-input') { offers.push(message.id); expect(capable).toBe(true); }
        return { ok: true };
      });
      h.fetch.mockImplementation(async (url, init) => {
        const route = new URL(url).pathname;
        if (route === '/hello') return { ok: true, status: 200, json: async () => ({
          app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }) };
        if (route === '/status' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)); statusCapabilities.push(body.freshTurnProtocol);
          if (mode === 'changed-after-status') { capable = false; tab.status = 'loading'; }
          // Even an out-of-date server projection cannot authorize the old loaded recorder.
          return { ok: true, status: 200, json: async () => ({ ok: true, inputs: mode === 'nonresponsive' ? [] : [input],
            inputOpeningIds: [firstId], background: true }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      });

      await h.maintain();
      if (completes) await vi.waitFor(() => expect(offers).toHaveLength(1));
      else await new Promise(resolve => setTimeout(resolve, 0));

      expect(statusCapabilities).toEqual([completes || mode === 'changed-after-status' ? 1 : undefined]);
      expect(offers).toEqual(completes ? [firstId] : []);
      expect(h.executeScript.mock.calls.some(([options]: any[]) => options.files?.includes('content.js')))
        .toBe(['repaired', 'repaired-last-predecessor', 'repaired-immediate-predecessor', 'repaired-predecessor', 'repaired-old-predecessor', 'repaired-currently-installed-predecessor', 'repair-failed', 'changed-after-status', 'missing-prompt', 'missing-approval', 'unknown-features'].includes(mode));
      expect(h.reload).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
      expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-stop-turn')).toBe(false);
    }, 10_000);

  it.each(['missing', 'dom-adapter'] as const)('repairs a missing or incompatible content-script receiver in the elected tab and re-offers the same input once (%s)', async reason => {
    const input = { id: firstId, conversationId: null };
    const h = await worker([input], undefined, {
      inputOpenings: { [firstId]: { tab: 7, stage: 'ready' } }
    });
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}#cos-input=${firstId}` });
    let offers = 0;
    h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> => {
      if (message.type === 'clf-desktop-input' && ++offers === 1) {
        if (reason === 'dom-adapter') return { ok: false, error: 'dom_adapter_unready' };
        throw new Error('Receiving end does not exist');
      }
      if (message.type === 'clf-recorder-ping') {
        if (reason === 'dom-adapter') return { ok: true, recorderVersion: currentRecorderVersion, freshTurnProtocol: 0 };
        throw new Error('Receiving end does not exist');
      }
      if (message.type === 'clf-page-status') return { ok: true, streaming: false, generating: false,
        pendingTools: 0, jobBusy: false, goalBusy: false, projectCreateBusy: false,
        pluginRefreshBusy: false, modelCatalogBusy: false, desktopInputBusy: false };
      return { ok: true };
    });

    await h.maintain();
    await vi.waitFor(() => expect(offers).toBe(2));

    expect(h.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, world: 'MAIN', files: ['fiber.js'] });
    const scripts = h.executeScript.mock.calls.map(([options]: any[]) => options);
    // Dependency and recorder must share one ordered injection so navigation cannot
    // replace the document between their otherwise independent awaited calls.
    expect(scripts.filter(options => options.files?.includes('content.js')))
      .toEqual([{ target: { tabId: 7 }, files: ['chatgpt-dom.js', 'content.js'] }]);
    expect(scripts.findIndex(options => options.files?.includes('fiber.js')))
      .toBeLessThan(scripts.findIndex(options => options.files?.includes('content.js')));
    expect(h.insertCSS).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ['overlay.css'] });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('moves a safely pre-Send checkpoint to each existing compacted successor without opening a duplicate', async () => {
    const input = { id: firstId, conversationId: secondId, supersededConversationId: firstId };
    const h = await worker([input], undefined, { inputOpenings: { [firstId]: { tab: 7, stage: 'ready' } } });
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}` }, { id: 8, url: `https://chatgpt.com/c/${secondId}` });
    await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(8, expect.objectContaining({ type: 'clf-desktop-input', id: firstId, conversationId: secondId }));
    expect(h.create).not.toHaveBeenCalled();
    h.tabs.splice(1, 1, { id: 9, url: `https://chatgpt.com/c/${secondId}` });
    h.sendMessage.mockClear();
    await h.maintain();
    expect(h.sendMessage.mock.calls.some(([id, message]) => id === 9 && message.type === 'clf-desktop-input')).toBe(true);
    expect(h.create).not.toHaveBeenCalled();
    const restarted = await worker([input], undefined, h.localSaved);
    restarted.tabs.push({ id: 9, url: `https://chatgpt.com/c/${secondId}` });
    await restarted.maintain();
    expect(restarted.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-desktop-input')).toBe(true);
    expect(restarted.create).not.toHaveBeenCalled();
  });

  it('ignores a prior-browser input tab id that Chrome reused for a different chat after restart', async () => {
    const oldBrowserGeneration = '11111111111111111111111111111111';
    const currentBrowserGeneration = '22222222222222222222222222222222';
    const input = { id: firstId, conversationId: secondId };
    const h = await worker([input], undefined, {
      commandLeaseGeneration: currentBrowserGeneration,
      inputOpenings: {
        [firstId]: {
          tab: 7,
          stage: 'ready',
          conversationId: secondId,
          browserGeneration: oldBrowserGeneration,
          electedAt: Date.now() - 60_000
        }
      }
    });
    // Chrome reused the old numeric tab id for an unrelated restored chat. The exact target is
    // already open under another id, so restart recovery must adopt it rather than preserving
    // stale numeric custody or opening another tab.
    h.tabs.push(
      { id: 7, url: `https://chatgpt.com/c/${firstId}` },
      { id: 8, url: `https://chatgpt.com/c/${secondId}` }
    );

    await h.maintain();

    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input'))
      .toEqual([[8, { type: 'clf-desktop-input', id: firstId, conversationId: secondId }]]);
    expect((h.localSaved.inputOpenings as any)[firstId]).toMatchObject({
      tab: 8,
      stage: 'ready',
      conversationId: secondId,
      browserGeneration: currentBrowserGeneration
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('does not open a missing successor for an already elected checkpoint', async () => {
    const h = await worker([{ id: firstId, conversationId: secondId, supersededConversationId: firstId }], undefined,
      { inputOpenings: { [firstId]: { tab: 7, conversationId: firstId, stage: 'ready' } } });
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}` });
    await h.maintain();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-desktop-input')).toBe(false);
  });

  it.each(['closed', 'navigated'])('reopens one safely pre-Send input after its elected tab is %s, including browser restart', async reason => {
    const input = { id: firstId, conversationId: null };
    const h = await worker([input]);
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    if (reason === 'closed') h.tabs.length = 0;
    else { h.tabs[0]!.url = 'https://chatgpt.com/'; delete h.tabs[0]!.pendingUrl; }
    await h.maintain(); await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(reason === 'closed' ? 2 : 1);
    const restarted = await worker([input], undefined, h.localSaved);
    await restarted.maintain();
    expect(restarted.create).toHaveBeenCalledTimes(1);
  });
  it('spends input opening authority before creation and permits a new explicit operation', async () => {
    const inputs = [{ id: firstId, conversationId: null }];
    const h = await worker(inputs);
    h.create.mockImplementationOnce(async () => { throw new Error('Chrome rejected creation'); });
    await expect(h.maintain()).rejects.toThrow('Chrome rejected creation'); await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    inputs.splice(0, 1, { id: secondId, conversationId: null });
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(2);
  });
  it('does not create behind a failed custody write', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.local.set.mockImplementation(async value => {
      if ('inputOpenings' in value) throw new Error('disk full');
      Object.assign(h.localSaved, value);
    });
    await expect(h.maintain()).rejects.toThrow('disk full'); await h.maintain();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('restores the pre-create checkpoint without reopening after a crash before tab-id persistence', async () => {
    const input = { id: firstId, conversationId: null };
    const h = await worker([input], undefined, { inputOpenings: { [firstId]: { tab: null } } });
    await h.maintain();
    expect(h.create).not.toHaveBeenCalled();
    h.tabs.push({ id: 9, url: `https://chatgpt.com/?cos-input=${firstId}` });
    await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(9, expect.objectContaining({ type: 'clf-desktop-input', id: firstId }));
    expect(h.create).not.toHaveBeenCalled();
  });
  it('does not confuse a temporarily withheld offer with retired opening authority', async () => {
    const input = { id: firstId, conversationId: null };
    const inputs = [input];
    const h = await worker(inputs);
    await h.maintain(); h.tabs.length = 0;
    inputs.length = 0;
    await h.maintain();
    inputs.push(input);
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(2);
  });
  it.each(['unpinned', 'pinned', 'pinned-during-proof'])('respects pinning when retiring a temporary planner (%s)', async mode => {
    const h = await worker([{ id: firstId, conversationId: null, owner: '7:planner:1', lifetime: 'temporary-planner', close: true, retire: true } as any]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}`, pinned: mode === 'pinned' });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'planner', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async () => {
      if (mode === 'pinned-during-proof') h.tabs[0]!.pinned = true;
      return { safe: true, conversationId: null, navigationEpoch: 1 } as never;
    });
    await h.maintain();
    if (mode === 'unpinned') expect(h.remove).toHaveBeenCalledWith(7);
    else expect(h.remove).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('never opens a helper for passive model observation, including repeated maintenance', async () => {
    const h = await worker([]);
    const request = { nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: false };
    await h.inspectModels(request, true); await h.inspectModels(request, true);
    expect(h.create).not.toHaveBeenCalled();
    h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
    await h.inspectModels(request, true);
    expect(h.sendMessage).toHaveBeenCalledWith(8, expect.objectContaining({ type: 'clf-model-catalog' }));
    expect(h.create).not.toHaveBeenCalled();
  });
  it('retains model discovery custody when a user closes its elected tab', async () => {
    const h = await worker([]);
    const request = { nonce: firstId, expiresAt: Date.now() + 60000 };
    await h.inspectModels(request, true);
    expect(h.create).toHaveBeenCalledTimes(1);
    h.tabs.length = 0;
    await h.inspectModels(request, true); await h.inspectModels(request, true);
    expect(h.create).toHaveBeenCalledTimes(1);
    // Only a new explicit request can authorize another tab.
    await h.inspectModels({ ...request, nonce: secondId }, true);
    expect(h.create).toHaveBeenCalledTimes(2);
  });
  it.each(['saved', 'missing', 'new-draft', 'new-route', 'new-document', 'new-pin'])('retires a marker-stripped finished helper only with its saved output (%s)', async output => {
    const terminal = { id: firstId, conversationId: secondId, owner: '7:planner:1', lifetime: 'temporary-planner', close: true };
    const h = await worker([terminal] as any, undefined, { inputOpenings: {
      [firstId]: { tab: 7, stage: 'ready', temporary: true, owner: terminal.owner }
    } });
    const url = `https://chatgpt.com/c/${secondId}`;
    h.tabs.push({ id: 7, url });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'planner', frameId: 0, url }, { navigationEpoch: 1 });
    const original = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (target, init) => {
      if (new URL(target).pathname !== '/input/output') return original(target, init);
      if (output === 'new-route') h.tabs[0]!.url = `https://chatgpt.com/c/${firstId}`;
      if (output === 'new-pin') h.tabs[0]!.pinned = true;
      if (output === 'new-document') await h.authorizeDocument({ tab: { id: 7 }, documentId: 'replacement', frameId: 0, url }, { navigationEpoch: 2 });
      return { ok: true, status: 200, json: async () => ({ ok: output !== 'missing' }) };
    });
    h.sendMessage.mockResolvedValue({ safe: output !== 'new-draft', temporary: true, conversationId: secondId, navigationEpoch: 1 } as never);
    await h.maintain();
    expect(h.remove.mock.calls).toEqual(output === 'saved' ? [[7]] : []);
    if (output === 'saved') expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/input/output')).toBe(true);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('immediately closes an exact temporary helper after its answer is accepted', async () => {
    const h = await worker([]);
    const url = `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}`;
    h.tabs.push({ id: 7, url });
    const sender = { tab: { id: 7 }, documentId: 'planner', frameId: 0, url };
    const owner = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    h.sendMessage.mockResolvedValue({ safe: true, conversationId: null, navigationEpoch: 1 } as never);
    expect((await h.desktopInput({ id: firstId, owner: '7:planner:1', lifetime: 'temporary-planner', response: 'Plan complete' }, sender, owner)).ok).toBe(true);
    expect(h.remove).toHaveBeenCalledWith(7);
  });
  it.each(['draft', 'pinned', 'pinned-during-proof', 'navigation', 'document', 'rejected'])('keeps a temporary helper after answer publication when %s prevents closing', async reason => {
    const h = await worker([]);
    const url = `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}`;
    h.tabs.push({ id: 7, url, pinned: reason === 'pinned' });
    const sender = { tab: { id: 7 }, documentId: 'planner', frameId: 0, url };
    const owner = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    if (reason === 'rejected') h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false }) });
    h.sendMessage.mockImplementation(async () => {
      if (reason === 'pinned-during-proof') h.tabs[0]!.pinned = true;
      if (reason === 'navigation') h.tabs[0]!.url = 'https://chatgpt.com/';
      if (reason === 'document') await h.authorizeDocument({ ...sender, documentId: 'new-document' }, { navigationEpoch: 1 });
      return { safe: reason !== 'draft' } as never;
    });
    await h.desktopInput({ id: firstId, owner: '7:planner:1', lifetime: 'temporary-planner', response: 'Plan complete' }, sender, owner);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('closes a terminal temporary helper without waiting for replacement app work', async () => {
    const h = await worker([{ id: firstId, conversationId: null, owner: '7:planner:1', lifetime: 'temporary-planner', close: true } as any]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}` }, { id: 8, url: `https://chatgpt.com/c/${firstId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'planner', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-close-temporary-planner'
      ? { safe: true, conversationId: null, navigationEpoch: 1 } as never
      : { ok: true });
    await h.maintain();
    expect(h.remove.mock.calls).toEqual([[7]]);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('closes an abandoned elected helper home after five minutes and a fresh empty-page proof', async () => {
    const retiredAt = Date.now() - 6 * 60_000;
    const terminal = { id: firstId, conversationId: null, owner: '7:planner:1', lifetime: 'temporary-planner', close: true } as any;
    const h = await worker([terminal], undefined, { inputOpenings: {
      [firstId]: { tab: 7, stage: 'retired', retiredAt, temporary: true, owner: terminal.owner }
    } });
    h.tabs.push({ id: 7, url: 'https://chatgpt.com/', active: false });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'abandoned-helper', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { safe: true, conversationId: null, navigationEpoch: 1 } as never : { ok: true });
    await h.maintain();
    expect(h.remove).toHaveBeenCalledExactlyOnceWith(7);
    expect((h.localSaved.inputOpenings as any)[firstId]).toBeUndefined();
  });
  it('never closes an active personal ChatGPT home while retiring a helper election', async () => {
    const terminal = { id: firstId, conversationId: null, owner: '7:planner:1', lifetime: 'temporary-planner', close: true } as any;
    const h = await worker([terminal], undefined, { inputOpenings: {
      [firstId]: { tab: 7, stage: 'retired', retiredAt: Date.now() - 6 * 60_000, temporary: true, owner: terminal.owner }
    } });
    h.tabs.push({ id: 7, url: 'https://chatgpt.com/', active: true, windowId: 12 });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'personal-home', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    await h.maintain();
    expect(h.remove).not.toHaveBeenCalled();
  });
  it.each(['draft', 'navigation'])('keeps a retiring helper when %s prevents safe closure', async reason => {
    const work = { id: secondId, conversationId: null };
    const h = await worker([{ id: firstId, conversationId: null, owner: '7:planner:1', lifetime: 'temporary-planner', close: true, replacements: [work] } as any]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}` }, { id: 8, url: `https://chatgpt.com/?cos-input=${secondId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'planner', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type !== 'clf-close-temporary-planner') return { ok: true };
      if (reason === 'navigation') h.tabs[0]!.url = 'https://chatgpt.com/';
      return { safe: reason !== 'draft' } as never;
    });
    await h.maintain(); expect(h.remove).not.toHaveBeenCalled();
  });
  it('keeps background input placement in an existing normal window without changing its geometry', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.windows.getAll.mockResolvedValue([{ id: 80, focused: false, tabs: [] }]);
    h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true, ok: true, inputs: [{ id: firstId, conversationId: null }], background: true, browserWindowBounds: { left: -1510, top: 220, width: 800, height: 600 } }) });
    await h.maintain();
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ windowId: 80, active: false }));
    expect(h.windows.create).not.toHaveBeenCalled();
    expect(h.windows.update).not.toHaveBeenCalled();
  });
  it('reuses an idle conversation without opening or navigating a helper', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
    await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 30000 }, true);
    expect(h.sendMessage).toHaveBeenCalledWith(8, expect.objectContaining({ type: 'clf-model-catalog', nonce: firstId }));
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('keeps catalog discovery inactive without creating or minimizing another window', async () => {
    const h = await worker([]);
    h.windows.getAll.mockResolvedValue([{ id: 80, focused: true, tabs: [] }]);
    await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 30000 }, false);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ windowId: 80, active: false }));
    expect(h.windows.create).not.toHaveBeenCalled();
    expect(h.windows.update).not.toHaveBeenCalled();
  });
  it('places an offered worker inactive in the existing normal window with discard protection', async () => {
    const h = await worker([]);
    h.windows.getAll.mockResolvedValue([{ id: 80, focused: true, tabs: [] }]);
    let offered = true;
    h.fetch.mockImplementation(async (input) => ({ ok: true, status: 200, json: async () => {
      if (new URL(input).pathname === '/hello') return { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true };
      const placement = offered ? { id: firstId, background: true, model: 'gpt-5.6-sol', reasoningEffort: 'medium' } : null;
      offered = false;
      return { ok: true, placement, inputs: [], background: true };
    } }));
    await h.maintain();
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ windowId: 80, active: false }));
    expect(h.windows.create).not.toHaveBeenCalled();
    expect(h.windows.update).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith(1, { autoDiscardable: false });
    expect(String(h.create.mock.calls[0]?.[0]?.url)).toContain('model=gpt-5.6-sol&reasoning_effort=medium');
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it('retains the completed exact dedicated catalog for first-message reuse', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` }, { id: 8, url: `https://chatgpt.com/c/${secondId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'catalog', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe: true, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    h.remove.mockImplementation(async id => { h.tabs.splice(h.tabs.findIndex(tab => tab.id === id), 1); });
    const request = { nonce: secondId, expiresAt: Date.now() + 60000 };
    await h.inspectModels(request, true);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.saved.modelCatalogOwner).toEqual({ nonce: secondId, tab: 7 });
    await h.inspectModels(request, true);
    await h.inspectModels(null, true);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('retains a sole completed catalog after its draft clears', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'catalog', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    let safe = false;
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 60000 }, true);
    expect(h.remove).not.toHaveBeenCalled();
    safe = true;
    await h.inspectModels(null, true);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('preserves a draft on a catalog marker and waits for unreachable old helpers instead of accumulating tabs', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` });
    h.sendMessage.mockRejectedValueOnce(new Error('document loading'));
    await h.inspectModels({ nonce: secondId, expiresAt: Date.now() + 60000 }, true);
    expect(h.create).not.toHaveBeenCalled();
    h.sendMessage.mockResolvedValue({ ok: true, ready: false });
    await h.inspectModels(null, true);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('hands the retained catalog to the first new input and replaces it once if closed before Send', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` });
    h.saved.modelCatalogOwner = { nonce: secondId, tab: 7 };
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'warm', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
      if (message.type === 'clf-prepare-desktop-input') h.tabs[0]!.url = `https://chatgpt.com/?cos-input=${firstId}#cos-input=${firstId}`;
      return { ok: true, ready: true };
    });
    await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-prepare-desktop-input', id: firstId }, { documentId: 'warm' });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
    await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-desktop-input', id: firstId, conversationId: null });
    h.tabs.splice(0);
    await h.maintain();
    await h.inspectModels({ nonce: secondId, expiresAt: Date.now() + 60000 }, true);
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it.each(['https://chatgpt.com/', `https://chatgpt.com/c/${secondId}`])('reuses a safe unmarked idle page %s for a new input', async url => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 7, url, active: true });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url }, { navigationEpoch: 1 });
    h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true, ok: true, inputs: [{ id: firstId, conversationId: null }], reusableConversations: [secondId] }) });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
      if (message.type === 'clf-prepare-desktop-input') h.tabs[0]!.url = `https://chatgpt.com/?cos-input=${firstId}`;
      return { ok: true, ready: true };
    });
    await h.maintain(); await h.maintain();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-desktop-input', id: firstId, conversationId: null });
    expect((h.localSaved.inputOpenings as any)[firstId].tab).toBe(7);
  });
  it.each(['pinned', 'pinned-during-proof'])('preserves a %s conversation instead of recycling it for New Chat', async scenario => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    const tab = { id: 7, url: `https://chatgpt.com/c/${secondId}`, pinned: scenario === 'pinned' };
    h.tabs.push(tab);
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: tab.url }, { navigationEpoch: 1 });
    h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true, ok: true,
      inputs: [{ id: firstId, conversationId: null }], reusableConversations: [secondId] }) });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') { tab.pinned = true; return { ok: true, safe: true, navigationEpoch: 1 } as never; }
      return { ok: true };
    });
    await h.maintain();
    expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-prepare-desktop-input')).toBe(false);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(tab.url).toContain(`/c/${secondId}`);
  });
  it('bounds a hung reuse observation before electing one fresh tab for the same input', async () => {
    vi.useFakeTimers();
    let resolveReuse: ((value: unknown) => void) | undefined;
    try {
      const h = await worker([{ id: firstId, conversationId: null }]);
      h.tabs.push({ id: 7, url: 'https://chatgpt.com/', active: true });
      await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
      h.sendMessage.mockImplementation(async (_id, message) => {
        if (message.type === 'clf-input-reuse-state') return new Promise(resolve => { resolveReuse = resolve; }) as never;
        return { ok: true, ready: true };
      });

      let released = false;
      const firstWake = h.maintain().then(() => { released = true; });
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.resolve();
      expect(released).toBe(true);
      await firstWake;

      const marked = h.tabs.filter(tab => String(tab.pendingUrl || tab.url || '').includes(`cos-input=${firstId}`));
      expect(marked).toHaveLength(1);
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(0);
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(0);

      resolveReuse?.({ ok: true, safe: true, navigationEpoch: 1 });
      await Promise.resolve();
      await h.maintain();
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(0);
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input'))
        .toEqual([[marked[0]!.id, { type: 'clf-desktop-input', id: firstId, conversationId: null }]]);
    } finally {
      resolveReuse?.({ ok: true, safe: true, navigationEpoch: 1 });
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
  it('bounds a hung preparation receipt without granting fallback or send authority', async () => {
    vi.useFakeTimers();
    let resolvePrepare: ((value: unknown) => void) | undefined;
    try {
      const h = await worker([{ id: firstId, conversationId: null }]);
      h.tabs.push({ id: 7, url: 'https://chatgpt.com/', active: true });
      await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
      h.sendMessage.mockImplementation(async (_id, message) => {
        if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
        if (message.type === 'clf-prepare-desktop-input') return new Promise(resolve => { resolvePrepare = resolve; }) as never;
        return { ok: true };
      });

      let released = false;
      const wake = h.maintain().then(() => { released = true; });
      await vi.advanceTimersByTimeAsync(15000);
      await Promise.resolve();
      expect(released).toBe(true);
      await wake;
      expect((h.localSaved.inputOpenings as any)[firstId]).toMatchObject({ tab: 7, stage: 'preparing' });
      expect(h.create).not.toHaveBeenCalled();
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(1);
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(0);

      resolvePrepare?.({ ready: false, fallback: true, preSend: true });
      await Promise.resolve();
      expect((h.localSaved.inputOpenings as any)[firstId]).toMatchObject({ tab: 7, stage: 'preparing' });
      expect(h.create).not.toHaveBeenCalled();
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(0);
    } finally {
      resolvePrepare?.({ ready: false, fallback: true, preSend: true });
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
  it.each(['unsafe', 'missing', 'stale'])('retains preparing custody when later reuse proof is %s', async proof => {
    const h = await worker([{ id: firstId, conversationId: null, reopenUnclaimed: true } as any], undefined,
      { inputOpenings: { [firstId]: { tab: 7, stage: 'preparing' } } });
    h.tabs.push({ id: 7, url: 'https://chatgpt.com/' });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-input-reuse-state'
      ? (proof === 'unsafe' ? { ok: true, safe: false, navigationEpoch: 1 }
        : proof === 'stale' ? { ok: true, safe: true, navigationEpoch: 2 } : undefined) as never
      : { ok: true, ready: true });
    await h.maintain();
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-input-reuse-state')).toHaveLength(1);
    expect((h.localSaved.inputOpenings as any)[firstId]).toMatchObject({ tab: 7, stage: 'preparing' });
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(0);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(0);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('ignores a stale conversation registry entry on the exact elected home document', async () => {
    const h = await worker([{ id: firstId, conversationId: null } as any], undefined,
      { inputOpenings: { [firstId]: { tab: 7, stage: 'preparing' } } });
    h.tabs.push({ id: 7, url: 'https://chatgpt.com/' });
    const source = await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    await h.noteTabConversation(source, secondId);
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
      if (message.type === 'clf-prepare-desktop-input') {
        h.tabs[0]!.url = `https://chatgpt.com/?cos-input=${firstId}`;
        return { ready: true } as never;
      }
      return { ok: true };
    });
    await h.maintain();
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-input-reuse-state')).toHaveLength(1);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(1);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(1);
    expect((h.localSaved.inputOpenings as any)[firstId]).toMatchObject({ tab: 7, stage: 'ready' });
    expect(h.create).not.toHaveBeenCalled();
  });
  it('still protects a concrete non-reusable conversation during preparing recovery', async () => {
    const h = await worker([{ id: firstId, conversationId: null } as any], undefined,
      { inputOpenings: { [firstId]: { tab: 7, stage: 'preparing' } } });
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${secondId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'other-chat', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockResolvedValue({ ok: true, safe: true, navigationEpoch: 1 } as never);
    await h.maintain();
    expect((h.localSaved.inputOpenings as any)[firstId]).toMatchObject({ tab: 7, stage: 'preparing' });
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-input-reuse-state')).toHaveLength(0);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(0);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(0);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('retries the same preparation only after an exact idle proof for its owned document', async () => {
    const h = await worker([{ id: firstId, conversationId: null, reopenUnclaimed: true } as any], undefined,
      { inputOpenings: { [firstId]: { tab: 7, stage: 'preparing' } } });
    h.tabs.push({ id: 7, url: 'https://chatgpt.com/' });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
      if (message.type === 'clf-prepare-desktop-input') {
        h.tabs[0]!.url = `https://chatgpt.com/?cos-input=${firstId}`;
        return { ready: true } as never;
      }
      return { ok: true };
    });
    await h.maintain();
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-input-reuse-state')).toHaveLength(1);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input'))
      .toEqual([[7, { type: 'clf-prepare-desktop-input', id: firstId }, { documentId: 'idle' }]]);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input'))
      .toEqual([[7, { type: 'clf-desktop-input', id: firstId, conversationId: null }]]);
    expect((h.localSaved.inputOpenings as any)[firstId]).toMatchObject({ tab: 7, stage: 'ready' });
    expect(h.create).not.toHaveBeenCalled();
  });
  it('resumes one offer when the exact preparing tab already carries the input marker', async () => {
    const h = await worker([{ id: firstId, conversationId: null, reopenUnclaimed: true } as any], undefined,
      { inputOpenings: { [firstId]: { tab: 7, stage: 'preparing' } } });
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-input=${firstId}#cos-input=${firstId}` });
    await h.maintain();
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-input-reuse-state')).toHaveLength(0);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-desktop-input')).toHaveLength(0);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input'))
      .toEqual([[7, { type: 'clf-desktop-input', id: firstId, conversationId: null }]]);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('continues to an independent repair when the final input offer never resolves', async () => {
    let resolveOffer!: (value: unknown) => void;
    const pendingOffer = new Promise(resolve => { resolveOffer = resolve; });
    let wake: Promise<void> | undefined;
    try {
      const input = { id: firstId, conversationId: secondId };
      const h = await worker([input]);
      h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${secondId}` }, { id: 8, url: `https://chatgpt.com/c/${firstId}` });
      h.fetch.mockImplementation(async request => ({ ok: true, status: 200, json: async () => new URL(request).pathname === '/hello'
        ? { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
        : { ok: true, inputs: [input], inputOpeningIds: [firstId], repairs: [{ conversationId: firstId, token: 'repair-one' }] } }));
      h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-desktop-input'
        ? pendingOffer as never : { ok: true, ready: true });

      wake = h.maintain();
      await vi.waitFor(() => expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-desktop-input')).toBe(true));
      expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input'))
        .toEqual([[7, { type: 'clf-desktop-input', id: firstId, conversationId: secondId }]]);
      expect(h.reload).toHaveBeenCalledExactlyOnceWith(8);
      expect((h.localSaved.inputOpenings as any)[firstId]).toMatchObject({ tab: 7, stage: 'ready', conversationId: secondId });
      expect(h.create).not.toHaveBeenCalled();
      resolveOffer({ ok: true });
      await wake;
    } finally {
      resolveOffer({ ok: true });
      await wake;
    }
  });
  it('repairs a conversation before offering its queued input on a later status pass', async () => {
    const input = { id: firstId, conversationId: secondId };
    const h = await worker([input]);
    let repaired = false;
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${secondId}` });
    h.fetch.mockImplementation(async request => ({ ok: true, status: 200, json: async () => {
      const url = new URL(request);
      if (url.pathname === '/hello') return { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true };
      if (url.searchParams.has('repaired')) { repaired = true; return { ok: true }; }
      return { ok: true, inputs: [input], inputOpeningIds: [firstId],
        repairs: repaired ? [] : [{ conversationId: secondId, token: 'repair-same' }] };
    } }));
    await h.maintain();
    expect(h.reload).toHaveBeenCalledExactlyOnceWith(7);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(0);
    expect((h.localSaved.inputOpenings as any)[firstId]).toBeUndefined();
    expect(h.create).not.toHaveBeenCalled();
    await h.maintain();
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input'))
      .toEqual([[7, { type: 'clf-desktop-input', id: firstId, conversationId: secondId }]]);
    expect((h.localSaved.inputOpenings as any)[firstId]).toMatchObject({ tab: 7, stage: 'ready', conversationId: secondId });
  });
  it('opens one clean chat on the first offer when the existing surface is unavailable', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    const url = 'https://chatgpt.com/#settings';
    h.tabs.push({ id: 7, url });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'unavailable', frameId: 0, url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-input-reuse-state'
      ? { safe: false, navigationEpoch: 1 } as never : { ok: true });
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.tabs[0]!.url).toBe(url);
    expect(h.tabs[1]!.pendingUrl).toBe(`https://chatgpt.com/?cos-input=${firstId}#cos-input=${firstId}`);
    expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-prepare-desktop-input')).toBe(false);
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith(h.tabs[1]!.id, { type: 'clf-desktop-input', id: firstId, conversationId: null });
  });
  it.each(['explicit-failure', 'ambiguous', 'closed'])('uses explicit pre-send fallback and reopens only after its exact elected tab is gone: %s', async reason => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 7, url: 'https://chatgpt.com/' });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
      if (message.type === 'clf-prepare-desktop-input') {
        if (reason === 'ambiguous') throw new Error('lost response');
        if (reason === 'closed') h.tabs.length = 0;
        return { ready: false, fallback: true, preSend: true } as never;
      }
      return { ok: false };
    });
    await h.maintain(); await h.maintain();
    const beforeClose = reason === 'explicit-failure' || reason === 'closed' ? 1 : 0;
    expect(h.create).toHaveBeenCalledTimes(beforeClose);
    h.tabs.length = 0;
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(beforeClose + 1);
  });
  it.each(['empty', 'draft', 'navigated', 'pinned', 'personal', 'epoch-changed'])('retires an abandoned managed New Chat after fallback only with exact empty proof (%s)', async mode => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    const initial = mode === 'personal' ? 'https://chatgpt.com/' : `https://chatgpt.com/c/${secondId}`;
    h.tabs.push({ id: 7, url: initial });
    const sender = { tab: { id: 7 }, documentId: 'reuse-source', frameId: 0, url: initial };
    await h.authorizeDocument(sender, { navigationEpoch: 1 });
    h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true, ok: true,
      inputs: [{ id: firstId, conversationId: null }], reusableConversations: [secondId] }) });
    h.sendMessage.mockImplementation(async (_id, message): Promise<any> => {
      if (message.type === 'clf-input-reuse-state') return { safe: true, navigationEpoch: 1 };
      if (message.type === 'clf-prepare-desktop-input') {
        h.tabs[0] = { id: 7, url: 'https://chatgpt.com/' };
        await h.authorizeDocument({ ...sender, url: h.tabs[0].url }, { navigationEpoch: 2 });
        return { ready: false, fallback: true, preSend: true };
      }
      if (message.type === 'clf-tab-close-check') {
        expect(h.create).toHaveBeenCalledTimes(1);
        if (mode === 'navigated') h.tabs[0]!.url = `https://chatgpt.com/c/${firstId}`;
        if (mode === 'pinned') h.tabs[0]!.pinned = true;
        if (mode === 'epoch-changed') await h.authorizeDocument({ ...sender, url: h.tabs[0]!.url }, { navigationEpoch: 3 });
        return { safe: mode !== 'draft', conversationId: null, navigationEpoch: 2 };
      }
      return { ok: true };
    });
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.remove).toHaveBeenCalledTimes(mode === 'empty' ? 1 : 0);
    if (mode === 'empty') expect(h.remove).toHaveBeenCalledWith(7);
  });
  it('delivers follow-up messages into an already open waiting conversation without closing or creating tabs', async () => {
    const h = await worker([{ id: firstId, conversationId: secondId }]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${secondId}` });
    await h.maintain(); await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-desktop-input', id: firstId, conversationId: secondId });
    expect(h.create).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });
  it('does not overwrite a draft to reuse a catalog document', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'draft', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe: false, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    await h.maintain();
    expect(h.update.mock.calls.some(([id, patch]) => id === 7 && 'url' in patch)).toBe(false);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('adopts the oldest ready catalog and retires only its exact empty duplicate after restart', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 8, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` }, { id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` },
      { id: 9, url: `https://chatgpt.com/c/${firstId}` }, { id: 10, url: 'https://chatgpt.com/?cos-model-catalog=personal' });
    await h.authorizeDocument({ tab: { id: 8 }, documentId: 'duplicate', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe: true, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    h.remove.mockImplementation(async id => { h.tabs.splice(h.tabs.findIndex(tab => tab.id === id), 1); });
    await h.inspectModels({ nonce: secondId, expiresAt: Date.now() + 60000 }, true);
    expect(h.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'clf-model-catalog' }));
    expect(h.sendMessage).toHaveBeenCalledWith(8, { type: 'clf-tab-close-check', conversationId: null }, { documentId: 'duplicate' });
    expect(h.remove.mock.calls).toEqual([[8]]);
    await h.inspectModels(null, true);
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
  it.each(['draft', 'navigation', 'document', 'unregistered', 'pinned', 'pinned-during-proof'])('preserves a catalog duplicate with %s uncertainty', async reason => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` }, { id: 8, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` });
    h.tabs[1]!.pinned = reason === 'pinned';
    const sender = { tab: { id: 8 }, documentId: 'duplicate', frameId: 0, url: h.tabs[1]!.url };
    if (reason !== 'unregistered') await h.authorizeDocument(sender, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type !== 'clf-tab-close-check') return { ok: true, ready: true };
      if (reason === 'navigation') h.tabs[1] = { id: 8, url: `https://chatgpt.com/c/${secondId}` };
      if (reason === 'pinned-during-proof') h.tabs[1]!.pinned = true;
      if (reason === 'document') await h.authorizeDocument({ ...sender, documentId: 'replacement' }, { navigationEpoch: 1 });
      return { ok: true, safe: reason !== 'draft', conversationId: null, navigationEpoch: 1 } as never;
    });
    await h.inspectModels(null, true);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('retires a newly hydrated duplicate on existing maintenance after catalog completion', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` }, { id: 8, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` });
    await h.inspectModels({ nonce: secondId, expiresAt: Date.now() + 60000 }, true);
    expect(h.remove).not.toHaveBeenCalled();
    await h.authorizeDocument({ tab: { id: 8 }, documentId: 'hydrated', frameId: 0, url: h.tabs[1]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockClear();
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe: true, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    await h.inspectModels(null, true);
    expect(h.remove.mock.calls).toEqual([[8]]);
    expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-model-catalog')).toBe(false);
  });
  it('durably replays an exact input ACK after HTTP loss and worker restart without sending text', async () => {
    const h = await worker([]);
    h.fetch.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) } as never));
    const receipt = { id: firstId, owner: '7:original-document:0', conversationId: 'conversation-a', messageId: 'native-user-a' };
    expect(await h.ackDesktopInput(receipt.id, receipt.owner, receipt.conversationId, receipt.messageId)).toMatchObject({ ok: true, queued: true });
    expect(h.localSaved.commandAckOutbox).toEqual([expect.objectContaining({ kind: 'input', ...receipt })]);
    const restarted = await worker([], undefined, JSON.parse(JSON.stringify(h.localSaved)));
    await restarted.drainCommandAcks();
    const requests = restarted.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/input/ack');
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]?.[1]?.body))).toEqual(receipt);
    expect(restarted.localSaved.commandAckOutbox).toEqual([]);
    expect(restarted.create).not.toHaveBeenCalled();
    expect(restarted.sendMessage).not.toHaveBeenCalled();
  });
  it('does not acknowledge an old identical row when a replacement batch omits the non-null pre-Send anchor', async () => {
    const h = await worker([]);
    const conversationId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaab';
    const text = 'Continue the exact existing task.';
    const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256',
      new TextEncoder().encode(text.replace(/\s+/g, '')))).toString('hex');
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${conversationId}` });
    const firstSender = { tab: { id: 7 }, documentId: 'original-anchor-document', frameId: 0, url: h.tabs[0]!.url };
    const firstSource = await h.authorizeDocument(firstSender, { navigationEpoch: 1 });
    const owner = '7:original-anchor-document:1';
    const originalFetch = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (url, init) => {
      if (new URL(url).pathname === '/input/claim') return { ok: true, status: 200, json: async () => ({ ok: true }) } as never;
      return originalFetch(url, init);
    });
    expect(await h.desktopInput({ id: firstId, owner, conversationId, authorize: true,
      receipt: { digest, previousMessageId: 'original-last-user' } }, firstSender, firstSource)).toMatchObject({ ok: true });
    const replacementSender = { tab: { id: 7 }, documentId: 'replacement-anchor-document', frameId: 0, url: h.tabs[0]!.url };
    const replacementSource = await h.authorizeDocument(replacementSender, { navigationEpoch: 1 });
    const oldIdentical = { event: { kind: 'user_message', text, messageId: 'older-identical-user' } };
    const acknowledgements = () => h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/input/ack');
    expect((await h.events({ conversationId, entries: [oldIdentical] }, replacementSender, replacementSource)).ok).toBe(true);
    expect(acknowledgements()).toHaveLength(0);
    expect(h.saved.pendingInputReceipts).toEqual(expect.objectContaining({
      [firstId]: expect.objectContaining({ owner, previousMessageId: 'original-last-user' })
    }));
    // Hydrating only history before the original anchor is not new delivery either.
    const anchor = { event: { kind: 'user_message', text: 'The last pre-Send question.', messageId: 'original-last-user' } };
    expect((await h.events({ conversationId, entries: [oldIdentical, anchor] }, replacementSender, replacementSource)).ok).toBe(true);
    expect(acknowledgements()).toHaveLength(0);
    // The same retained receipt may settle only when an exact matching row is positively AFTER
    // its original anchor. Nothing here grants another claim or clicks Send again.
    expect((await h.events({ conversationId, entries: [oldIdentical, anchor,
      { event: { kind: 'user_message', text, messageId: 'actual-new-native-user' } }
    ] }, replacementSender, replacementSource)).ok).toBe(true);
    expect(acknowledgements()).toHaveLength(1);
    expect(JSON.parse(String(acknowledgements()[0]?.[1]?.body))).toEqual({
      id: firstId, owner, conversationId, messageId: 'actual-new-native-user'
    });
    expect(h.saved.pendingInputReceipts).toEqual({});
    expect(h.create).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
  it('recovers an authorized Send from the replacement document without replaying its text', async () => {
    const h = await worker([]);
    const conversationId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
    const text = 'Build the exact requested workflow.';
    const normalized = text.replace(/\s+/g, '');
    const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))).toString('hex');
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-input=${firstId}` });
    const firstSender = { tab: { id: 7 }, documentId: 'sending-document', frameId: 0, url: h.tabs[0]!.url };
    const firstSource = await h.authorizeDocument(firstSender, { navigationEpoch: 1 });
    const owner = '7:sending-document:1';
    const originalFetch = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (url, init) => {
      if (new URL(url).pathname === '/input/claim') return { ok: true, status: 200, json: async () => ({ ok: true }) } as never;
      return originalFetch(url, init);
    });

    expect(await h.desktopInput({ id: firstId, owner, conversationId: null, authorize: true,
      receipt: { digest, previousMessageId: null } }, firstSender, firstSource)).toMatchObject({ ok: true });
    expect(h.saved.pendingInputReceipts).toEqual(expect.objectContaining({
      [firstId]: expect.objectContaining({ tab: 7, owner, digest, previousMessageId: null })
    }));

    h.tabs[0]!.url = `https://chatgpt.com/c/${conversationId}`;
    const replacementSender = { tab: { id: 7 }, documentId: 'replacement-document', frameId: 0, url: h.tabs[0]!.url };
    const replacementSource = await h.authorizeDocument(replacementSender, { navigationEpoch: 1 });
    expect((await h.events({ conversationId, entries: [
      { event: { kind: 'user_message', text, messageId: 'older-identical-user-row' } },
      { event: { kind: 'user_message', text, messageId: 'native-user-row' } }
    ] }, replacementSender, replacementSource)).ok).toBe(true);

    const acknowledgements = h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/input/ack');
    expect(acknowledgements).toHaveLength(1);
    expect(JSON.parse(String(acknowledgements[0]?.[1]?.body))).toEqual({
      id: firstId, owner, conversationId, messageId: 'native-user-row'
    });
    expect(h.saved.pendingInputReceipts).toEqual({});
    expect(JSON.stringify(h.saved)).not.toContain(text);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
  it('does not accept a replacement-document route as proof that a fresh-chat Send occurred', async () => {
    const h = await worker([]);
    const conversationId = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
    const text = 'Keep completing the exact production task.';
    const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256',
      new TextEncoder().encode(text.replace(/\s+/g, '')))).toString('hex');
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-input=${firstId}` });
    const firstSender = { tab: { id: 7 }, documentId: 'sending-document', frameId: 0, url: h.tabs[0]!.url };
    const firstSource = await h.authorizeDocument(firstSender, { navigationEpoch: 1 });
    const owner = '7:sending-document:1';
    const originalFetch = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (url, init) => {
      if (new URL(url).pathname === '/input/claim') return { ok: true, status: 200, json: async () => ({ ok: true }) } as never;
      return originalFetch(url, init);
    });
    expect(await h.desktopInput({ id: firstId, owner, conversationId: null, authorize: true,
      receipt: { digest, previousMessageId: null } }, firstSender, firstSource)).toMatchObject({ ok: true });

    h.tabs[0]!.url = `https://chatgpt.com/c/${conversationId}`;
    const replacementSender = { tab: { id: 7 }, documentId: 'replacement-document', frameId: 0, url: h.tabs[0]!.url };
    const replacementSource = await h.authorizeDocument(replacementSender, { navigationEpoch: 1 });
    expect((await h.events({ conversationId, entries: [] }, replacementSender, replacementSource)).ok).toBe(true);
    let acknowledgements = h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/input/ack');
    expect(acknowledgements).toHaveLength(0);
    expect(h.saved.pendingInputReceipts).toEqual(expect.objectContaining({
      [firstId]: expect.objectContaining({ tab: 7, owner, digest, previousMessageId: null })
    }));

    expect((await h.events({ conversationId, entries: [
      { event: { kind: 'user_message', text, messageId: 'native-user-row' } }
    ] }, replacementSender, replacementSource)).ok).toBe(true);
    acknowledgements = h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/input/ack');
    expect(acknowledgements).toHaveLength(1);
    expect(JSON.parse(String(acknowledgements[0]?.[1]?.body))).toEqual({
      id: firstId, owner, conversationId, messageId: 'native-user-row'
    });
    expect(h.saved.pendingInputReceipts).toEqual({});
    expect(JSON.stringify(h.saved)).not.toContain(text);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
  it('durably replays positive pre-Send proof after app-response loss without replaying message text', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-input=${firstId}` });
    const sender = { tab: { id: 7 }, documentId: 'pre-send-document', frameId: 0, url: h.tabs[0]!.url };
    const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    h.fetch.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) } as never));
    const message = {
      id: firstId,
      owner: '7:pre-send-document:0',
      conversationId: null,
      fail: true,
      confirmedUnsent: true,
      error: 'Native Send was not attempted.'
    };

    expect(await h.desktopInput(message, sender, source)).toMatchObject({ ok: true, queued: true });
    expect(h.localSaved.commandAckOutbox).toEqual([
      expect.objectContaining({ kind: 'input-unsent', id: firstId, owner: message.owner, conversationId: null })
    ]);

    const restarted = await worker([], undefined, JSON.parse(JSON.stringify(h.localSaved)));
    await restarted.drainCommandAcks();
    const releases = restarted.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/input/fail');
    expect(releases).toHaveLength(1);
    expect(JSON.parse(String(releases[0]?.[1]?.body))).toMatchObject({
      id: firstId,
      owner: message.owner,
      confirmedUnsent: true
    });
    expect(restarted.localSaved.commandAckOutbox).toEqual([]);
    expect(restarted.create).not.toHaveBeenCalled();
    expect(restarted.sendMessage).not.toHaveBeenCalled();
  });
  it('does not re-offer a rearmed UUID while its older pre-Send release receipt is still pending', async () => {
    const input = { id: firstId, conversationId: null };
    const h = await worker([input]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-input=${firstId}` });
    const sender = { tab: { id: 7 }, documentId: 'pre-send-document', frameId: 0, url: h.tabs[0]!.url };
    const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    let releaseAccepted = false;
    h.fetch.mockImplementation(async raw => {
      const path = new URL(String(raw)).pathname;
      if (path === '/hello') return { ok: true, status: 200, json: async () => ({ app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }) } as never;
      if (path === '/input/fail') return releaseAccepted
        ? { ok: true, status: 200, json: async () => ({ ok: false }) } as never
        : { ok: false, status: 503, json: async () => ({}) } as never;
      if (path === '/status') return { ok: true, status: 200, json: async () => ({
        ok: true,
        inputs: [input],
        inputOpeningIds: [firstId],
        background: false
      }) } as never;
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as never;
    });

    expect(await h.desktopInput({
      id: firstId,
      owner: '7:pre-send-document:0',
      conversationId: null,
      fail: true,
      confirmedUnsent: true,
      error: 'Native Send was not attempted.'
    }, sender, source)).toMatchObject({ ok: true, queued: true });
    expect(h.localSaved.commandAckOutbox).toEqual([
      expect.objectContaining({ kind: 'input-unsent', id: firstId, owner: '7:pre-send-document:0' })
    ]);

    h.sendMessage.mockClear();
    await h.maintain();
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input')).toHaveLength(0);

    releaseAccepted = true;
    await h.drainCommandAcks();
    expect(h.localSaved.commandAckOutbox).toEqual([]);

    h.sendMessage.mockClear();
    await h.maintain();
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-desktop-input'))
      .toEqual([[7, { type: 'clf-desktop-input', id: firstId, conversationId: null }]]);
  });
  it('rejects a different receipt for the same input and never acknowledges failed durable custody', async () => {
    const h = await worker([]);
    h.fetch.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) } as never));
    await h.ackDesktopInput(firstId, 'owner', 'conversation-a', 'native-a');
    expect(await h.ackDesktopInput(firstId, 'owner', 'conversation-b', 'native-b')).toMatchObject({ ok: false, error: 'conflicting_send_receipt' });
    h.local.set.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(h.ackDesktopInput(secondId, 'owner', 'conversation-b', 'native-b')).rejects.toThrow('storage unavailable');
  });
  it('journals only a receipt belonging to the current exact document and conversation', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}` });
    const sender = { tab: { id: 7 }, documentId: 'document-a', frameId: 0, url: h.tabs[0]!.url };
    const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    const receipt = { id: firstId, owner: '7:document-a:0', conversationId: firstId, messageId: 'native-a', ack: true };
    h.tabs[0]!.url = `https://chatgpt.com/c/${secondId}`;
    expect(await h.desktopInput(receipt, sender, source)).toMatchObject({ ok: false, error: 'stale_send_receipt' });
    expect(h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/input/ack')).toHaveLength(0);
    h.tabs[0]!.url = sender.url;
    expect(await h.desktopInput(receipt, sender, source)).toMatchObject({ ok: true });
    expect(h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/input/ack')).toHaveLength(1);
  });
  it('binds an exact input project before publishing tool evidence and retains the batch on rejection', async () => {
    const h = await worker([]);
    const conversationId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${conversationId}` });
    const sender = { tab: { id: 7 }, documentId: 'project-document', frameId: 0, url: h.tabs[0]!.url };
    const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    const message = { conversationId, projectInput: { id: firstId, owner: '7:project-document:1' }, entries: [{ conversationId, event: { kind: 'tool_evidence', time: Date.now(), calls: [{ requestId: 'exact-request', tool: 'read' }] } }] };
    const original = h.fetch.getMockImplementation()!;
    let accepted = false;
    h.fetch.mockImplementation(async (url, init) => new URL(url).pathname === '/input/bind'
      ? { ok: true, status: 200, json: async () => ({ ok: accepted }) } : original(url, init));
    expect((await h.events(message, sender, source)).ok).toBe(false);
    expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/events')).toBe(false);
    accepted = true;
    expect((await h.events(message, sender, source)).projectBound).toBe(firstId);
    const routes = h.fetch.mock.calls.map(([url]) => new URL(url).pathname);
    expect(routes.indexOf('/events')).toBeGreaterThan(routes.lastIndexOf('/input/bind'));
    h.fetch.mockClear();
    expect((await h.events({ ...message, projectInput: { id: firstId, owner: '7:another-document:1' } }, sender, source)).ok).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('acknowledges preferences without replaying a change over a newer popup value', async () => {
    const h = await worker([]);
    const request = { nonce: firstId, expiresAt: Date.now() + 60000, patch: { overwrite: false, durations: false } };
    await h.applyRequestedBrowserPreferences(request);
    expect(h.localSaved).toMatchObject({ renderStreamEnabled: false, showStreamTimes: true });
    h.localSaved.renderStreamEnabled = true;
    await h.applyRequestedBrowserPreferences(request);
    expect(h.local.set).toHaveBeenCalledTimes(1);
    expect(h.localSaved.renderStreamEnabled).toBe(true);
    const receipts = h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/browser/preferences').map(([, init]) => JSON.parse(String(init?.body)));
    expect(receipts).toEqual([expect.objectContaining({ nonce: firstId, values: { overwrite: false, durations: true } }), expect.objectContaining({ nonce: firstId, values: { overwrite: false, durations: true } })]);
    await h.applyRequestedBrowserPreferences({ nonce: secondId, expiresAt: Date.now() + 60000, patch: {} });
    expect(JSON.parse(String(h.fetch.mock.calls.at(-1)?.[1]?.body)).values).toEqual({ overwrite: true, durations: true });
  });
  it('does not replay a preference write interrupted after its durable reservation', async () => {
    const h = await worker([]);
    h.saved.browserPreferenceReceipt = { nonce: firstId, values: null, error: 'Write was interrupted' };
    await h.applyRequestedBrowserPreferences({ nonce: firstId, expiresAt: Date.now() + 60000, patch: { durations: true } });
    expect(h.local.set).not.toHaveBeenCalled();
    expect(JSON.parse(String(h.fetch.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ values: null, error: 'Write was interrupted' });
  });
  it('accepts only a requested document observation and keeps the helper open', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` });
    const sender = { tab: { id: 7 }, documentId: 'catalog-document', frameId: 0, url: h.tabs[0]!.url };
    const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    expect(source.ok).toBe(true);
    const message = { nonce: firstId, models: null, close: true };
    expect((await h.catalog(message, sender, source)).ok).toBe(false);
    h.sendMessage.mockImplementation(async (_id: number, request: any) => {
      if (request.type === 'clf-model-catalog-state') return { ok: true, ready: true };
      expect((await h.catalog(message, sender, source)).ok).toBe(true);
      return { ok: true };
    });
    await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 60000 }, true);
    expect(h.remove).not.toHaveBeenCalled();
    h.remove.mockClear();
    h.tabs[0]!.url = 'https://chatgpt.com/c/some-user-chat';
    expect((await h.catalog(message, sender, source)).ok).toBe(false);
    expect(h.remove).not.toHaveBeenCalled();
    h.tabs[0]!.url = `https://chatgpt.com/?cos-model-catalog=${firstId}`;
    await h.authorizeDocument({ ...sender, documentId: 'replacement-document' }, { navigationEpoch: 1 });
    expect((await h.catalog(message, sender, source)).ok).toBe(false);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('reserves initial catalog opening before Chrome acts and never retries an ambiguous failure', async () => {
    const h = await worker([]);
    h.windows.getAll.mockResolvedValue([{ id: 7, focused: true, tabs: [] }]);
    const request = { nonce: firstId, expiresAt: Date.now() + 120000, allowOpen: true };
    h.create.mockImplementation(async () => {
      expect(h.saved.modelCatalogOwner).toEqual({ nonce: firstId, opening: true });
      throw new Error('Chrome may already have created the tab');
    });
    await h.inspectModels(request, true);
    await h.inspectModels(request, true);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.windows.create).not.toHaveBeenCalled();
    expect(h.saved.modelCatalogOwner).toEqual({ nonce: firstId, opening: true });
  });
  it('opens one owned blank catalog tab without blocking maintenance on DOM inspection', async () => {
    const request = { nonce: firstId, expiresAt: Date.now() + 120000 };
    const h = await worker([], request);
    await h.maintain();
    await vi.waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    expect(h.tabs[0]!.pendingUrl).toBe(`https://chatgpt.com/?cos-model-catalog=${firstId}`);
    let finish!: () => void;
    h.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.type === 'clf-model-catalog-state') {
        return new Promise(resolve => { finish = () => resolve({ ok: true, ready: true }); });
      }
      return { ok: true };
    });
    await h.maintain();
    await vi.waitFor(() => expect(h.sendMessage.mock.calls.some(([, message]) =>
      message.type === 'clf-model-catalog-state')).toBe(true));
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-model-catalog-state')).toHaveLength(1);
    finish();
  });
  it('reuses an existing normal window and never creates or minimizes a dedicated app window', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 90, windowId: 3, url: 'https://chatgpt.com/c/user-chat' });
    h.windows.getAll.mockImplementation(async () => [{ id: 3, focused: true, tabs: h.tabs.filter(tab => tab.windowId === 3) }]);
    await Promise.all([h.createChatTab('https://chatgpt.com/?first', true), h.createChatTab('https://chatgpt.com/?second', true)]);
    expect(h.windows.create).not.toHaveBeenCalled();
    expect(h.windows.update).not.toHaveBeenCalled();
    expect(h.create.mock.calls.every(([args]) => args.windowId === 3 && args.active === false)).toBe(true);
    h.create.mockRejectedValueOnce(new Error('tab failed'));
    await expect(h.createChatTab('https://chatgpt.com/?third', true)).rejects.toThrow('tab failed');
    expect(h.windows.create).not.toHaveBeenCalled();
    h.windows.getAll.mockResolvedValue([{ id: 4, focused: false, tabs: [] }]);
    await h.createChatTab('https://chatgpt.com/?fourth', true);
    expect(h.create.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ windowId: 4, active: false }));
    expect(h.windows.create).not.toHaveBeenCalled();
    expect(h.windows.update).not.toHaveBeenCalled();
  });
  it('coalesces simultaneous passes and admits only one new input tab per completed pass', async () => {
    const h = await worker([{ id: firstId, conversationId: null }, { id: secondId, conversationId: null }]);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const normalCreate = h.create.getMockImplementation()!;
    h.create.mockImplementationOnce(async (args) => { entered(); await held; return normalCreate(args); });
    const one = h.maintain();
    await reached;
    const two = h.maintain();
    expect(two).toBe(one);
    expect(h.create).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([one, two]);
    expect(h.create).toHaveBeenCalledTimes(1);
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.tabs.map(tab => new URL(tab.pendingUrl!).searchParams.get('cos-input'))).toEqual([firstId, secondId]);
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(2);
    // Re-offering the durable id to its elected tab is harmless; no third tab may be created.
    expect(h.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('releases a failed flight without granting another opening after ambiguous Chrome failure', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 50, url: `https://chatgpt.com/?other=cos-input=${firstId}` });
    h.create.mockRejectedValueOnce(new Error('Chrome temporarily refused tab creation'));
    await expect(h.maintain()).rejects.toThrow('temporarily refused');
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.tabs).toHaveLength(1);
  });
});

describe('Stop owns one exact existing or newly opened browser document', () => {
  const command = () => ({ id: '1122334455667700', conversationId: firstId, turnId: 'exact-turn', expiresAt: Date.now() + 120000 });
  it('opens once and delivers after the elected new page registers', async () => {
    const h = await worker([]) as any;
    h.windows.getAll.mockResolvedValue([{ id: 7, focused: true, tabs: [] }]);
    const request = command();
    await Promise.all([h.offerStopTurns([request]), h.offerStopTurns([request])]);
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ url: `https://chatgpt.com/c/${firstId}`, windowId: 7, active: true });
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.localSaved.stopOpenings[request.id]).toMatchObject({ tab: 1, turnId: 'exact-turn', conversationId: firstId });
    h.tabs[0].url = h.tabs[0].pendingUrl; delete h.tabs[0].pendingUrl;
    const source = await h.authorizeDocument({ tab: { id: 1 }, documentId: 'opened-stop', frameId: 0, url: h.tabs[0].url }, { navigationEpoch: 1 });
    await h.noteTabConversation(source, firstId);
    await h.offerStopTurns([request]);
    expect(h.sendMessage).toHaveBeenCalledWith(1, { type: 'clf-stop-turn', id: request.id, conversationId: firstId, turnId: request.turnId }, { documentId: 'opened-stop' });
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it.each(['loading', 'unregistered'])('elects an existing %s exact tab instead of opening another', async mode => {
    const h = await worker([]) as any;
    h.tabs.push({ id: 7, [mode === 'loading' ? 'pendingUrl' : 'url']: `https://chatgpt.com/c/${firstId}` });
    const request = command();
    await h.offerStopTurns([request]); await h.offerStopTurns([request]);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.localSaved.stopOpenings[request.id].tab).toBe(7);
  });
  it.each(['closed', 'navigated', 'lost-create-reply'])('retains spent opening custody across suspension after %s', async mode => {
    const h = await worker([]) as any;
    const request = command();
    if (mode === 'lost-create-reply') h.create.mockRejectedValueOnce(new Error('ambiguous creation'));
    await h.offerStopTurns([request]);
    expect(h.create).toHaveBeenCalledTimes(1);
    const restarted = await worker([], undefined, JSON.parse(JSON.stringify(h.localSaved))) as any;
    if (mode === 'navigated') restarted.tabs.push({ id: 1, url: `https://chatgpt.com/c/${secondId}` });
    await restarted.offerStopTurns([request]);
    expect(restarted.create).not.toHaveBeenCalled();
    expect(restarted.sendMessage).not.toHaveBeenCalled();
  });
  it('does not treat query failure or an expired command as permission to open', async () => {
    const h = await worker([]) as any;
    h.query.mockRejectedValueOnce(new Error('Chrome unavailable'));
    await h.offerStopTurns([command()]);
    expect(h.create).not.toHaveBeenCalled();
    await h.offerStopTurns([{ ...command(), expiresAt: Date.now() - 1 }]);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('requires durable opening custody before creating a tab', async () => {
    const h = await worker([]) as any;
    h.local.set.mockRejectedValueOnce(new Error('disk failure'));
    await h.offerStopTurns([command()]);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('targets only the registered conversation document, never opens a tab, and ignores navigation', async () => {
    const h = await worker([]) as any;
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}` });
    h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
    const source = await h.authorizeDocument({ tab: { id: 7 }, documentId: 'stop-document', frameId: 0, url: h.tabs[0].url }, { navigationEpoch: 1 });
    await h.noteTabConversation(source, firstId);
    const command = { id: '1122334455667788', conversationId: firstId, turnId: 'exact-turn' };
    h.offerStopTurns([command]);
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-stop-turn', ...command }, { documentId: 'stop-document' }));
    expect(h.create).not.toHaveBeenCalled();
    h.sendMessage.mockClear(); h.tabs[0].url = `https://chatgpt.com/c/${secondId}`;
    h.offerStopTurns([{ ...command, id: '1122334455667799' }]);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('retains exact turn identity in the existing ACK journal across restart', async () => {
    const h = await worker([]) as any;
    h.fetch.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await h.ackCommand('1122334455667788', 'sent', null, firstId, null, 'stop-document', null, 'exact-turn');
    expect(h.localSaved.commandAckOutbox[0]).toMatchObject({ turnId: 'exact-turn', conversationId: firstId });
    const restarted = await worker([], undefined, JSON.parse(JSON.stringify(h.localSaved)));
    await restarted.drainCommandAcks();
    const ack = restarted.fetch.mock.calls.find(([url]) => new URL(url).pathname === '/commands/ack');
    expect(JSON.parse(String(ack?.[1]?.body))).toMatchObject({ turnId: 'exact-turn', conversationId: firstId, client: 'stop-document' });
    expect(restarted.sendMessage).not.toHaveBeenCalled();
  });
});

it('releases departed-chat ownership so input claims and model discovery cannot deadlock each other', async () => {
  const inputs: Array<{ id: string; conversationId: string | null }> = [];
  const h = await worker(inputs, { nonce: firstId, expiresAt: Date.now() + 60000 });
  const tab = { id: 7, url: `https://chatgpt.com/c/${secondId}` }; h.tabs.push(tab);
  const sender = { tab: { id: 7 }, documentId: 'reused-document', frameId: 0 };
  const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
  await h.noteTabConversation(source, secondId);
  // Chrome reports A's departure as New Chat prepares B in the elected tab.
  tab.url = `https://chatgpt.com/?cos-input=${firstId}#cos-input=${firstId}`;
  inputs.push({ id: firstId, conversationId: null });
  let claimed = false, catalogObserved = false;
  h.sendMessage.mockImplementation(async (id, message) => {
    if (message.type === 'clf-model-catalog-state') return { ok: true, ready: true };
    if (message.type === 'clf-model-catalog') {
      await h.serializeTab(id, async () => {
        const current = await h.authorizeDocument(sender, { navigationEpoch: 1 });
        const result = await h.catalog({ nonce: firstId, models: [{ id: 'observed-model', label: 'Observed model', efforts: ['high'] }] }, sender, current);
        catalogObserved = result.ok;
      });
    }
    if (message.type === 'clf-desktop-input') {
      // Real desktop_input IPC uses the same serializeTab queue as releaseTab.
      await h.serializeTab(id, async () => {
        const current = await h.authorizeDocument(sender, { navigationEpoch: 1 });
        const result = await h.desktopInput({ id: firstId, conversationId: null, requiresAuthorization: true }, sender, current);
        claimed = result.ok;
      });
    }
    return { ok: true };
  });
  let released = false;
  const departure = h.serializeTab(7, () => h.releaseTab(7, secondId, sender.documentId, 1))
    .then(() => { released = true; });
  // A bounded observation exposes the circular wait in the old implementation.
  await vi.waitFor(() => { expect(released).toBe(true); expect(claimed).toBe(true); expect(catalogObserved).toBe(true); });
  await departure; await h.maintain();
  expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/closed')).toBe(true);
  expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/input/claim')).toBe(true);
  expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/models')).toBe(true);
  expect(h.localSaved.inputOpenings).toMatchObject({ [firstId]: { tab: 7, stage: 'ready' } });
  expect(h.create).not.toHaveBeenCalled();
});

it('keeps one elected input after ChatGPT strips its cos-input marker', async () => {
  const h = await worker([{ id: firstId, conversationId: null }]);
  await h.maintain();
  const tab = h.tabs.find(row => String(row.pendingUrl || row.url || '').includes(`cos-input=${firstId}`))!;
  await h.update(tab.id, { url: 'https://chatgpt.com/' });
  await h.maintain();
  expect(h.create).toHaveBeenCalledTimes(1);
  const sender = { tab: { id: tab.id }, documentId: 'hydrated-input-page', frameId: 0, url: tab.url };
  const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
  const result = await h.desktopInput({ id: firstId, conversationId: null, requiresAuthorization: true }, sender, source);
  expect(result.ok).toBe(true);
  expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/input/claim')).toBe(true);
});

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const backgroundSource = readFileSync(join(__dirname, '..', 'extension', 'background.js'), 'utf8');

describe('expired helper tab retirement (repeated helper tab growth)', () => {
  function extractCleanup() {
    const start = backgroundSource.indexOf('async function cleanupRetiredInputTabs(');
    const end = backgroundSource.indexOf('\nconst desktopInputReceiverRepairs', start);
    return backgroundSource.slice(start, end);
  }

  function makeDeps(overrides: Record<string, unknown> = {}) {
    return {
      Date, Number, Set, Object, Array, URL, console: { info: vi.fn(), warn: vi.fn() },
      CHATGPT_TAB_URLS: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
      commandLeaseGeneration: 'gen-1',
      connectionEpoch: 0,
      RETIRED_INPUT_TAB_GRACE_MS: 30_000,
      RETIRED_INPUT_SWEEP_MS: 15_000,
      lastRetiredInputSweepAt: 0,
      persistLive: vi.fn(async () => undefined),
      stopOpenings: {},
      modelCatalogTarget: null,
      chrome: {
        storage: { session: { get: vi.fn(async () => ({ pluginRefreshOwner: null })) } },
        tabs: {
          query: vi.fn(async () => []),
          get: vi.fn(async () => null)
        }
      },
      storedBackgroundWindow: vi.fn(async () => ({ id: 1 })),
      ownsDocument: vi.fn(() => true),
      temporaryHelperOutputSaved: vi.fn(async () => false),
      tabDocuments: {}, tabEpochs: { "41": 0 }, tabConversations: {},
      conversationFromUrl: vi.fn(() => null),
      retireAutomaticTab: vi.fn(async () => true),
      tabReply: vi.fn(async () => ({ safe: true, conversationId: null, navigationEpoch: 0 })),
      temporaryPlannerCloseProofMatches: vi.fn(() => true),
      ...overrides
    };
  }

  function tab(id: number) {
    return { id, url: 'https://chatgpt.com/?temporary-chat=true&cos-input=a1111111-2222-4333-8444-555555555555', pinned: false, pendingUrl: '', active: false, windowId: 1 };
  }

  it('expired helper with outputSaved:false closes its tab without an output check', async () => {
    const code = extractCleanup();
    const temporaryHelperOutputSaved = vi.fn(async () => false);
    const retireAutomaticTab = vi.fn(async () => true);
    const deps = makeDeps({
      temporaryHelperOutputSaved,
      retireAutomaticTab,
      ownsDocument: vi.fn(() => true),
      conversationFromUrl: vi.fn(() => null),
      chrome: {
        storage: { session: { get: vi.fn(async () => ({ pluginRefreshOwner: null })) } },
        tabs: { query: vi.fn(async () => [tab(41)]), get: vi.fn(async (id: number) => tab(id)) }
      }
    });
    const run = vm.runInNewContext(`${code};cleanupRetiredInputTabs`, deps);
    const id = 'a1111111-2222-4333-8444-555555555555';
    const elections: Record<string, { tab: number; stage: string; retiredAt: number; temporary: boolean; owner: string; conversationId: string | null; outputSaved?: boolean }> = {
      [id]: { tab: 41, stage: 'retired', retiredAt: Date.now() - 60_000, temporary: true, owner: 'expired-page', conversationId: null, outputSaved: false }
    };
    await run(elections, []);
    expect(temporaryHelperOutputSaved).not.toHaveBeenCalled();
    expect(retireAutomaticTab).toHaveBeenCalledWith(41, expect.any(Function), null, expect.any(Function));
    expect(elections[id]).toBeUndefined();
  });

  it('successfully completed helper with outputSaved:true still requires the output check', async () => {
    const code = extractCleanup();
    const temporaryHelperOutputSaved = vi.fn(async () => false);
    const retireAutomaticTab = vi.fn(async () => true);
    const deps = makeDeps({
      temporaryHelperOutputSaved,
      retireAutomaticTab,
      ownsDocument: vi.fn(() => true),
      conversationFromUrl: vi.fn(() => null),
      chrome: {
        storage: { session: { get: vi.fn(async () => ({ pluginRefreshOwner: null })) } },
        tabs: { query: vi.fn(async () => [tab(41)]), get: vi.fn(async (id: number) => tab(id)) }
      }
    });
    const run = vm.runInNewContext(`${code};cleanupRetiredInputTabs`, deps);
    const id = 'a1111111-2222-4333-8444-555555555555';
    const elections: Record<string, { tab: number; stage: string; retiredAt: number; temporary: boolean; owner: string; conversationId: string | null; outputSaved?: boolean }> = {
      [id]: { tab: 41, stage: 'retired', retiredAt: Date.now() - 60_000, temporary: true, owner: 'completed-page', conversationId: null, outputSaved: true }
    };
    await run(elections, []);
    expect(temporaryHelperOutputSaved).toHaveBeenCalled();
    expect(retireAutomaticTab).not.toHaveBeenCalled();
    expect(elections[id]).toBeDefined();
  });

  it('retired opening without outputSaved flag still requires the output check (backward compat)', async () => {
    const code = extractCleanup();
    const temporaryHelperOutputSaved = vi.fn(async () => false);
    const retireAutomaticTab = vi.fn(async () => true);
    const deps = makeDeps({
      temporaryHelperOutputSaved,
      retireAutomaticTab,
      ownsDocument: vi.fn(() => true),
      conversationFromUrl: vi.fn(() => null),
      chrome: {
        storage: { session: { get: vi.fn(async () => ({ pluginRefreshOwner: null })) } },
        tabs: { query: vi.fn(async () => [tab(41)]), get: vi.fn(async (id: number) => tab(id)) }
      }
    });
    const run = vm.runInNewContext(`${code};cleanupRetiredInputTabs`, deps);
    const id = 'a1111111-2222-4333-8444-555555555555';
    const elections: Record<string, { tab: number; stage: string; retiredAt: number; temporary: boolean; owner: string; conversationId: string | null }> = {
      [id]: { tab: 41, stage: 'retired', retiredAt: Date.now() - 60_000, temporary: true, owner: 'old-page', conversationId: null }
    };
    await run(elections, []);
    expect(temporaryHelperOutputSaved).toHaveBeenCalled();
    expect(retireAutomaticTab).not.toHaveBeenCalled();
    expect(elections[id]).toBeDefined();
  });
});

import { afterEach, beforeEach, expect, it } from 'vitest';
import { initConfigPath, defaultConfig, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import {
  createSession,
  flushSessions,
  initSessionStore,
  resetSessionStoreForTests,
  upsertMessageEvent
} from '../src/main/session/store.js';
import {
  locateRecordedSearchMatch,
  resetSessionSearchForTests,
  searchRecordedSessions,
  sessionSearchSettledForTests
} from '../src/main/session/search.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-search-');
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  await saveConfig(defaultConfig());
  resetSessionSearchForTests();
});
afterEach(async () => {
  await sessionSearchSettledForTests();
  resetSessionSearchForTests();
  await flushDurable();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

let counter = 0;
async function chat(title: string, rows: Array<['user' | 'assistant', string, string?]>): Promise<string> {
  const session = await createSession({ conversationId: `search-${++counter}`, title });
  for (const [role, text, authoredText] of rows) {
    const messageId = `search-message-${++counter}`;
    if (role === 'user') {
      await upsertMessageEvent(session.id, {
        kind: 'user_message', source: 'app', time: Date.now(), messageId,
        ...(authoredText ? { authoredText } : {}),
        message: { text, chars: text.length, truncated: false }
      });
    } else {
      await upsertMessageEvent(session.id, {
        kind: 'assistant_message', source: 'extension', time: Date.now(), messageId,
        message: { text, chars: text.length, truncated: false }, state: 'final', final: true
      });
    }
  }
  await flushSessions();
  return session.id;
}

async function search(query: string) {
  await searchRecordedSessions(query);
  await sessionSearchSettledForTests();
  return searchRecordedSessions(query);
}

it('searches retained chats by title and message text and locates the matching message', async () => {
  const first = await chat('Bridge repair', [['user', 'fix the Windows bridge']]);
  const second = await chat('Release planning', [['assistant', 'The Windows installer follows the bridge verification.']]);
  const reply = await search('windows bridge');
  expect(reply.results.map(row => row.id).sort()).toEqual([first, second].sort());
  expect(reply).toMatchObject({ indexed: 2, total: 2 });
  const location = await locateRecordedSearchMatch(second, 'installer');
  expect(location).toMatchObject({ kind: 'assistant_message', messageId: expect.any(String), seq: expect.any(Number) });
});

it('indexes authored user text instead of the app transport envelope', async () => {
  const id = await chat('Opened by CoS', [[
    'user',
    '[[COS_CONTEXT:10]]\nSECRETPROTOCOLWORD instructions\n[[/COS_CONTEXT]]\n\nRefactor the parser',
    'Refactor the parser'
  ]]);
  expect((await search('refactor parser')).results.map(row => row.id)).toEqual([id]);
  expect((await search('SECRETPROTOCOLWORD')).results).toEqual([]);
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { onLog, resetLoggerForTests } from '../src/main/logger.js';
type LogEntry = { message: string };
type Handler = (event: unknown, payload: unknown) => Promise<any>;
const handlers = new Map<string, Handler>();
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, shell: {}, nativeTheme: { themeSource: 'system' },
  app: { getPath: () => '', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (text: string) => Buffer.from(text),
    decryptStringAsync: async (data: Buffer) => ({ result: data.toString(), shouldReEncrypt: false })
  }
}));
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => process.cwd() }));
vi.mock('../src/main/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/connection.js')>();
  return { ...actual, connect: async () => {}, getStatus: () => ({ ...actual.getStatus(), state: 'disconnected' }) };
});
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: async () => 'chrome.exe', isPreferredBrowserRunning: vi.fn(async () => null) }));
const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initDurableStore } = await import('../src/main/durable.js');
const { initSessionStore, createSession } = await import('../src/main/session/store.js');
const input = await import('../src/main/session/input.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

/**
 * Focused read-only trace tests for the browser publication boundary in
 * session/input.ts. The trace is a diagnostic only: it names the first guarded
 * refusal stage for a due, otherwise-ready input and must never change what
 * pendingBrowserInputs returns, never publish raw text and never repeat.
 */

let directory: string;
let directories: string[] = [];
const message = (sessionId: string | null, text = 'Complete this request') => ({
  id: randomUUID(), sessionId, automation: 'off' as const, text, mode: 'auto' as const,
  dueAt: Date.now(), model: null, reasoningEffort: null
});
let lineCount: (match: string) => number;
const captured: string[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(async () => {
  directory = await makeTempDir('clf-input-claim-trace-');
  directories.push(directory);
  initConfigPath(directory); initSecretsPath(directory);
  initDurableStore(directory); initSessionStore(directory);
  await saveConfig(defaultConfig());
  input.resetInputForTests(); resetLoggerForTests();
  captured.length = 0; unsubscribe?.(); unsubscribe = null;
  unsubscribe = onLog((entry: LogEntry) => captured.push(entry.message));
  lineCount = match => captured.filter(row => row === match).length;
});
afterAll(async () => {
  for (const directory of directories) await removeTempDir(directory);
});

describe('pendingBrowserInputs first-refusal trace', () => {
  it('names the exact not-due hold once and never repeats it', async () => {
    const session = await createSession({ conversationId: randomUUID() });
    const row = await input.enqueueInput({ ...message(session.id), dueAt: Date.now() + 60_000 });
    expect(await input.pendingBrowserInputs()).toEqual([]);
    const expected = `input ${row.id}: browser publish held stage=not-due; saved input retained, no Send authorized`;
    expect(lineCount(expected)).toBe(1);
    await input.pendingBrowserInputs();
    expect(lineCount(expected)).toBe(1);
  });

  it('names the browser-policy stage with its fixed nested enum under signed-out custody', async () => {
    const session = await createSession({ conversationId: randomUUID() });
    const row = await input.enqueueInput({ ...message(session.id) });
    await input.setBrowserDecisionAuthentication('signed-out');
    expect(await input.pendingBrowserInputs()).toEqual([]);
    const expected = `input ${row.id}: browser publish held stage=browser-policy:browser-signed-out; saved input retained, no Send authorized`;
    expect(lineCount(expected)).toBe(1);
    await input.pendingBrowserInputs();
    expect(lineCount(expected)).toBe(1);
  });

  it('publishes an offered conversationless row with no claim trace and no text leakage', async () => {
    const row = await input.enqueueInput({ ...message(null) });
    const published = await input.pendingBrowserInputs();
    expect(published.map(entry => entry.id)).toContain(row.id);
    expect(captured.filter(row => row.includes('browser publish held')).length).toBe(0);
    expect(captured.some(row => row.includes('Complete this request'))).toBe(false);
  });

  it('keeps every trace line to fixed lower-case enum grammar', async () => {
    expect(captured.filter(row => row.includes('browser publish held')).every(row => {
      const match = /input [0-9a-f-]{36}: browser publish held stage=[a-z-]{2,48}(:[a-z-]{2,48})?; saved input retained, no Send authorized/
        .exec(row);
      return match !== null;
    })).toBe(true);
  });
});

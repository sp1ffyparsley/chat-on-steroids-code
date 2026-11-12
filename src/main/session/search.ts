/**
 * Local chat search by title and recorded user/assistant text.
 *
 * Full journals can contain large tool payloads, so search keeps a plain-text index beside each
 * session. Large indexes stay on disk and are searched in bounded 64KB windows without truncating
 * long conversations. The index never contains tool arguments/results and never leaves this machine.
 */
import { createReadStream, promises as fs } from 'node:fs';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { positionOf } from '../../shared/chronology.js';
import type { SessionEvent, SessionSearchLocation, SessionSearchReply, SessionSearchResult, SessionSummary } from '../../shared/session.js';
import { logWarn } from '../logger.js';
import { indexedSessions, readEvents, readOverflowText, sessionSearchIndexPath } from './store.js';

const INDEX_READ_BYTES = 64 * 1024;
const MAX_CACHED_INDEX_CHARS = 1_000_000;
const CACHE_CHARS = 20_000_000;
const SNIPPET_CHARS = 150;
// Version 1 indexes may have silently omitted everything after the first 750,000 characters.
const INDEX_VERSION = 2;
const INDEX_RETRY_MS = 30_000;
export const MAX_SESSION_SEARCH_RESULTS = 50;

export function foldSearchText(text: string): string {
  return text.replace(/[A-Z]+|[^\x00-\x7f]/gu, chunk => {
    if (chunk.charCodeAt(0) < 0x80) return chunk.toLowerCase();
    const lower = chunk.toLowerCase();
    const base = lower.length === chunk.length ? lower : chunk;
    const bare = base.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
    return bare.length === chunk.length ? bare : base;
  });
}

const stampOf = (summary: SessionSummary): string => `${INDEX_VERSION}:${summary.updatedAt}:${summary.events ?? 0}`;
const cache = new Map<string, { stamp: string; text: string; lower: string }>();
const current = new Map<string, string>();
/** One cooldown and warning per failed chat revision; success or deletion retires it. */
const failures = new Map<string, { stamp: string; retryAt: number }>();
let cachedChars = 0;
let indexing: Promise<void> | null = null;
let indexingWanted = false;

function searchable(summary: SessionSummary): boolean {
  return summary.origin?.kind !== 'helper';
}

function remember(id: string, stamp: string, text: string) {
  const old = cache.get(id);
  if (old) { cachedChars -= old.text.length; cache.delete(id); }
  const entry = { stamp, text, lower: foldSearchText(text) };
  cache.set(id, entry);
  cachedChars += text.length;
  for (const [key, value] of cache) {
    if (cachedChars <= CACHE_CHARS) break;
    cache.delete(key); cachedChars -= value.text.length;
  }
  return entry;
}

async function fullMessageText(sessionId: string, event: Extract<SessionEvent, { kind: 'user_message' | 'assistant_message' }>): Promise<string> {
  if (event.kind === 'user_message' && event.authoredText !== undefined) return event.authoredText;
  if (event.message.truncated && event.message.assetId) {
    return (await readOverflowText(sessionId, event.message.assetId)) ?? event.message.text;
  }
  return event.message.text;
}

/** Streams the chat's words message by message without truncating long histories. */
async function* transcriptText(id: string): AsyncGenerator<string> {
  const events = await readEvents(id, { kinds: ['user_message', 'assistant_message'] });
  for (const event of events) {
    if (event.kind !== 'user_message' && event.kind !== 'assistant_message') continue;
    const clean = (await fullMessageText(id, event)).replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    yield clean;
  }
}

/** Checks the stamp, then streams text when requested. No visitor means a header-only check. */
async function storedIndex(id: string, stamp: string, visit?: (text: string) => void): Promise<boolean> {
  const header = `${stamp}\n`;
  let prefix = '', checked = false;
  try {
    for await (const chunk of createReadStream(sessionSearchIndexPath(id), { encoding: 'utf8', highWaterMark: INDEX_READ_BYTES })) {
      let text = chunk as string;
      if (!checked) {
        prefix += text;
        if (prefix.length < header.length) continue;
        if (!prefix.startsWith(header)) return false;
        if (!visit) return true;
        checked = true;
        text = prefix.slice(header.length);
        prefix = '';
      }
      visit!(text);
    }
    return checked;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function indexOne(summary: SessionSummary): Promise<void> {
  const stamp = stampOf(summary);
  if (current.get(summary.id) === stamp) return;
  const valid = await storedIndex(summary.id, stamp).catch(error => {
    if (failures.get(summary.id)?.stamp !== stamp) {
      logWarn(`search: chat ${summary.id} index unreadable; rebuilding: ${(error as Error).message}`);
    }
    return false;
  });
  if (!valid) {
    const file = sessionSearchIndexPath(summary.id);
    // One indexer owns this file; a restart truncates its unfinished predecessor instead of
    // leaving orphaned PID-suffixed temporaries behind.
    const temporary = `${file}.tmp`;
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(temporary, 'w');
      await handle.writeFile(`${stamp}\n`, 'utf8');
      let chars = 0;
      const parts: string[] = [];
      let separator = '';
      for await (const paragraph of transcriptText(summary.id)) {
        const piece = `${separator}${paragraph}`;
        separator = '\n';
        await handle.writeFile(piece, 'utf8');
        chars += piece.length;
        if (chars <= MAX_CACHED_INDEX_CHARS) parts.push(piece);
        else parts.length = 0;
      }
      await handle.close();
      handle = null;
      await fs.rename(temporary, file);
      if (chars <= MAX_CACHED_INDEX_CHARS) remember(summary.id, stamp, parts.join(''));
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
  }
  current.set(summary.id, stamp);
}

function startIndexing(): void {
  indexingWanted = true;
  if (indexing) return;
  indexing = (async () => {
    while (indexingWanted) {
      indexingWanted = false;
      const summaries = (await indexedSessions()).filter(searchable).sort((a, b) => b.updatedAt - a.updatedAt);
      const live = new Set(summaries.map(summary => summary.id));
      for (const id of [...current.keys()]) {
        if (live.has(id)) continue;
        current.delete(id);
        const old = cache.get(id);
        if (old) { cachedChars -= old.text.length; cache.delete(id); }
      }
      for (const id of failures.keys()) if (!live.has(id)) failures.delete(id);
      for (const summary of summaries) {
        const stamp = stampOf(summary);
        const failure = failures.get(summary.id);
        if (failure?.stamp === stamp && Date.now() < failure.retryAt) continue;
        try {
          await indexOne(summary);
          failures.delete(summary.id);
        } catch (error) {
          failures.set(summary.id, { stamp, retryAt: Date.now() + INDEX_RETRY_MS });
          if (failure?.stamp !== stamp) {
            logWarn(`search: chat ${summary.id} not indexed; searches will retry after 30 seconds (changed chats retry immediately): ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        await yieldToEvents();
      }
    }
  })().finally(() => { indexing = null; });
}

export function queryTerms(query: string): string[] {
  return [...new Set(foldSearchText(query).split(/\s+/).map(term => term.trim()).filter(Boolean))].slice(0, 12);
}

function matchRanges(lower: string, terms: string[], offset = 0): Array<[number, number]> {
  const matches: Array<[number, number]> = [];
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) {
      matches.push([offset + at, offset + at + term.length]);
    }
  }
  return matches.sort((a, b) => a[0] - b[0]);
}

function snippetFor(text: string, lower: string, terms: string[]): SessionSearchResult['snippet'] {
  const positions = terms.map(term => lower.indexOf(term)).filter(at => at >= 0);
  if (!positions.length) return undefined;
  const first = Math.min(...positions);
  const lineStart = lower.lastIndexOf('\n', first) + 1;
  const foundEnd = lower.indexOf('\n', first);
  const lineEnd = foundEnd < 0 ? lower.length : foundEnd;
  let start = Math.max(lineStart, first - Math.floor(SNIPPET_CHARS / 3));
  const end = Math.min(lineEnd, start + SNIPPET_CHARS);
  if (end - start < SNIPPET_CHARS) start = Math.max(lineStart, end - SNIPPET_CHARS);
  const prefix = start > lineStart ? '…' : '';
  const suffix = end < lineEnd ? '…' : '';
  return { text: prefix + text.slice(start, end) + suffix, matches: matchRanges(lower.slice(start, end), terms, prefix.length) };
}

/** Search windows overlap so neither a word nor the context around its first match is split. */
function indexMatcher(title: string, terms: string[]) {
  const matched = new Set(terms.filter(term => title.includes(term)));
  const overlap = Math.max(...terms.map(term => term.length)) + SNIPPET_CHARS * 2;
  let tail = '', snippet: SessionSearchResult['snippet'];
  const visit = (chunk: string, final = false): void => {
    const text = tail + chunk, lower = foldSearchText(text);
    for (const term of terms) if (lower.includes(term)) matched.add(term);
    if (!snippet) {
      const first = Math.min(...terms.map(term => lower.indexOf(term)).filter(at => at >= 0));
      if (Number.isFinite(first) && (final || first + SNIPPET_CHARS <= text.length || text.indexOf('\n', first) >= 0)) {
        snippet = snippetFor(text, lower, terms.filter(term => lower.includes(term)));
      }
    }
    tail = text.slice(-overlap);
  };
  return {
    visit,
    finish: () => {
      visit('', true);
      return matched.size === terms.length ? { snippet } : null;
    }
  };
}

/** Reuse small indexes; stream large ones without putting the whole conversation in memory. */
async function matchIndex(id: string, stamp: string, title: string, terms: string[]): Promise<{ snippet: SessionSearchResult['snippet'] } | null> {
  const cached = cache.get(id);
  if (cached?.stamp === stamp) {
    if (!terms.every(term => title.includes(term) || cached.lower.includes(term))) return null;
    return { snippet: snippetFor(cached.text, cached.lower, terms.filter(term => cached.lower.includes(term))) };
  }
  const matcher = indexMatcher(title, terms);
  let chars = 0, parts: string[] = [];
  try {
    const valid = await storedIndex(id, stamp, text => {
      matcher.visit(text);
      chars += text.length;
      if (chars <= MAX_CACHED_INDEX_CHARS) parts.push(text);
      else parts = [];
    });
    if (!valid) {
      logWarn(`search: chat ${id} index missing or stale; skipped, will be rebuilt`);
      if (current.get(id) === stamp) current.delete(id);
      return null;
    }
  } catch (error) {
    if (current.get(id) === stamp) current.delete(id);
    logWarn(`search: chat ${id} index could not be read; will retry on the next search: ${(error as Error).message}`);
    return null;
  }
  if (current.get(id) !== stamp) {
    logWarn(`search: chat ${id} changed while it was searched; skipped`);
    return null;
  }
  if (chars <= MAX_CACHED_INDEX_CHARS) remember(id, stamp, parts.join(''));
  return matcher.finish();
}

export async function searchRecordedSessions(query: string, limit = MAX_SESSION_SEARCH_RESULTS): Promise<SessionSearchReply> {
  const terms = queryTerms(query);
  const summaries = (await indexedSessions()).filter(searchable).sort((a, b) => b.updatedAt - a.updatedAt);
  startIndexing();
  const indexed = summaries.filter(summary => current.get(summary.id) === stampOf(summary)).length;
  if (!terms.length) return { results: [], indexed, total: summaries.length };

  const byTitle: SessionSearchResult[] = [];
  const byText: SessionSearchResult[] = [];
  for (const summary of summaries) {
    const title = foldSearchText(summary.title);
    const result: SessionSearchResult = { id: summary.id, title: summary.title, projectId: summary.projectId ?? null };
    if (terms.every(term => title.includes(term))) {
      result.titleMatches = matchRanges(title, terms);
      byTitle.push(result);
      continue;
    }
    const stamp = stampOf(summary);
    if (current.get(summary.id) !== stamp) continue;
    const match = await matchIndex(summary.id, stamp, title, terms);
    if (!match) continue;
    byText.push({ ...result, snippet: match.snippet });
    if (byTitle.length + byText.length >= limit * 2) break;
  }
  const found = byTitle.length + byText.length;
  return {
    results: [...byTitle, ...byText].slice(0, limit),
    indexed: summaries.filter(summary => current.get(summary.id) === stampOf(summary)).length,
    total: summaries.length,
    ...(found > limit ? { limited: true as const } : {})
  };
}

export async function locateRecordedSearchMatch(id: string, query: string): Promise<SessionSearchLocation | null> {
  const terms = queryTerms(query);
  if (!terms.length) return null;
  const events = await readEvents(id, { kinds: ['user_message', 'assistant_message'] });
  for (const event of events) {
    if (event.kind !== 'user_message' && event.kind !== 'assistant_message') continue;
    const text = foldSearchText((await fullMessageText(id, event)).replace(/\s+/g, ' '));
    if (!terms.some(term => text.includes(term))) continue;
    return { seq: event.seq, kind: event.kind, messageId: event.messageId ?? null, position: positionOf(event) };
  }
  return null;
}

export async function sessionSearchSettledForTests(): Promise<void> {
  while (indexing) await indexing;
}

export function resetSessionSearchForTests(): void {
  cache.clear(); current.clear(); failures.clear(); cachedChars = 0; indexingWanted = false;
}

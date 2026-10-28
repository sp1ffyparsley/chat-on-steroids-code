/**
 * Local chat search by title and recorded user/assistant text.
 *
 * Full journals can contain large tool payloads, so search keeps a bounded text-only index beside
 * each session. The index never contains tool arguments/results and never leaves this machine.
 */
import { promises as fs } from 'node:fs';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { positionOf } from '../../shared/chronology.js';
import type { SessionEvent, SessionSearchLocation, SessionSearchReply, SessionSearchResult, SessionSummary } from '../../shared/session.js';
import { logWarn } from '../logger.js';
import { indexedSessions, readEvents, readOverflowText, sessionSearchIndexPath } from './store.js';

const MAX_INDEX_CHARS = 750_000;
const CACHE_CHARS = 20_000_000;
const SNIPPET_CHARS = 150;
const INDEX_VERSION = 1;
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

async function transcriptText(id: string): Promise<string> {
  const events = await readEvents(id, { kinds: ['user_message', 'assistant_message'] });
  const parts: string[] = [];
  let size = 0;
  for (const event of events) {
    if (event.kind !== 'user_message' && event.kind !== 'assistant_message') continue;
    const clean = (await fullMessageText(id, event)).replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    parts.push(clean);
    size += clean.length + 1;
    if (size >= MAX_INDEX_CHARS) break;
  }
  return parts.join('\n').slice(0, MAX_INDEX_CHARS);
}

async function storedIndex(id: string, stamp: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(sessionSearchIndexPath(id), 'utf8');
    const newline = raw.indexOf('\n');
    if (newline < 0 || raw.slice(0, newline) !== stamp) return null;
    return raw.slice(newline + 1);
  } catch { return null; }
}

async function indexOne(summary: SessionSummary): Promise<void> {
  const stamp = stampOf(summary);
  if (current.get(summary.id) === stamp) return;
  let text = await storedIndex(summary.id, stamp);
  if (text === null) {
    text = await transcriptText(summary.id);
    const file = sessionSearchIndexPath(summary.id);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, `${stamp}\n${text}`, 'utf8');
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
  }
  remember(summary.id, stamp, text);
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
      for (const summary of summaries) {
        try { await indexOne(summary); }
        catch (error) {
          logWarn(`search: chat ${summary.id} was not indexed: ${error instanceof Error ? error.message : String(error)}`);
          current.set(summary.id, stampOf(summary));
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
    let entry = cache.get(summary.id);
    if (!entry && current.has(summary.id)) {
      const text = await storedIndex(summary.id, current.get(summary.id)!);
      if (text !== null) entry = remember(summary.id, current.get(summary.id)!, text);
    }
    if (!entry) continue;
    if (!terms.every(term => title.includes(term) || entry!.lower.includes(term))) continue;
    const inText = terms.filter(term => entry!.lower.includes(term));
    byText.push({ ...result, snippet: snippetFor(entry.text, entry.lower, inText) });
    if (byTitle.length + byText.length >= limit * 2) break;
  }
  const found = byTitle.length + byText.length;
  return { results: [...byTitle, ...byText].slice(0, limit), indexed, total: summaries.length, ...(found > limit ? { limited: true as const } : {}) };
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
  cache.clear(); current.clear(); cachedChars = 0; indexingWanted = false;
}

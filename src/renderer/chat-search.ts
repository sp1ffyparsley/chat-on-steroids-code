import type { SessionSearchReply } from '../shared/session.js';
import { $, el, icon, run } from './dom.js';
import { t, ui } from './i18n.js';

const api = window.api;
const TYPE_DELAY_MS = 150;
const INDEX_RECHECK_MS = 700;
const RECENT_LIMIT = 30;

export interface ChatSearchOptions {
  select(id: string, match?: string): void;
  selectedId(): string | null;
  recent(): Array<{ id: string; title: string }>;
  beforeOpen?(): void;
}

function marked(tag: 'b' | 'span', className: string, text: string, matches: Array<[number, number]> = []): HTMLElement {
  const node = el(tag, className);
  node.dir = 'auto';
  let at = 0;
  for (const [start, end] of matches) {
    if (start < at) continue;
    if (start > at) node.append(text.slice(at, start));
    node.append(el('mark', '', text.slice(start, end)));
    at = end;
  }
  if (at < text.length) node.append(text.slice(at));
  return node;
}

export function initChatSearch(options: ChatSearchOptions): { refresh(): void; readonly active: boolean } {
  const dialog = $<HTMLDialogElement>('searchDialog');
  const field = $<HTMLInputElement>('chatSearch');
  const clear = $<HTMLButtonElement>('chatSearchClear');
  const results = $('searchResults');
  const opener = $<HTMLButtonElement>('searchChatsButton');
  let generation = 0;
  let typingTimer = 0;
  let recheckTimer = 0;
  let last: SessionSearchReply | null = null;

  const query = (): string => field.value.trim();

  const close = (): void => {
    window.clearTimeout(typingTimer);
    window.clearTimeout(recheckTimer);
    if (dialog.open) dialog.close();
  };

  const resultRow = (id: string, title: HTMLElement, snippet?: HTMLElement, match?: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chat-search-result${id === options.selectedId() ? ' is-sel' : ''}`;
    button.dataset.searchId = id;
    button.setAttribute('role', 'listitem');
    button.append(title);
    if (snippet) button.append(snippet);
    button.addEventListener('click', () => {
      close();
      options.select(id, match);
    });
    return button;
  };

  const paint = (): void => {
    results.replaceChildren();
    if (!query()) {
      const recent = options.recent().slice(0, RECENT_LIMIT);
      if (!recent.length) {
        results.append(el('p', 'chat-search-status', () => t('No recorded chats yet.')));
        return;
      }
      results.append(el('p', 'chat-search-heading', () => t('Recent')));
      for (const chat of recent) results.append(resultRow(chat.id, marked('b', '', chat.title || t('Untitled session'))));
      return;
    }
    if (!last) {
      results.append(el('p', 'chat-search-status', () => t('Searching…')));
      return;
    }
    for (const result of last.results) {
      results.append(resultRow(
        result.id,
        marked('b', '', result.title || t('Untitled session'), result.titleMatches),
        result.snippet ? marked('span', 'chat-search-snippet', result.snippet.text, result.snippet.matches) : undefined,
        result.snippet ? query() : undefined
      ));
    }
    if (last.indexed < last.total) {
      results.append(el('p', 'chat-search-status', () => t('Searching message text… {0} of {1} chats', [last!.indexed, last!.total])));
    } else if (!last.results.length) {
      results.append(el('p', 'chat-search-status', () => t('No chats match')));
    } else if (last.limited) {
      results.append(el('p', 'chat-search-status', () => t('Showing the first {0} matches. Add a word to narrow them down.', [last!.results.length])));
    }
  };

  const search = async (): Promise<void> => {
    window.clearTimeout(recheckTimer);
    const text = query();
    const mine = ++generation;
    clear.hidden = !field.value;
    if (!text) { last = null; paint(); return; }
    last = null; paint();
    const reply = await run(api.searchSessions(text));
    if (!reply || mine !== generation || !dialog.open) return;
    last = reply;
    paint();
    if (reply.indexed < reply.total) recheckTimer = window.setTimeout(() => { if (mine === generation) void search(); }, INDEX_RECHECK_MS);
  };

  const later = (): void => {
    window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => void search(), TYPE_DELAY_MS);
  };

  const open = (): void => {
    options.beforeOpen?.();
    if (!dialog.open) dialog.showModal();
    field.focus(); field.select();
    void search();
  };

  ui(field, 'placeholder', () => t('Search chats'));
  ui(field, 'aria-label', () => t('Search chats'));
  ui(dialog, 'aria-label', () => t('Search chats'));
  ui(opener, 'title', () => t('Search chats (Ctrl+K)'));
  ui(opener, 'aria-label', () => t('Search chats'));
  clear.append(icon('i-x'));

  opener.addEventListener('click', open);
  clear.addEventListener('click', () => { field.value = ''; void search(); field.focus(); });
  field.addEventListener('input', later);
  field.addEventListener('keydown', event => {
    const rows = [...results.querySelectorAll<HTMLButtonElement>('.chat-search-result')];
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'Enter' && rows[0]) { event.preventDefault(); rows[0].click(); return; }
    if (event.key === 'ArrowDown' && rows[0]) { event.preventDefault(); rows[0].focus(); }
  });
  results.addEventListener('keydown', event => {
    const rows = [...results.querySelectorAll<HTMLButtonElement>('.chat-search-result')];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    if (event.key === 'ArrowDown' && rows[at + 1]) { event.preventDefault(); rows[at + 1]!.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); (rows[at - 1] ?? field).focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  document.addEventListener('keydown', event => {
    if (event.key.toLowerCase() !== 'k' || event.shiftKey || event.altKey || event.repeat) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    open();
  });

  return {
    refresh(): void { if (dialog.open) void search(); },
    get active(): boolean { return dialog.open && !!query(); }
  };
}

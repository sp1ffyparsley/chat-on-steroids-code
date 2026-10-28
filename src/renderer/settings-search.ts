import { $, el } from './dom.js';
import { currentLanguage, t, ui } from './i18n.js';

interface SettingEntry {
  tab: string;
  page: string;
  section: string;
  title: string;
  detail: string;
  target: HTMLElement;
}

const MAX_RESULTS = 14;

export function foldSettingsSearch(text: string, language = currentLanguage()): string {
  return text.toLocaleLowerCase(language).normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();
}

function text(node: Element | null | undefined): string {
  return node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function pageFor(tab: string, root: ParentNode): HTMLElement | null {
  if (tab === 'settings') return root.querySelector<HTMLElement>('[data-view="settings"]');
  return root.querySelector<HTMLElement>(`[data-panel="${tab}"]`);
}

export function collectSettings(root: ParentNode = document): SettingEntry[] {
  const entries: SettingEntry[] = [];
  for (const button of root.querySelectorAll<HTMLElement>('#tabs button[data-tab]')) {
    const tab = button.dataset.tab!;
    const page = pageFor(tab, root);
    if (!page) continue;
    const pageName = text(button.querySelector(':scope > :not(.badge)')) || text(button);
    let section = '';
    for (const node of page.querySelectorAll<HTMLElement>('.settings-heading, .settings-section-title, .settings-section-head, .setting, .field > label, .perm-main, .setup-rail button[data-rail-step]')) {
      if (node.classList.contains('settings-heading')) {
        const title = text(node.querySelector('h1'));
        if (title) entries.push({ tab, page: pageName, section: '', title, detail: text(node.querySelector('p')), target: node });
        continue;
      }
      if (node.classList.contains('settings-section-title') || node.classList.contains('settings-section-head')) {
        section = text(node.querySelector('h2')) || text(node);
        if (section) entries.push({ tab, page: pageName, section: '', title: section, detail: '', target: node });
        continue;
      }
      if (node.matches('.setup-rail button[data-rail-step]')) {
        const title = text(node.querySelector('.setup-rail-label')) || text(node);
        if (title) entries.push({ tab, page: pageName, section: '', title, detail: '', target: node });
        continue;
      }
      const field = node.matches('.field > label');
      const title = field ? text(node) : text(node.querySelector('.setting-text > b, b'));
      if (!title) continue;
      const detail = field ? '' : text(node.querySelector('.setting-text > em, em'));
      entries.push({ tab, page: pageName, section, title, detail, target: field ? node.parentElement! : node });
    }
  }
  return entries;
}

export function searchSettings(entries: SettingEntry[], query: string, language = currentLanguage()): SettingEntry[] {
  const wanted = foldSettingsSearch(query, language);
  if (!wanted) return [];
  const terms = wanted.split(' ');
  return entries.map((entry, index) => {
    const title = foldSettingsSearch(entry.title, language);
    const place = foldSettingsSearch(`${entry.page} ${entry.section}`, language);
    const all = `${title} ${place} ${foldSettingsSearch(entry.detail, language)}`;
    if (!terms.every(term => all.includes(term))) return null;
    const rank = title.startsWith(wanted) ? 0 : terms.every(term => title.includes(term)) ? 1
      : terms.every(term => `${title} ${place}`.includes(term)) ? 2 : 3;
    return { entry, index, rank };
  }).filter((row): row is { entry: SettingEntry; index: number; rank: number } => row !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, MAX_RESULTS)
    .map(row => row.entry);
}

export function initSettingsSearch(options: { open(tab: string): void; settingsShown(): boolean }): void {
  const host = $('settingsFindHost');
  const input = $<HTMLInputElement>('settingsFind');
  const results = $('settingsFindResults');
  let markTimer = 0;

  const reset = (): void => {
    input.value = '';
    results.replaceChildren();
    results.hidden = true;
  };

  const open = (entry: SettingEntry): void => {
    reset();
    options.open(entry.tab);
    if (entry.target.matches('[data-rail-step]')) entry.target.click();
    window.requestAnimationFrame(() => {
      entry.target.scrollIntoView({ block: 'center' });
      document.querySelector('.settings-search-hit')?.classList.remove('settings-search-hit');
      entry.target.classList.add('settings-search-hit');
      window.clearTimeout(markTimer);
      markTimer = window.setTimeout(() => entry.target.classList.remove('settings-search-hit'), 1600);
      entry.target.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea, button')?.focus({ preventScroll: true });
    });
  };

  const paint = (): void => {
    results.replaceChildren();
    const query = input.value.trim();
    results.hidden = !query;
    if (!query) return;
    const found = searchSettings(collectSettings(), query);
    for (const entry of found) {
      const row = el('button', 'settings-find-result') as HTMLButtonElement;
      row.type = 'button';
      row.append(el('b', '', entry.title), el('span', '', entry.section ? `${entry.page} › ${entry.section}` : entry.page));
      row.addEventListener('click', () => open(entry));
      results.append(row);
    }
    if (!found.length) results.append(el('p', 'settings-find-empty', () => t('No settings match your search.')));
  };

  ui(input, 'placeholder', () => t('Search all settings…'));
  ui(input, 'aria-label', () => t('Search all settings'));
  input.addEventListener('input', paint);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && input.value) { event.preventDefault(); reset(); input.focus(); }
    if (event.key === 'Enter') {
      const first = results.querySelector<HTMLButtonElement>('.settings-find-result');
      if (first) { event.preventDefault(); first.click(); }
    }
  });
  document.addEventListener('keydown', event => {
    if (!options.settingsShown() || event.key.toLowerCase() !== 'f' || !event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if ((event.target as Element | null)?.closest?.('.xterm')) return;
    event.preventDefault();
    input.focus(); input.select();
  });
  host.hidden = !options.settingsShown();
}

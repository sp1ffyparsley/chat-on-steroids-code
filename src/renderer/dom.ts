import { currentLanguage, t, ui } from './i18n.js';
/**
 * The handful of DOM helpers both panels need.
 *
 * Nothing here knows about app state, and nothing here uses innerHTML — every node is
 * built from text, so a session title or a tool argument can never become markup.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One icon from the sprite in index.html. */
export function icon(name: string, className = 'ico'): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

/** One authored disclosure marker; unlike a glyph, it rotates without changing its box. */
export function disclosureChevron(className = ''): SVGSVGElement {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('class', `disclosure-chevron${className ? ` ${className}` : ''}`);
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M6 3.5 10.5 8 6 12.5');
  node.append(path);
  return node;
}

export function el(tag: string, className = '', text: string | (() => string) = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof text === 'function') ui(node, 'textContent', text);
  else if (text) node.textContent = text;
  return node;
}

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Filter complete settings sections so headings, controls and their context stay together. */
export function filterSettingsSections(view: HTMLElement, search: string): void {
  const query = search.trim().toLowerCase();
  let matches = 0;
  for (const heading of view.querySelectorAll<HTMLElement>('.settings-section-title')) {
    const pane = heading.nextElementSibling as HTMLElement | null;
    if (!pane?.classList.contains('pane')) continue;
    const visible = !query || `${heading.textContent} ${pane.textContent}`.toLowerCase().includes(query);
    heading.hidden = pane.hidden = !visible;
    if (visible) matches++;
  }
  const empty = view.querySelector<HTMLElement>('#settingsSearchEmpty');
  if (empty) empty.hidden = !query || matches > 0;
}

let toastTimer: number | undefined;

/**
 * Makes the transient notification itself a useful diagnostic surface.
 *
 * A click selects only the notification message (never an Undo/Retry label), so the ordinary
 * Ctrl/Cmd+C path works without granting the renderer a new clipboard capability. The explicit
 * copy handler keeps that contract reliable in Chromium even when focus changes the selection.
 */
function copyableToast(message: string, className: string): { node: HTMLElement; messageNode: HTMLElement } {
  const node = el('div', className);
  const messageNode = el('span', 'toast-message', message);
  node.tabIndex = 0;
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.setAttribute('aria-keyshortcuts', 'Control+C Meta+C');
  node.title = t('Click this notification, then press Ctrl+C or Cmd+C to copy it.');
  const selectMessage = (): void => {
    node.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(messageNode);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  node.addEventListener('click', (event) => {
    if ((event.target as Element | null)?.closest('button')) return;
    selectMessage();
    // A diagnostic toast normally stays compact and brief. Once the user engages with it,
    // keep it present long enough to read and copy instead of removing the selected node.
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => node.remove(), 12_000);
  });
  node.addEventListener('copy', (event) => {
    const clipboard = (event as ClipboardEvent).clipboardData;
    if (!clipboard) return;
    clipboard.setData('text/plain', message);
    event.preventDefault();
  });
  node.append(messageNode);
  return { node, messageNode };
}

export function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const { node } = copyableToast(message, 'toast');
  document.body.append(node);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.remove(), 3200);
}

/** A toast whose short-lived action can reverse a just-completed operation. */
export function toastAction(message: string, label: string, action: () => void | Promise<void>, durationMs = 12_000): void {
  document.querySelector('.toast')?.remove();
  const { node } = copyableToast(message, 'toast toast-action');
  const button = el('button', 'toast-action-button', label) as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', () => {
    window.clearTimeout(toastTimer);
    node.remove();
    void action();
  });
  node.append(button);
  document.body.append(node);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.remove(), durationMs);
}

/** Unwraps an IPC reply, showing the main process's own error text on failure. */
export async function run<T>(
  promise: Promise<{ ok: true; data: T } | { ok: false; error: string }>
): Promise<T | null> {
  const reply = await promise;
  if (!reply.ok) {
    toast(reply.error);
    return null;
  }
  return reply.data;
}

/** "12s ago" for a timestamp the main process vouched for, "never" for null. */
export function ago(atMs: number | null): string {
  if (atMs === null) return t("never");
  const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1000));
  if (seconds < 3) return t("just now");
  if (seconds < 90) return t("{0}s ago", [seconds]);
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? t("{0}m ago", [minutes]) : t("{0}h ago", [Math.round(minutes / 60)]);
}

/** The same age as one glanceable token: "8s", "2m", "—" when there is nothing. */
export function shortAgo(atMs: number | null): string {
  if (atMs === null) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1000));
  if (seconds < 3) return t("now");
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/** A clock time for one event in a timeline. */
export function clockTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString(currentLanguage());
}

/** "1.2k", "3.4M" — for token and character counts that get large. */
export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

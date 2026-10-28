import { ui, t } from './i18n.js';
import type { AgentInfo, SessionSummary, SessionEvent } from '../shared/session.js';
import { el } from './dom.js';

/** Immutable presentation fields for bounded IPC history. Comparing these avoids
 * remounting a long saved worker report when only session status metadata changed.
 * Strings are immutable; a later same-sequence text revision gets a new signature. */
function eventViewSignature(event: SessionEvent): readonly unknown[] {
  const base: unknown[] = [event.kind, event.seq, 'origin' in event ? event.origin : undefined,
    event.time, event.turnId, event.agent];
  switch (event.kind) {
    case 'tool_call':
      return [...base, event.call.callId, event.call.tool, event.call.outcome,
        event.call.attributionMethod, event.call.conversationId,
        event.call.args.text, event.call.result.text,
        event.call.args.truncated, event.call.result.truncated,
        event.call.summary.kind, event.call.summary.title,
        event.call.summary.detail, event.call.summary.metric, event.call.summary.tone,
        event.call.durationMs, event.call.process?.sessionId,
        event.call.process?.completedAt, event.call.process?.exitCode,
        JSON.stringify(event.call.changes), JSON.stringify(event.call.assets)];
    case 'user_message':
      return [...base, event.messageId, event.message.text, event.message.truncated,
        event.inputDelivery, event.inputId, JSON.stringify(event.attachments), JSON.stringify(event.assets)];
    case 'assistant_message':
      return [...base, event.messageId, event.message.text, event.message.truncated,
        event.state, event.final, event.renderedHtml?.text];
    case 'agent_message':
      return [...base, event.messageId, event.from, event.to, event.delivery,
        event.message.text, event.message.truncated, event.message.chars];
    case 'chat_error':
    case 'progress':
    case 'note':
      return [...base, event.message.text, event.message.truncated, event.message.chars,
        event.kind === 'chat_error' ? event.reason : undefined,
        event.kind === 'chat_error' ? event.blocking : undefined];
    case 'page_tool': return [...base, event.messageId, event.label];
    case 'session_start': return [...base, event.conversationId, event.title];
    case 'turn_start': return [...base, event.detail];
    case 'turn_end': return [...base, event.outcome, event.reason, event.detail];
    case 'handoff': return [...base, event.handoffId, event.reason, event.chars];
  }
}

function sameEventView(left: readonly (readonly unknown[])[] | null, right: readonly (readonly unknown[])[]): boolean {
  return !!left && left.length === right.length && left.every((row, index) =>
    row.length === right[index]?.length && row.every((part, item) => part === right[index]![item]));
}

/** A read-only second pane. Its selection never changes the main chat's composer. */
export function createAgentPanel(options: {
  host: HTMLElement;
  toggle: HTMLButtonElement;
  load: (id: string) => Promise<{ events: SessionEvent[] } | null>;
  render: (events: SessionEvent[], id: string, current: () => boolean) => HTMLElement[];
  openMain: (id: string) => void;
  working: (summary: SessionSummary) => boolean;
  /** Exact broker ownership beats a timestamp-derived activity guess when available. */
  agent?: (summary: SessionSummary) => Pick<AgentInfo, 'state' | 'task'> | null;
}) {
  const pane = el('aside', 'agent-panel'); pane.hidden = true;
  ui(pane, 'aria-label', () => t("Sub-agents"));
  const head = el('div', 'agent-panel-header');
  const back = el('button', 'btn', '←'); ui(back, 'title', () => t("Back to sub-agents")); back.setAttribute('type', 'button');
  back.setAttribute('aria-label', back.title);
  const title = el('strong', '', () => t("Sub-agents"));
  const close = el('button', 'btn', '×'); close.setAttribute('type', 'button'); ui(close, 'aria-label', () => t("Close sub-agents"));
  const body = el('div', 'agent-panel-body');
  head.append(back, title, close); pane.append(head, body); options.host.append(pane);
  let parent: string | null = null, workers: SessionSummary[] = [], selected: string | null = null;
  // A failed refresh may keep only history that this exact panel already read.
  // A prior parent's or another worker's view is never evidence for the new selection.
  let renderedWorker: string | null = null;
  let renderedEvents: readonly (readonly unknown[])[] | null = null;
  let generation = 0;
  function hide(): void {
    generation++; pane.hidden = true; selected = null; renderedWorker = null; renderedEvents = null;
    options.host.classList.remove('has-agent-panel'); options.toggle.setAttribute('aria-expanded', 'false');
  }
  function show(): void {
    pane.hidden = false; options.host.classList.add('has-agent-panel'); options.toggle.setAttribute('aria-expanded', 'true');
  }
  function list(): void {
    generation++; selected = null; renderedWorker = null; renderedEvents = null; back.hidden = true;
    ui(title, 'textContent', () => t("Sub-agents")); body.replaceChildren();
    const roster = workers.map(worker => {
      const state = options.agent?.(worker)?.state;
      // An exact broker lookup returning no row cannot delegate to a stale timestamp.
      const group = state ? (['invited', 'active', 'detached', 'waking'].includes(state) ? 'active' : 'history')
        : options.agent ? 'unknown' : options.working(worker) ? 'active' : 'history';
      return { worker, group };
    });
    for (const kind of ['active', 'unknown', 'history'] as const) {
      const group = roster.filter(row => row.group === kind);
      if (kind === 'unknown' && !group.length) continue;
      body.append(el('h3', '', () => `${kind === 'active' ? t("Active") : kind === 'unknown' ? t("Unknown") : t("History")} · ${group.length}`));
      if (!group.length) { body.append(el('p', 'meta', () => kind === 'active' ? t("No active sub-agents") : t("No recorded sub-agents"))); continue; }
      for (const { worker } of group) {
        const row = el('button', 'agent-panel-row'); row.setAttribute('type', 'button');
        row.append(el('span', 'agent-avatar', worker.origin?.agentId?.replace(/^worker-/, '') ?? '•'), el('span', '', worker.title));
        row.title = worker.origin?.task || worker.title;
        row.onclick = () => void open(worker.id); body.append(row);
      }
    }
  }
  function fullChatButton(id: string): HTMLButtonElement {
    const button = el('button', 'btn', () => t("Open full chat")) as HTMLButtonElement;
    button.type = 'button';
    button.onclick = () => { hide(); options.openMain(id); };
    return button;
  }
  async function open(id: string, refresh = false): Promise<void> {
    const worker = workers.find(row => row.id === id);
    if (!worker) return;
    const preserve = refresh && selected === id && !pane.hidden;
    const hasSavedResult = preserve && renderedWorker === id;
    show(); selected = id; const request = ++generation;
    back.hidden = false; title.textContent = worker.title;
    if (!preserve) {
      renderedWorker = null;
      renderedEvents = null;
      body.replaceChildren(el('p', 'meta', () => t("Loading conversation…")));
    }
    const current = () => request === generation && selected === id && !pane.hidden;
    let detail: Awaited<ReturnType<typeof options.load>> = null;
    try { detail = await options.load(id); }
    catch { /* A temporary exact-read failure is unknown, not an empty worker result. */ }
    if (!current()) return;
    if (!detail) {
      // Keep the previously read worker history and any focused disclosure mounted.
      // The absence of a newer read cannot erase it or prove that Prime received a report.
      const notice = body.querySelector<HTMLElement>(':scope > .agent-panel-read-notice') ??
        el('div', 'agent-panel-read-notice');
      notice.setAttribute('role', 'status');
      const explanation = notice.querySelector<HTMLElement>('p') ?? el('p', 'meta');
      explanation.textContent = hasSavedResult
        ? 'Latest worker history unavailable. Showing last confirmed worker history; newer work and Prime receipt remain unknown.'
        : 'Worker history unavailable. Saved result and Prime receipt are unknown until a successful read.';
      const retry = notice.querySelector<HTMLButtonElement>('button') ??
        el('button', 'btn', () => t("Retry worker history")) as HTMLButtonElement;
      retry.type = 'button';
      retry.disabled = false;
      retry.onclick = () => {
        retry.disabled = true;
        explanation.textContent = hasSavedResult
          ? 'Checking worker history; last confirmed result remains visible.'
          : 'Checking worker history; no saved result is confirmed yet.';
        void open(id, true);
      };
      if (!explanation.isConnected) notice.append(explanation);
      if (!retry.isConnected) notice.append(retry);
      if (!notice.isConnected) {
        if (hasSavedResult) {
          const position = body.scrollTop;
          body.insertBefore(notice, body.firstElementChild?.nextSibling ?? null);
          body.scrollTop = position;
        } else {
          body.replaceChildren(fullChatButton(id), notice);
        }
      }
      return;
    }
    const retryHadFocus = body.querySelector('.agent-panel-read-notice button') === document.activeElement;
    const nextEvents = detail.events.map(eventViewSignature);
    if (hasSavedResult && sameEventView(renderedEvents, nextEvents)) {
      // Metadata-only refresh: preserve active selection, an opened worker report,
      // text selection and scroll position without rerendering up to 160 records.
      const position = body.scrollTop;
      body.querySelector(':scope > .agent-panel-read-notice')?.remove();
      body.scrollTop = position;
      if (retryHadFocus) body.querySelector<HTMLButtonElement>(':scope > button')?.focus({ preventScroll: true });
      return;
    }
    const focused = document.activeElement;
    const focusedInBody = !!focused && body.contains(focused);
    const disclosures = new Map<string, { opened: boolean; focusedSummary: boolean }>();
    for (const disclosure of body.querySelectorAll<HTMLDetailsElement>('details')) {
      const key = disclosure.closest<HTMLElement>('[data-timeline-key]')?.dataset.timelineKey;
      const label = disclosure.querySelector(':scope > summary')?.textContent;
      if (key && label) disclosures.set(`${key}:summary:${label}`, {
        opened: disclosure.open, focusedSummary: focused === disclosure.querySelector(':scope > summary')
      });
    }
    const openMain = fullChatButton(id);
    const position = body.scrollTop;
    const follow = !preserve || position + body.clientHeight >= body.scrollHeight - 40;
    const rendered = options.render(detail.events, id, current);
    let restoreFocus: HTMLElement | null = null;
    for (const row of rendered) for (const disclosure of row.matches('details') ? [row] : row.querySelectorAll('details')) {
      const details = disclosure as HTMLDetailsElement;
      const key = details.closest<HTMLElement>('[data-timeline-key]')?.dataset.timelineKey;
      const label = details.querySelector(':scope > summary')?.textContent;
      const previous = key && label ? disclosures.get(`${key}:summary:${label}`) : null;
      if (previous) {
        details.open = previous.opened;
        if (previous.focusedSummary) restoreFocus = details.querySelector<HTMLElement>(':scope > summary');
      }
    }
    body.replaceChildren(openMain, ...rendered);
    renderedWorker = id;
    renderedEvents = nextEvents;
    body.scrollTop = follow ? body.scrollHeight : position;
    if (restoreFocus) restoreFocus.focus({ preventScroll: true });
    else if (focusedInBody) openMain.focus({ preventScroll: true });
  }
  back.onclick = list; close.onclick = hide;
  pane.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); hide(); options.toggle.focus();
  });
  options.toggle.onclick = () => { if (pane.hidden) { show(); list(); } else hide(); };
  return {
    open,
    update(id: string | null, next: SessionSummary[]): void {
      if (parent !== id) { hide(); parent = id; }
      const previous = workers.find(worker => worker.id === selected);
      workers = next; options.toggle.hidden = id === null;
      ui(options.toggle, 'title', () => t("Sub-agents · {0} recorded", [workers.length]));
      if (pane.hidden) return;
      const latest = workers.find(worker => worker.id === selected);
      if (!selected || !latest) list();
      else if (latest.updatedAt !== previous?.updatedAt) void open(latest.id, true);
    }
  };
}

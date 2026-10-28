/**
 * The desktop window's layout contract.
 *
 * The window has a preferred size and a fixed set of controls, so a control going missing
 * at that size or after a supported resize is a layout failure rather than a styling opinion. On the installed build
 * the session card's header held the title, a three-way view switcher and three buttons in
 * one flex row, and at the window's own default width "Compact & resume" — the primary
 * action of the whole app — was pushed entirely off the right edge. Not clipped: absent.
 *
 * jsdom does no layout, so this cannot measure pixels. What it can do is hold the
 * structural rules that made the overflow possible in the first place: the actions cluster
 * must not be allowed to shrink, the title must be the thing that yields, navigation must
 * not compete with actions for the same row, and nothing anywhere may scroll sideways.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';
import { filterSettingsSections } from '../src/renderer/dom.js';
import { sessionLastWorkedAt, sessionWorkingAt } from '../src/shared/session-activity.js';
import { CHAT_ACTIVE_MS, type SessionSummary } from '../src/shared/session.js';

let document: Document;
let css = '';
let chatSource = '';
let mainSource = '';
let browserPreferencesSource = '';

beforeAll(async () => {
  browserPreferencesSource = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'browser-preferences.ts'), 'utf8');
  const [html, styles, chat, main] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'chat.ts'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'main.ts'), 'utf8')
  ]);
  document = new JSDOM(html).window.document;
  css = styles;
  chatSource = chat;
  mainSource = main;
});

it('shows full companion mode hold reasons in narrow menus rather than cutting off recovery instructions', async () => {
  const extensionCss = await fs.readFile(path.join(process.cwd(), 'extension', 'overlay.css'), 'utf8');
  const modeNote = extensionCss.match(/\.clf-menu-mode-note\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(modeNote).toMatch(/white-space:\s*normal\s*;/);
  expect(modeNote).toMatch(/overflow-wrap:\s*anywhere\s*;/);
  expect(modeNote).not.toMatch(/text-overflow:\s*ellipsis/);
});

it('keeps companion waiting visibly distinct from native work and bounds status hints on narrow pages', async () => {
  const extensionCss = await fs.readFile(path.join(process.cwd(), 'extension', 'overlay.css'), 'utf8');
  const spinnerBusy = extensionCss.match(/\.clf-composer\[data-clf-mode='busy'\] \.clf-spinner\s*\{([^}]*)\}/)?.[1] ?? '';
  const spinnerWaiting = extensionCss.match(/\.clf-composer\[data-clf-mode='waiting'\] \.clf-spinner\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(spinnerBusy).toMatch(/display:\s*inline-block/);
  expect(spinnerWaiting).toMatch(/display:\s*inline-block/);
  expect(spinnerWaiting).toMatch(/animation:\s*none/);
  const reducedMotion = extensionCss.match(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.clf-spinner\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(reducedMotion).toMatch(/animation:\s*none/);
  const menu = extensionCss.match(/\.clf-menu\s*\{\s*position:\s*fixed;([^}]*)\}/)?.[1] ?? '';
  expect(menu).toMatch(/max-width:\s*min\(22rem,\s*calc\(100vw - 16px\)\)/);
  const hint = extensionCss.match(/\.clf-tip\s*\{\s*position:\s*fixed;([^}]*)\}/)?.[1] ?? '';
  expect(hint).toMatch(/max-width:\s*min\(22rem,\s*calc\(100vw - 16px\)\)/);
  const wrapped = extensionCss.match(/\.clf-tip\[data-clf-tip-wrap='1'\]\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(wrapped).toMatch(/overflow-wrap:\s*anywhere/);
});

it('does not animate an uncertain Goal/Loop wait like a verified active helper stage', async () => {
  const extensionCss = await fs.readFile(path.join(process.cwd(), 'extension', 'overlay.css'), 'utf8');
  const ordinary = extensionCss.match(/\.clf-stage-step\[data-clf-step='now'\] \.clf-stage-track::after\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(ordinary).toMatch(/animation:\s*clf-stage-run/);
  // Existing content.js uses an elapsed timer ONLY for a genuinely active
  // Goal draft/Send stage; an evidence/Chrome/reply wait has no startedAt.
  const uncertain = extensionCss.match(
    /\.clf-stage\[data-clf-stage-kind='goal'\]:has\(\.clf-stage-timer\[hidden\]\) \.clf-stage-step\[data-clf-step='now'\] \.clf-stage-track::after\s*\{([^}]*)\}/
  )?.[1] ?? '';
  expect(uncertain).toMatch(/display:\s*none/);
  expect(uncertain).toMatch(/animation:\s*none/);
});

it('keeps the compact companion status and cancel control usable at narrow widths and with keyboard focus', async () => {
  const extensionCss = await fs.readFile(path.join(process.cwd(), 'extension', 'overlay.css'), 'utf8');
  const pill = extensionCss.match(/\.clf-pill\s*\{([^}]*)\}/)?.[1] ?? '';
  const cancelFocus = extensionCss.match(/\.clf-cancel:focus-visible\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(pill).toMatch(/min-width:\s*0/);
  expect(pill).toMatch(/max-width:\s*min\(15rem,\s*calc\(100vw - 16px\)\)/);
  expect(cancelFocus).toMatch(/outline:\s*2px solid/);
  expect(cancelFocus).toMatch(/outline-offset:\s*2px/);
  expect(cancelFocus).toMatch(/opacity:\s*1/);
});

it('shows a readable, independently scrolling Work detail at narrow 150% and 200% zoom', async () => {
  const responsive = css.match(/@media \(max-width: 700px\)\s*\{\s*\.work-overview-pane:not\(\[hidden\]\)\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(responsive).toContain('position: fixed');
  expect(responsive).toMatch(/inset:\s*54px 12px 12px/);
  expect(responsive).toContain('overflow: hidden auto');
  expect(responsive).toContain('overscroll-behavior: contain');
  expect(responsive).toContain('max-height: none');
  expect(responsive).toContain('background: var(--card)');
  expect(rule('.work-overview-pane[hidden]')).toContain('display: none');
  expect(rule('.work-overview-pane-head strong')).toContain('overflow-wrap: anywhere');
  const chat = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'chat.ts'), 'utf8');
  expect(chat).toContain("window.matchMedia('(max-width: 700px)')");
  expect(chat).toContain("querySelector<HTMLButtonElement>('button[data-work-action=\"close\"]')");
});

it('gives the opened desktop Work detail a readable viewport-bound inspector instead of a cramped sidebar cell', async () => {
  const desktop = css.match(/@media \(min-width: 1000px\)\s*\{\s*\.work-overview-pane:not\(\[hidden\]\)\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(desktop).toMatch(/position:\s*fixed/);
  expect(desktop).toMatch(/width:\s*min\(560px/);
  expect(desktop).toMatch(/overflow:\s*hidden auto/);
  expect(desktop).toMatch(/background:\s*var\(--card\)/);
  expect(desktop).toMatch(/overscroll-behavior:\s*contain/);
  expect(desktop).toMatch(/z-index:\s*120/);
  expect(rule('.work-overview-pane[hidden]')).toContain('display: none');
});

it('preserves readable Work details at intermediate windows and 150% zoom without horizontal clipping', () => {
  const intermediate = css.match(/@media \(min-width: 701px\) and \(max-width: 999px\)\s*\{\s*\.work-overview-pane:not\(\[hidden\]\)\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(intermediate).toMatch(/position:\s*fixed/);
  expect(intermediate).toMatch(/inset:\s*54px 14px 14px/);
  expect(intermediate).toMatch(/overflow:\s*hidden auto/);
  expect(intermediate).toMatch(/overscroll-behavior:\s*contain/);
  expect(intermediate).toMatch(/background:\s*var\(--card\)/);
  expect(intermediate).toMatch(/z-index:\s*120/);
});

it('keeps worker-result recovery readable with keyboard focus at narrow and zoomed widths', () => {
  const notice = rule('.agent-panel-read-notice');
  const text = rule('.agent-panel-read-notice > p');
  const focus = rule('.agent-panel-read-notice .btn:focus-visible');
  const headTitle = rule('.agent-panel-header strong');
  expect(notice).toContain('min-width: 0');
  expect(notice).toContain('flex-wrap: wrap');
  expect(notice).toContain('overflow-wrap: anywhere');
  expect(text).toContain('min-width: 0');
  expect(text).toContain('flex: 1 1');
  expect(focus).toContain('outline: 2px solid');
  expect(headTitle).toContain('overflow-wrap: anywhere');
  expect(headTitle).not.toContain('white-space: nowrap');
  expect(css).toMatch(/@media \(max-width: 540px\)\s*\{\s*\.agent-panel-body\s*\{\s*padding:/);
});

it('gives saved tool results the same bounded text and visible keyboard focus as retained answers', () => {
  // The previous-turn saved output now shares these deliberate rules.
  const toolStyle = rule('.work-overview-historical-worker-result, .work-overview-previous-result, .work-overview-tool-result');
  const focusStyle = rule('.work-overview-historical-worker-result > summary:focus-visible, .work-overview-previous-result > summary:focus-visible, .work-overview-tool-result > summary:focus-visible');
  const toolBody = rule('.work-overview-result-body');
  const expandFocus = rule('.work-overview-reveal:focus-visible');
  expect(toolStyle).toContain('min-width: 0');
  expect(toolStyle).toContain('border-top: 1px solid');
  expect(focusStyle).toContain('outline: 2px solid');
  expect(toolBody).toContain('overflow: auto');
  expect(toolBody).toContain('overflow-wrap: anywhere');
  expect(expandFocus).toContain('outline: 2px solid');
});

it('retains explicit keyboard focus on companion Goal, account, and selection controls', async () => {
  const extensionCss = await fs.readFile(path.join(process.cwd(), 'extension', 'overlay.css'), 'utf8');
  const controls = extensionCss.match(/\.clf-menu-goal-buttons button:focus-visible,\s*\.clf-menu-account-buttons button:focus-visible,\s*\.clf-menu-account-select:focus-visible\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(controls).toMatch(/outline:\s*2px solid/);
  expect(controls).toMatch(/outline-offset:\s*1px/);
});

it('keeps the dark-theme companion Goal Save text readable on both its normal and hover backgrounds', async () => {
  const extensionCss = await fs.readFile(path.join(process.cwd(), 'extension', 'overlay.css'), 'utf8');
  const save = extensionCss.match(/\.clf-menu-goal-buttons \.clf-menu-goal-save\s*\{([^}]*)\}/)?.[1] ?? '';
  const hover = extensionCss.match(/\.clf-menu-goal-save:hover:not\(:disabled\)\s*\{([^}]*)\}/)?.[1] ?? '';
  const ink = /color:\s*(#[0-9a-f]{6})\s*;/.exec(save)?.[1];
  const surface = /background:\s*(#[0-9a-f]{6})\s*!important/.exec(save)?.[1];
  const hoverSurface = /background:\s*(#[0-9a-f]{6})\s*!important/.exec(hover)?.[1];
  expect([ink, surface, hoverSurface].every(Boolean)).toBe(true);
  const luminance = (hex: string): number => {
    const channels = hex.slice(1).match(/../g)!.map((part) => parseInt(part, 16) / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const contrast = (first: string, second: string): number => {
    const a = luminance(first), b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  expect(contrast(ink!, surface!)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(ink!, hoverSurface!)).toBeGreaterThanOrEqual(4.5);
});

it('searches whole settings sections without empty headings, orphaned controls or lost conditional visibility', () => {
  const view = document.querySelector<HTMLElement>('[data-view="settings"]')!;
  const sections = [...view.querySelectorAll<HTMLElement>('.settings-section-title')];
  const conditional = document.getElementById('goalModels')!;
  expect(conditional.hidden).toBe(true);
  filterSettingsSections(view, '  SESSION FINISH  ');
  expect(sections.filter(section => !section.hidden).map(section => section.textContent)).toEqual(['Keep the turn open']);
  for (const section of sections) expect((section.nextElementSibling as HTMLElement).hidden).toBe(section.hidden);
  expect(document.getElementById('finishAction')!.closest('.pane')!.hasAttribute('hidden')).toBe(false);
  expect(document.getElementById('goalKey')!.closest('.pane')!.hasAttribute('hidden')).toBe(true);
  filterSettingsSections(view, 'no-such-setting-123');
  expect(sections.every(section => section.hidden)).toBe(true);
  expect(document.getElementById('settingsSearchEmpty')!.hidden).toBe(false);
  filterSettingsSections(view, '');
  expect(sections.every(section => !section.hidden && !(section.nextElementSibling as HTMLElement).hidden)).toBe(true);
  expect(conditional.hidden).toBe(true);
  expect(document.getElementById('settingsSearchEmpty')!.hidden).toBe(true);
});

it('limits the existing tool-detail preference to handoff briefs', () => {
  const toggle = document.getElementById('goalIncludeToolCalls') as HTMLInputElement;
  expect(toggle.type).toBe('checkbox');
  expect(toggle.checked).toBe(false);
  expect(toggle.closest('label')?.textContent).toContain('Include tool details in handoffs');
  expect(toggle.closest('label')?.textContent).toContain('Goal and Loop use user messages and assistant updates and answers');
  expect(chatSource).toContain("includeToolCalls: $<HTMLInputElement>('goalIncludeToolCalls').checked");
  expect(chatSource).toContain("applyChatChecked($<HTMLInputElement>('goalIncludeToolCalls')");
});

it('labels and saves the account-local Loop readiness policy without claiming unverified results are complete', () => {
  const control = document.getElementById('loopContinuationPolicy') as HTMLSelectElement;
  expect(control).not.toBeNull();
  expect(document.querySelector('label[for="loopContinuationPolicy"]')?.textContent).toContain('Loop continuation');
  expect([...control.options].map(option => option.value)).toEqual(['strict', 'settled-turn']);
  expect(control.getAttribute('aria-describedby')).toBe('loopContinuationPolicyHint');
  expect(document.getElementById('loopContinuationPolicyHint')?.textContent).toContain('Unverified');
  expect(document.getElementById('loopContinuationPolicyHint')?.textContent).toContain('approvals');
  expect(chatSource).toContain("continuationPolicy: $<HTMLSelectElement>('loopContinuationPolicy').value");
  expect(chatSource).toContain("applyChatValue($<HTMLSelectElement>('loopContinuationPolicy')");
});

it('gives the Activity panel a page title instead of relying on the log card label alone', () => {
  const activity = document.querySelector<HTMLElement>('[data-panel="activity"]')!;
  const heading = activity.querySelector('.settings-heading')!;
  expect(heading.querySelector('h1')?.textContent).toBe('Activity');
  expect(heading.querySelector('p')?.textContent).toBe('Recent local events and failures.');
  expect(activity.querySelector('.card h2')?.textContent).toContain('Activity');
});

it('keeps the context circle in the gear group rather than an auto-placed composer grid cell', () => {
  const group = document.getElementById('composerSettings')!.parentElement!;
  expect(group.classList.contains('composer-options')).toBe(true);
  expect(document.getElementById('contextMeter')!.parentElement).toBe(group);
  expect(document.getElementById('contextMeterInfo')!.parentElement?.id).toBe('contextMeter');
});

it('does not expose a periodic Astra continuation outside session_finish', () => {
  expect(document.getElementById('goalImpulseMinutes')).toBeNull();
  expect(chatSource).not.toContain("number('goalImpulseMinutes'");
});

/** The declarations of one selector, whitespace-normalised. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1]!.replace(/\s+/g, ' ').trim() : '';
}

describe('narrow Work and Progress evidence', () => {
  it('wraps long exact-helper hold explanations inside Work attention without horizontal clipping at high zoom', () => {
    const field = rule('.work-overview-pane-field');
    const content = rule('.work-overview-pane-field > span');
    const attention = rule('.work-overview-pane-field.is-work-attention > span');
    const pane = rule('.work-overview-pane');
    const actions = rule('.work-overview-pane-actions');
    expect(field).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(content).toContain('min-width: 0');
    expect(content).toContain('overflow-wrap: anywhere');
    expect(attention).toContain('white-space: pre-line');
    expect(pane).toContain('min-width: 0');
    expect(actions).toContain('flex-wrap: wrap');
    expect(chatSource).toContain("'Helper retry budget exhausted'");
  });

it('keeps previous-turn result disclosure inside the same Work detail and provides a visible keyboard focus target', () => {
    const saved = rule('.work-overview-historical-worker-result, .work-overview-previous-result, .work-overview-tool-result');
    const summary = rule('.work-overview-historical-worker-result > summary, .work-overview-previous-result > summary, .work-overview-tool-result > summary');
    const focus = rule('.work-overview-historical-worker-result > summary:focus-visible, .work-overview-previous-result > summary:focus-visible, .work-overview-tool-result > summary:focus-visible');
    expect(saved).toContain('min-width: 0');
    expect(summary).toContain('overflow-wrap: anywhere');
    expect(focus).toContain('outline: 2px solid var(--ink)');
    expect(chatSource).toContain("toggle.dataset.workAction = 'previous-result'");
    expect(chatSource).toContain("'previous'");
  });

  it('keeps long localized Work timestamps and retained-result actions inside the disclosure', () => {
    const history = rule('.work-overview-history li');
    const time = rule('.work-overview-history time');
    const actions = rule('.work-overview-pane-actions');
    const action = rule('.work-overview-pane-actions .btn');
    expect(history).toMatch(/grid-template-columns:\s*minmax\(0,\s*65px\)\s+minmax\(0,\s*1fr\)/);
    expect(time).toContain('white-space: normal');
    expect(time).toContain('overflow-wrap: anywhere');
    expect(actions).toContain('flex-wrap: wrap');
    expect(action).toContain('max-width: 100%');
  });

  it('allows Work counts and Progress timestamps/status to wrap at high zoom', () => {
    const workCounts = rule('.work-overview-meta');
    const evidenceTime = rule('.progress-evidence time');
    const status = rule('.progress-state');
    expect(workCounts).toContain('min-width: 0');
    expect(workCounts).toContain('white-space: normal');
    expect(workCounts).toContain('overflow-wrap: anywhere');
    expect(evidenceTime).toContain('min-width: 0');
    expect(evidenceTime).toContain('overflow-wrap: anywhere');
    expect(status).toContain('max-width: 100%');
    expect(status).toContain('overflow-wrap: anywhere');
  });
});

it('keeps the explicit earlier-result read action beside its explanation rather than after long result disclosures', () => {
  const quick = rule('.work-overview-previous-lookup-actions');
  expect(quick).toContain('justify-content: flex-start');
  const button = rule('.work-overview-previous-lookup-actions .btn');
  const focus = rule('.work-overview-previous-lookup-actions .btn:focus-visible');
  expect(button).toContain('color: var(--ink)');
  expect(button).toContain('background: var(--wash)');
  expect(button).toContain('border: 1px solid var(--line)');
  expect(focus).toContain('outline: 2px solid var(--ink)');
  expect(chatSource).toContain("el('div', 'work-overview-pane-actions work-overview-previous-lookup-actions')");
  expect(chatSource).toContain('lookupNodes.push(previousTool)');
  expect(chatSource).toContain('...(canFindPrevious || canFindPreviousTool ? [lookupActions] : [])');
});

describe('the session card header', () => {
  it('indents rendered project tasks once and gives worker children their additional depth', () => {
    expect(rule('.project-group > .sess, .project-group > .worker-group')).toContain('margin-inline-start: 24px');
    expect(rule('.worker-group')).toContain('padding-left: 16px');
    expect(css).not.toContain('.project-group .session-row');
  });
  /**
   * A gear, and nothing that starts work. Compact & resume is pressed in the ChatGPT tab,
   * because the chat is what writes the brief — a button here would be a second way to
   * start the one thing that must happen exactly once.
   */
  it('keeps chat controls in the composer and moves the one connection control to the sidebar footer', () => {
    const header = document.querySelector('#chatTitle')!.closest('header')!;
    expect(header.contains(document.getElementById('live'))).toBe(false);
    expect(document.getElementById('live')!.closest('.sidebar-bottom')).not.toBeNull();
    expect(document.getElementById('connectBtn')!.closest('.sidebar-bottom')).not.toBeNull();
    expect(document.getElementById('sessionControls')!.closest('#composerSettings')).not.toBeNull();
    expect(header.querySelector('.session-controls')).toBeNull();
  });

  /**
   * Settings is not a view of the session the way the timeline and the compaction are;
   * it is app configuration reached from the session. It belongs on the gear.
   */
  it('reaches settings from the gear rather than from the view switcher', () => {
    const views = [...document.getElementById('chatView')!.querySelectorAll('[data-view]')].map(
      (button) => (button as HTMLElement).dataset.view
    );
    expect(views).toEqual(['timeline', 'compact']);
    // The view itself still exists — only its entry point moved.
    expect(document.querySelector('#chatBody > .view[data-view="settings"]')).not.toBeNull();
  });

  /**
   * The switcher is navigation, not an action. Sharing the row with three buttons is what
   * made the row wider than the window; giving it its own is what makes the fit provable
   * rather than a matter of how long the session title happens to be.
   */
  it('keeps legacy view navigation hidden outside the header', () => {
    const header = document.querySelector('#chatTitle')!.closest('header')!;
    const view = document.getElementById('chatView')!;
    expect(header.contains(view)).toBe(false);
    expect(view.hidden).toBe(true);
  });

  it('lets the title shrink and never the actions', () => {
    expect(rule('.acts')).toContain('flex: none');
    const title = rule('#chatTitle');
    expect(title).toContain('min-width: 0');
    expect(title).toContain('text-overflow: ellipsis');
    // The title is the first child of the header, which is what that selector relies on.
    expect(document.querySelector('#chatTitle')!.closest('header')!.firstElementChild!.id).toBe('chatTitle');
  });

  it('has a place to say what is happening without opening the Activity log', () => {
    const note = document.getElementById('chatState')!;
    expect(note.closest('.subhead')).not.toBeNull();
    expect(rule('.subhead-note')).toContain('text-overflow: ellipsis');
  });
});

/**
 * The session list is the one surface where rows are near-identical by construction: a
 * resume and its workers are all opened within a minute of each other. Which run a row
 * belongs to, and whether its tab ever opened, are carried by chips — so the chips are
 * the part that must survive a narrow row, and the counts are the part that yields.
 */
describe('a session row', () => {
  it('keeps one compact automation supervisor above the list with an explicit safe recovery action', () => {
    const supervisor = document.getElementById('automationSupervisor')!;
    expect(supervisor.contains(document.getElementById('automationProfile'))).toBe(true);
    expect(supervisor.contains(document.getElementById('recoverStaleAutomation'))).toBe(true);
    expect([...((document.getElementById('automationProfile') as HTMLSelectElement).options)]
      .map(option => option.value)).toEqual(['day', 'overnight', 'rotation']);
    expect(document.getElementById('recoverStaleAutomation')!.getAttribute('title')).toContain('without resending');
    expect(rule('.automation-supervisor')).toContain('border: 1px solid var(--line)');
    expect(rule('.sess-automation-state')).toContain('flex: 0 1 auto');
  });

  it('keeps status visible and lets the title truncate', () => {
    expect(rule('.sess-top')).toContain('display: flex');
    expect(rule('.sess-main')).toContain('flex-direction: column');
    expect(rule('.sess-meta')).toContain('overflow: hidden');
    expect(rule('.session-status')).toContain('flex: none');
    const bits = rule('.sess-top b');
    expect(bits).toContain('min-width: 0');
    expect(bits).toContain('text-overflow: ellipsis');
  });

  it('keeps secondary conversation actions in one accessible overflow menu', () => {
    const menu = document.getElementById('conversationActionsMenu')!;
    expect(menu.tagName).toBe('DETAILS');
    for (const id of ['retryPausedHelpers', 'freshCopyAutomation', 'emptyTrash', 'chatRefresh']) {
      expect(menu.contains(document.getElementById(id))).toBe(true);
    }
    expect(rule('.conversation-actions-popover')).toContain('position: absolute');
  });

  it('never borrows live worker status from a different run that reused worker-1/worker-2', () => {
    // Worker ids are slot names and repeat every run. The conversation is the durable chat
    // identity, so both have to match before an old recorded session can show the current
    // swarm's `active` / `finished` badge. This pins the screenshot regression where several
    // old worker-2 rows all suddenly said `active` when one new worker-2 was active.
    expect(chatSource).toMatch(/entry\.id === workerId[\s\S]{0,220}entry\.conversationId === summary\.conversationId/);
  });

  it('does not call an idle prime active merely because it still owns the run', () => {
    expect(chatSource).toMatch(/else if \(agent && agent\.role !== 'prime'\)/);
    // Idle means idle: generic recording traffic cannot renew the exact tool clock.
    const summary = { startedAt: 100, lastToolCallAt: 200, lastAssistantFinalAt: 300,
      lastTurnEndAt: 300, updatedAt: 400, activeTurnId: 'old-open-turn', agents: ['prime'],
      endedAt: null, origin: null } as SessionSummary;
    expect(sessionWorkingAt(summary, 400)).toBe(false);
    expect(sessionWorkingAt({ ...summary, lastToolCallAt: 350 }, 400)).toBe(true);
  });

  /**
   * A page that lost its answer stream has no open turn while the model behind it goes on
   * calling tools for minutes. Keying the badge on the open turn alone showed that chat - the
   * one a user most wants to see is still going - as idle.
   */
  it('uses session start and exact calls rather than reload-generated turn boundaries for visible activity', () => {
    const summary = { startedAt: 100, lastToolCallAt: null, endedAt: null, origin: null,
      activeTurnId: 'reload-turn', updatedAt: 100 + CHAT_ACTIVE_MS } as SessionSummary;
    expect(sessionWorkingAt(summary, 101)).toBe(true);
    expect(sessionWorkingAt(summary, 101 + CHAT_ACTIVE_MS)).toBe(false);
    expect(sessionWorkingAt({ ...summary, activityExpiresAt: 100 + 10 * 60_000 }, 101 + CHAT_ACTIVE_MS)).toBe(true);
    expect(sessionWorkingAt({ ...summary, activityExpiresAt: null }, 101)).toBe(false);
    expect(chatSource).toMatch(/else if \(!agent && workerId && typeof summary\.lastFinishReportAt === 'number' &&\s+summary\.lastFinishReportAt >= \(summary\.lastToolCallAt \?\? 0\)\) badges\.push\(AGENT_BADGE\.sleeping\)/);
    expect(chatSource).toMatch(/else if \(!automation && !workerId && sessionWorking\(summary\)\) badges\.push\(\{ text: 'recent', tone: '' \}\)/);
    expect(rule('.session-status.is-recovering')).not.toContain('animation:');
    expect(chatSource).toMatch(/scheduleToolActivityExpiry/);
  });

  it('lets a worker finish report override its still-recent finish tool call', () => {
    expect(chatSource).toMatch(/\['sleeping', 'finished', 'failed'\]\.includes\(agent\.state\)/);
    expect(chatSource).toMatch(/if \(workerStopped\) badges\.push\(AGENT_BADGE\[agent\.state\]\)/);
  });

  it('explains on hover whether activity is observed, waiting, or idle', () => {
    expect(chatSource).toContain('Recent turn or tool activity; current execution unverified');
    expect(chatSource).toContain('Waiting — the turn is open but no recent work signal was detected');
    expect(chatSource).toContain('Idle — no current turn or recent tool activity');
    expect(chatSource).toMatch(/sessionActivityHint\(summary, badges, automation\)/);
  });

  it('shows a live last-work age from meaningful activity rather than bookkeeping refreshes', () => {
    const summary = { startedAt: 100, lastMessageAt: 200, lastToolCallAt: 300,
      lastAssistantFinalAt: 400, lastTurnEndAt: 500, updatedAt: 9_999,
      endedAt: null, origin: null } as SessionSummary;
    expect(sessionLastWorkedAt(summary)).toBe(500);
    expect(rule('.sess-last-work')).toContain('font-variant-numeric: tabular-nums');
  });

  it('separates waiting for sub-agents from waiting for the main chat', () => {
    expect(chatSource).toContain('Waiting for workers · {0} still running');
    expect(chatSource).toContain('Waiting for the main chat to continue');
    expect(chatSource).toContain('sess-worker-summary');
    expect(chatSource).toContain('workerProgressBySession.get(summary.id)');
    expect(chatSource).toContain('workerProgress.failed > 0');
    expect(chatSource).toContain('workerLifecycleText(workerProgress)');
    expect(chatSource).toMatch(/WORKER_WAIT_STATES\.has\(agent\.state\)/);
    expect(chatSource).toMatch(/agent\.primeConversationId === selected\.conversationId/);
  });
});

describe('the session-row chat actions', () => {
  it('keeps current-chat pressure in the conversation detail', () => {
    expect(chatSource).toContain('compactNumber(summary.contextTokens)');
    expect(chatSource).toContain('rough current-chat context tokens');
  });

  it('keeps row actions in normal layout instead of laying the timestamp underneath them', () => {
    expect(rule('.sess-action')).not.toContain('position: absolute');
    expect(rule('.sess-actions')).toContain('flex: none');
  });

  it('keeps one row menu trigger and puts nickname/open/link actions in the existing context menu', () => {
    expect(chatSource).toContain("more.className = 'btn sess-action sess-more'");
    expect(chatSource).toContain("t('Add or edit chat nickname')");
    expect(chatSource).toContain("t('Copy ChatGPT link')");
    expect(chatSource).toMatch(/async function openSessionInChrome[\s\S]{0,500}api\.openSessionChat\(id/);
    expect(chatSource).not.toContain("className = 'btn sess-action sess-del'");
    expect(chatSource).not.toContain('sess-action sess-block');
  });

  it('keeps a block visible without hovering, because it is state and not just an action', () => {
    expect(rule('.session-status.is-failed')).toContain('background: var(--red)');
    expect(chatSource).toContain("ui(indicator, 'aria-label', () => t(status.text))");
  });

  it('keeps Unattributed policy read-only in the row and out of selected-chat actions', () => {
    expect(chatSource).toContain('if (row.conversationId)');
    expect(chatSource).not.toContain('toggleUnattributedBlock');
    expect(chatSource).toMatch(/unattributedBlocked\(\)[\s\S]{0,200}allowUnattributedCalls === false/);
    expect(chatSource).toMatch(/unattributedBlocked\(\)[\s\S]{0,120}text: 'blocked', tone: 'is-failed'/);
    expect(chatSource).toContain('selection includes Unattributed activity');
  });
});

describe('the live worker list', () => {
  it('shows the exact broker id instead of a generic worker role chip', () => {
    expect(chatSource).toMatch(/if \(label !== agent\.id\)[^\n]*agent\.id/);
    expect(chatSource).not.toContain("el('span', 'chip', agent.role)");
  });
});

/**
 * Every card in this app is a grid with an explicit row for each of its children. The
 * Sessions card has three children; the session card has four, because it also carries a
 * navigation row. They shared one three-track template, so on the session card the tracks
 * landed on the wrong children: `.subhead` took the flexible `1fr` track and floated the
 * view switcher into the vertical middle of an empty card, while `.scroll` fell into an
 * implicit `auto` row sized to its whole content and painted the timeline over the header.
 *
 * jsdom does no layout, so this counts tracks against children instead of pixels. That is
 * the invariant that was actually violated, and it is checkable.
 */
describe('the chat panel cards', () => {
  /** The track list a card's own rule declares, as an array. */
  function tracks(selector: string): string[] {
    const declarations = rule(selector);
    const match = /grid-template-rows:([^;]*)/.exec(declarations);
    expect(match, `${selector} declares no grid-template-rows`).not.toBeNull();
    // minmax(0, 1fr) is one track despite its comma.
    return match![1]!.trim().replace(/minmax\([^)]*\)/g, 'minmax').split(/\s+/);
  }

  it('keeps conversations in the persistent sidebar outside the chat canvas', () => {
    const list = document.getElementById('sessionList')!;
    expect(list.closest('.sidebar')).not.toBeNull();
    expect(list.closest('[data-panel]')).toBeNull();
  });

  it('gives the session card one row per child, including its navigation row', () => {
    const card = document.getElementById('chatBody')!.closest('.card')!;
    // Subhead, scrolling conversation, shared plan/queue dock, composer and footer.
    const layoutChildren = [...card.children].filter(child => child.id !== 'chatSettingsBtn');
    expect(layoutChildren.length).toBe(5);
    expect(document.getElementById('composerDock')!.firstElementChild?.id).toBe('agentPlan');
    expect(document.getElementById('inputQueue')!.closest('#chatBody')).not.toBeNull();
    expect(card.classList.contains('is-session')).toBe(true);
    expect(tracks("[data-panel='chat'] .card.is-session")).toHaveLength(layoutChildren.length);
  });

  /**
   * The flexible track must be the scrolling body and nothing else. When it landed on
   * `.subhead`, an empty Compaction view pushed the switcher into the middle of the card.
   */
  it('gives the flexible track to the body, not to the navigation row', () => {
    const card = document.getElementById('chatBody')!.closest('.card')!;
    const bodyIndex = [...card.children].filter(child => child.id !== 'chatSettingsBtn').indexOf(document.getElementById('chatBody')!);
    expect(bodyIndex).toBeGreaterThan(-1);
    const list = tracks("[data-panel='chat'] .card.is-session");
    expect(list[bodyIndex]).toBe('minmax');
    expect(list.filter((track) => track === 'minmax')).toHaveLength(1);
  });
});

/**
 * A recorded tool call is a `<details>`. A `<details>` whose `display` is changed stops
 * stacking its summary above its body and lays the two out as siblings — which is how the
 * arguments/result panel came to sit beside the row, pinned to the right edge of the card
 * and clipped. A bare `.tool` rule for the permission checkboxes was matching it.
 */
describe('an expanded tool call', () => {
  it('opens underneath its row rather than beside it', () => {
    expect(rule('.tool')).toContain('display: block');
  });

  it('does not share a selector with the permission checkboxes', () => {
    // The permission row is a `<label class="tool">` laid out in two columns, a checkbox
    // and its text. Scoping that to its container is what keeps the row's own `display`
    // off the timeline's `<details class="tool">`, whichever layout the row uses.
    expect(css).toMatch(/\n\.tools \.tool \{[^}]*display: grid/);
    expect(rule('.tool')).toContain('display: block');
  });
});

/**
 * Every recorded event kind has a row.
 *
 * `eventBody` ends in a `default` arm that renders the words "Unknown event", so a kind
 * added to the recorder and not to the renderer does not fail a build or a type check —
 * it ships, and shows the user grey placeholder rows in their own timeline. That is how
 * `agent_message` came to be unrendered: it was added to the union, written by the
 * recorder, and read by nothing in the renderer.
 *
 * Checked against the union in the shared types rather than a hand-kept list here, so the
 * next kind is covered the moment it is declared.
 */
describe('the settings sheet', () => {
  /**
   * Three rows, and each one is a label, a number, a unit and — where it has one — a
   * switch, side by side. The sheet shipped broken once: `.num` sets the field's width,
   * but the shared `input[type='number']` rule sets `width: 100%`, and a bare class loses
   * that specificity tie. The field stretched across the whole row, squeezed the label to
   * a couple of characters, and pushed the unit and the switch out of the window.
   */
  it('gives the number field a width the shared input rule cannot beat', () => {
    expect(rule('input.num')).toContain('width: 92px');
    expect(rule('.num')).toBe('');
    expect(css.indexOf('input.num {')).toBeGreaterThan(css.indexOf("input[type='number'],"));
  });

  /**
   * The pane's column is capped, not content-sized. A grid with no explicit column gets an
   * implicit `auto` track, and an `auto` track is floored by the widest child's min-content
   * width — which for these rows is the whole of a `white-space: nowrap` hint. Measured in
   * Electron at the window's own 1080px: the track came out 724px inside a 674px content
   * box, so every row overhung by 50px and the card, which clips rather than scrolls
   * sideways, simply ate the switches, the units and the end of "Select model".
   */
  it('caps the settings column instead of letting the widest row size it', () => {
    const pane = rule('.pane');
    expect(pane).toContain('display: grid');
    expect(pane).toContain('grid-template-columns: minmax(0, 1fr)');
  });

  /**
   * A dropdown in a settings row is as wide as its longest option, not as wide as the row.
   * `select` shares the `width: 100%` rule written for the stacked fields in `.field`, and
   * inherited into a flex row that made a five-word menu a 708px control with "Reasoning"
   * squeezed to nothing beside it.
   */
  it('keeps a settings row dropdown at its own width', () => {
    const select = rule('.setting select');
    expect(select).toContain('width: auto');
    expect(select).toContain('flex: 0 0 auto');
    // Same specificity trap as input.num: the shared rule has to come first to lose.
    expect(css.indexOf('.setting select {')).toBeGreaterThan(css.indexOf("input[type='number'],"));
  });

  /** The row's action never shrinks; its explanation is the thing that ellipsizes. */
  it('never shrinks the button in a settings row', () => {
    expect(rule('.setting .btn')).toContain('flex: 0 0 auto');
    expect(rule('.setting-text em')).toContain('white-space: normal');
  });

  it('is settings rows and nothing else to read', () => {
    const pane = document.querySelector('.view[data-view="settings"]')!;
    expect(pane.querySelectorAll('h3')).toHaveLength(0);
    // One explanation per row, one clause long.
    for (const row of pane.querySelectorAll('.setting')) {
      expect(row.querySelectorAll('.setting-text em')).toHaveLength(1);
    }
    // Prose is allowed only where a credential or a list needs to report its own state,
    // and only inside that field. A hint loose among the switches is the wall of text this
    // sheet was rebuilt to get rid of.
    for (const hint of pane.querySelectorAll('p.hint')) {
      expect(hint.closest('.field'), 'a hint is loose among the settings rows').not.toBeNull();
    }
  });

  /**
   * The goal loop controls belong together: the switch, key, model, reasoning and editable
   * continuation instruction. The key comes
   * before the picker, because a picker that cannot reach OpenRouter without one is not the
   * first thing to meet.
   */
  it('puts the goal key above the model picker', () => {
    const pane = document.querySelector('.view[data-view="settings"]')!;
    const order = [...pane.querySelectorAll('[id^="goal"]')].map((node) => node.id);
    expect(document.getElementById('goalEnabled')).toBeNull();
    expect(document.getElementById('chatAutomation')!.closest('#composerSettings')).not.toBeNull();
    expect(order.indexOf('goalKey')).toBeLessThan(order.indexOf('goalPick'));
    expect(order.indexOf('goalPick')).toBeLessThan(order.indexOf('goalReasoning'));
    expect(order.indexOf('goalReasoning')).toBeLessThan(order.indexOf('goalPromptEdit'));
    // Closed until asked for: the catalogue is several hundred long and costs a round trip.
    expect(document.getElementById('goalModels')!.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('goalPromptPanel')!.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('goalPrompt')?.tagName).toBe('TEXTAREA');
  });

  /** One threshold. Three inputs for the same number is three ways to disagree. */
  it('asks for a single compaction threshold', () => {
    const pane = document.querySelector('.view[data-view="settings"]')!;
    const numbers = [...pane.querySelectorAll('input[type="number"]')].map((input) => input.id);
    expect(numbers.filter(id => ['autoCompactTokens', 'sessAdvisory', 'sessLimit'].includes(id))).toEqual(['autoCompactTokens']);
    expect(numbers).toEqual([
      'maWorkers', 'maActiveChats', 'maRotationBatch', 'maRotationMinutes', 'maRotationForeground', 'maRateLimitCooldown', 'maSleepingRuntime',
      'sessRetain', 'autoCompactTokens'
    ]);
    expect(document.getElementById('maLimitAutomaticChats')).not.toBeNull();
    for (const id of ['sessAdvisory', 'sessLimit']) {
      expect(document.getElementById(id), `#${id} is back`).toBeNull();
    }
  });

  /**
   * Every input on the sheet has to be in the change-listener list or it silently does not
   * save. `autoCompactTokens` was missing from it, so the one number the automatic trigger
   * fires on kept whatever was typed until the pane was repainted, and then dropped it.
   */
  it('keeps sign-out emergency changes under one settings-sheet save owner', () => {
    const listened = /const CHAT_INPUTS[^=]*=\s*\[([^\]]*)\]/.exec(chatSource);
    expect(listened).not.toBeNull();
    expect(listened![1]!.match(/'signOutEmergencyAlerts'/g) ?? []).toHaveLength(1);
    expect(chatSource).toMatch(/for \(const id of CHAT_INPUTS\)\s*\{\s*\$\(id\)\.addEventListener\('change', \(\) => void deps\.save\(\)\)/);
    const general = /for \(const id of \[\s*'autoConnect',([\s\S]*?)\]\)\s*\{\s*\$\(id\)\.addEventListener\('change', \(\) => void save\(\)\)/.exec(mainSource);
    expect(general).not.toBeNull();
    expect(general![1]).not.toContain("'signOutEmergencyAlerts'");
    expect(mainSource).toContain("initChat({ save: () => save(), state: () => state, account: activeInstanceProfile })");
  });

  it('saves every field it shows', () => {
    const pane = document.querySelector('.view[data-view="settings"]')!;
    const listened = /const CHAT_INPUTS[^=]*=\s*\[([^\]]*)\]/.exec(chatSource);
    expect(listened, 'CHAT_INPUTS is gone or renamed').not.toBeNull();
    for (const input of pane.querySelectorAll<HTMLInputElement>('.pane input')) {
      if (input.id === 'browserDurations') {
        expect(input.disabled).toBe(true);
        expect(input.checked).toBe(true);
        expect(browserPreferencesSource).toContain("durations.disabled = true");
        expect(browserPreferencesSource).not.toContain("durations.addEventListener('change'");
        continue;
      }
      if (input.id === 'browserOverwrite') {
        expect(browserPreferencesSource).toContain(`('${input.id}')`);
        expect(browserPreferencesSource).toContain("overwrite.addEventListener('change'");
        continue;
      }
      // A credential is the one exception, and it is an exception on purpose: it is written
      // on blur through its own channel rather than saved with the settings snapshot, so
      // that a half-typed key never travels. It still has to be wired to something.
      if (input.type === 'password') {
        expect(chatSource, `#${input.id} is never read`).toContain(`$('${input.id}').addEventListener('blur'`);
        continue;
      }
      expect(listened![1], `#${input.id} never saves`).toContain(`'${input.id}'`);
    }
    // Selects and textareas save through the same change listener.
    for (const field of pane.querySelectorAll('select, textarea')) {
      // Interface language persists in the renderer; the event/storage behavior is
      // covered by renderer-i18n, independently of the app configuration channel.
      if (field.id === 'uiLanguage') continue;
      expect(listened![1], `#${field.id} never saves`).toContain(`'${field.id}'`);
    }
  });
});

describe('the session timeline', () => {
  it('shows compact timestamps beside authored user and assistant messages', () => {
    expect(rule('.ev:is(.ev-user_message, .ev-assistant_message)')).toContain('grid-template-columns: 58px minmax(0, 1fr)');
    expect(rule('.ev:is(.ev-user_message, .ev-assistant_message) > time')).toContain('display: block');
  });

  it('renders every event kind the recorder can write', async () => {
    const [shared, chat] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'src', 'shared', 'session.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'chat.ts'), 'utf8')
    ]);
    const union = shared.slice(shared.indexOf('export type SessionEvent ='), shared.indexOf('export type SessionEventKind'));
    const declared = [...new Set([...union.matchAll(/\bkind: '([a-z_]+)'/g)].map((match) => match[1]!))];
    expect(declared.length).toBeGreaterThan(5);

    const body = chat.slice(chat.indexOf('function eventBody'));
    const handled = new Set([...body.slice(0, body.indexOf('\n}')).matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]!));
    expect(declared.filter((kind) => !handled.has(kind))).toEqual([]);
  });
});

describe('the window as a whole', () => {
  it('keeps workspace settings in a scrollable column', () => {
    expect(rule("[data-panel='home']")).toContain('overflow-y: auto');
  });

  /**
   * Two panels each had a `#agentFilter`. `getElementById` only ever returns the first, so
   * the Activity panel's filter was unreachable and two modules bound handlers to the same
   * node. Ids are the app's only wiring between markup and script; duplicates are a bug.
   */
  it('has no duplicate element ids', () => {
    const seen = new Map<string, number>();
    for (const node of document.querySelectorAll('[id]')) {
      seen.set(node.id, (seen.get(node.id) ?? 0) + 1);
    }
    const duplicates = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
    expect(duplicates).toEqual([]);
  });

  it('never scrolls sideways', () => {
    // Wide authored tables may scroll locally; the surrounding app must not.
    const horizontal = [...css.matchAll(/([^{}]+)\{[^{}]*overflow-x:\s*(?:auto|scroll)[^{}]*\}/g)];
    expect(horizontal.map(match => match[1]!.trim())).toEqual(['.msg.rich .markdown-table']);
    expect(css).not.toMatch(/overflow:\s*(auto|scroll)\s+/);
    // The one scrolling surface in the app is vertical only.
    expect(rule('.scroll')).toContain('overflow: hidden auto');
  });

  it('keeps setup and settings vertically reachable when the window is short', () => {
    // The page itself stays fixed so header/nav remain put; long forms own the vertical scroll.
    expect(rule("[data-panel='setup'].is-active")).toContain('overflow: hidden auto');

    const settings = document.querySelector('.view[data-view="settings"]')!;
    const settingsScroller = settings.closest('#chatBody.scroll');
    expect(settingsScroller, 'settings is not inside the bounded scrolling body').not.toBeNull();
    expect(rule('.scroll')).toContain('overflow: hidden auto');
  });
});

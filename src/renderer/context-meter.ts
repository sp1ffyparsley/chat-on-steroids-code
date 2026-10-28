import { currentLanguage, ui, t } from './i18n.js';
import type { Config } from '../shared/types.js';
import type { SessionSummary } from '../shared/session.js';
import type { ReasoningEffort } from '../shared/session.js';

/** Recorder estimates, never a claim about the provider's exact context window. */
export function paintContextMeter(session: SessionSummary | null, config: Config, _composer: { model: string; reasoningEffort: ReasoningEffort } | null = null): void {
  const button = document.getElementById('contextMeterButton');
  const panel = document.getElementById('contextMeterInfo');
  const arc = document.getElementById('contextMeterArc');
  if (!button || !panel || !arc) return;
  const used = Math.max(0, session?.contextTokens ?? 0);
  const auto = config.compaction.auto && config.compaction.autoTokens > 0;
  const limit = auto ? config.compaction.autoTokens : config.sessions.limitTokens;
  const percent = limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0;
  arc.setAttribute('stroke-dasharray', `${percent * 0.377} 37.7`);
  const tokens = new Intl.NumberFormat(currentLanguage()).format(used);
  const description = () => [t('Session context · estimated'),
    auto
      ? t('{0} / {1} tokens · {2}% of the compaction point', [tokens, new Intl.NumberFormat(currentLanguage()).format(limit), percent])
      : t('{0} / {1} tokens · {2}% of the large-chat warning', [tokens, new Intl.NumberFormat(currentLanguage()).format(limit), percent]),
    config.compaction.auto
      ? t('Auto-compaction at {0} tokens', [new Intl.NumberFormat(currentLanguage()).format(config.compaction.autoTokens)])
      : t('Auto-compaction off')].join('\n');
  ui(panel, 'textContent', description);
  ui(button, 'aria-label', () => description().replaceAll('\n', '. '));
}

export function initContextMeter(): void {
  const root = document.getElementById('contextMeter');
  const button = document.getElementById('contextMeterButton');
  if (!root || !button) return;
  const close = () => { root.classList.remove('pinned'); button.setAttribute('aria-expanded', 'false'); };
  button.addEventListener('click', () => { const open = root.classList.toggle('pinned'); button.setAttribute('aria-expanded', String(open)); });
  document.addEventListener('click', event => { if (event.target instanceof Node && !root.contains(event.target)) close(); });
  button.addEventListener('keydown', event => { if (event.key === 'Escape') { close(); button.blur(); } });
}

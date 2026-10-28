import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { collectSettings, foldSettingsSearch, searchSettings } from '../src/renderer/settings-search.js';

describe('all-settings search', () => {
  it('folds accents and ranks title matches ahead of location/detail matches', () => {
    const dom = new JSDOM('<main></main>');
    const target = dom.window.document.querySelector('main') as HTMLElement;
    const entries = [
      { tab: 'advanced', page: 'Advanced', section: 'Connection', title: 'Reconnect browser', detail: 'Retry the paired browser.', target },
      { tab: 'appearance', page: 'Appearance', section: 'Language', title: 'Interface language', detail: 'Français and English', target },
      { tab: 'connection', page: 'Connection', section: 'Browser', title: 'Health', detail: 'Reconnect after a dropped connection.', target }
    ];
    expect(foldSettingsSearch('  Français  ', 'en')).toBe('francais');
    expect(searchSettings(entries, 'reconnect', 'en').map(row => row.title)).toEqual([
      'Reconnect browser',
      'Health'
    ]);
    expect(searchSettings(entries, 'francais', 'en').map(row => row.title)).toEqual(['Interface language']);
  });

  it('collects settings from multiple tabs and keeps section context', () => {
    const dom = new JSDOM(`
      <div id="tabs">
        <button data-tab="settings"><span>General</span></button>
        <button data-tab="advanced"><span>Advanced</span></button>
      </div>
      <section data-view="settings">
        <div class="settings-heading"><h1>General settings</h1><p>Everyday options</p></div>
        <div class="settings-section-title"><h2>Appearance</h2></div>
        <div class="setting"><span class="setting-text"><b>Theme</b><em>Light or dark</em></span></div>
      </section>
      <section data-panel="advanced">
        <div class="settings-heading"><h1>Advanced settings</h1></div>
        <div class="settings-section-head"><h2>Connection</h2></div>
        <div class="field"><label>Reconnect delay</label><input /></div>
      </section>
    `);
    const entries = collectSettings(dom.window.document);
    expect(entries.map(row => [row.page, row.section, row.title])).toEqual([
      ['General', '', 'General settings'],
      ['General', '', 'Appearance'],
      ['General', 'Appearance', 'Theme'],
      ['Advanced', '', 'Advanced settings'],
      ['Advanced', '', 'Connection'],
      ['Advanced', 'Connection', 'Reconnect delay']
    ]);
    expect(searchSettings(entries, 'connection reconnect', 'en').map(row => row.title)).toEqual(['Reconnect delay']);
  });
});

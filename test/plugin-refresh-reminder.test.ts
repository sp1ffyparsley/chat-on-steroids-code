import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
});
afterEach(() => dom.window.close());

it('learns a schema baseline and rearms only for a changed connector declaration across reloads', async () => {
  let { paintPluginRefreshReminder: paint } = await import('../src/renderer/plugin-refresh-reminder.js');
  const notice = document.getElementById('pluginRefreshReminder')!;
  const dismiss = document.getElementById('dismissPluginRefreshReminder')!;
  paint({ core: 'schema-a' });
  expect(notice.hidden).toBe(true);
  vi.resetModules();
  ({ paintPluginRefreshReminder: paint } = await import('../src/renderer/plugin-refresh-reminder.js'));
  paint({ core: 'schema-a' });
  expect(notice.hidden).toBe(true);
  paint({ core: 'schema-b' });
  expect(notice.hidden).toBe(false);
  dismiss.click();
  paint({ core: 'schema-b' });
  expect(notice.hidden).toBe(true);
  vi.resetModules();
  ({ paintPluginRefreshReminder: paint } = await import('../src/renderer/plugin-refresh-reminder.js'));
  paint({ core: 'schema-b' });
  expect(notice.hidden).toBe(true);
  paint({ core: 'schema-c' });
  expect(notice.hidden).toBe(false);
  dismiss.click();
  paint({ core: 'schema-c' });
  expect(notice.hidden).toBe(true);
});

it('dismisses only the reminder and leaves simultaneous extension or update notices visible', async () => {
  const { paintPluginRefreshReminder } = await import('../src/renderer/plugin-refresh-reminder.js');
  const update = document.getElementById('updateNotice')!;
  update.hidden = false;
  paintPluginRefreshReminder({ core: 'schema-a' });
  paintPluginRefreshReminder({ core: 'schema-b' });
  document.getElementById('dismissPluginRefreshReminder')!.click();
  expect(document.getElementById('pluginRefreshReminder')!.hidden).toBe(true);
  expect(update.hidden).toBe(false);
});

it('hides a confirmed schema refresh, persists it, and still notices a later change', async () => {
  let { paintPluginRefreshReminder: paint } = await import('../src/renderer/plugin-refresh-reminder.js');
  const notice = document.getElementById('pluginRefreshReminder')!;
  paint({ core: 'schema-a' }, { core: 'schema-a' });
  paint({ core: 'schema-b' }, { core: 'schema-a' });
  expect(notice.hidden).toBe(false);
  paint({ core: 'schema-b' }, { core: 'schema-b' });
  expect(notice.hidden).toBe(true);
  vi.resetModules();
  ({ paintPluginRefreshReminder: paint } = await import('../src/renderer/plugin-refresh-reminder.js'));
  paint({ core: 'schema-b' }, {});
  expect(notice.hidden).toBe(true);
  paint({ core: 'schema-c' }, { core: 'schema-b' });
  expect(notice.hidden).toBe(false);
});

it('keeps a different unconfirmed surface visible when Core refresh is confirmed', async () => {
  const { paintPluginRefreshReminder: paint } = await import('../src/renderer/plugin-refresh-reminder.js');
  const notice = document.getElementById('pluginRefreshReminder')!;
  paint({ core: 'core-a', desktop: 'desktop-a' });
  paint({ core: 'core-b', desktop: 'desktop-b' }, { core: 'core-b', desktop: 'desktop-a' });
  expect(notice.hidden).toBe(false);
  paint({ core: 'core-b', desktop: 'desktop-b' }, { core: 'core-b', desktop: 'desktop-b' });
  expect(notice.hidden).toBe(true);
});

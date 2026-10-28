import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { preserveTimelineViewport, redirectNestedTimelineWheel } from '../src/renderer/timeline-scroll.js';

it('anchors the logical reader row across late growth and replacement, while retaining nested tool scroll', () => {
  const dom = new JSDOM('<div id="pane"><div id="timeline"><div data-timeline-key="reader"><details open><p>Tool result</p></details></div></div></div>');
  try {
    const pane = dom.window.document.getElementById('pane')!;
    const timeline = dom.window.document.getElementById('timeline')!;
    let row = timeline.firstElementChild as HTMLElement;
    let documentTop = 450;
    pane.scrollTop = 400;
    Object.defineProperties(pane, { clientHeight: { value: 200 }, scrollHeight: { value: 1500 } });
    pane.getBoundingClientRect = () => ({ top: 20 } as DOMRect);
    const measure = () => ({ top: 20 + documentTop - pane.scrollTop, bottom: 220 + documentTop - pane.scrollTop, height: 200 } as DOMRect);
    row.getBoundingClientRect = measure;
    const result = row.querySelector('p')!;
    result.scrollTop = 75;
    let restore = preserveTimelineViewport(pane, timeline);
    documentTop += 180;
    restore();
    expect(pane.scrollTop).toBe(580);
    expect(measure().top).toBe(70);
    expect(result.scrollTop).toBe(75);
    expect(row.querySelector('details')!.open).toBe(true);

    restore = preserveTimelineViewport(pane, timeline);
    const replacement = row.cloneNode(true) as HTMLElement;
    replacement.getBoundingClientRect = measure;
    row.replaceWith(replacement); row = replacement;
    documentTop += 90;
    restore();
    expect(pane.scrollTop).toBe(670);
    expect(measure().top).toBe(70);

    restore = preserveTimelineViewport(pane, timeline);
    row.remove(); restore();
    expect(pane.scrollTop).toBe(670);
    pane.scrollTop = 1300;
    restore = preserveTimelineViewport(pane, timeline);
    restore();
    expect(pane.scrollTop).toBe(1500); // Browser clamps to the new bottom.
  } finally { dom.window.close(); }
});

it('redirects vertical wheel motion from a nested historical scroller to the transcript', () => {
  const dom = new JSDOM('<div id="pane"><div id="nested" style="overflow-y:auto"><span id="target">old result</span></div></div>');
  try {
    const pane = dom.window.document.getElementById('pane')!;
    const nested = dom.window.document.getElementById('nested')!;
    const target = dom.window.document.getElementById('target')!;
    pane.scrollTop = 100;
    Object.defineProperties(nested, { clientHeight: { value: 100 }, scrollHeight: { value: 500 } });
    const vertical = new dom.window.WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true });
    target.dispatchEvent(vertical);
    expect(redirectNestedTimelineWheel(pane, vertical)).toBe(true);
    expect(vertical.defaultPrevented).toBe(true);
    expect(pane.scrollTop).toBe(160);

    const horizontal = new dom.window.WheelEvent('wheel', { deltaX: 60, deltaY: 20, bubbles: true, cancelable: true });
    target.dispatchEvent(horizontal);
    expect(redirectNestedTimelineWheel(pane, horizontal)).toBe(false);
    expect(pane.scrollTop).toBe(160);
  } finally { dom.window.close(); }
});

it('uses another visible row when a paged activity group loses its old key', () => {
  const dom = new JSDOM('<div id="pane"><div id="timeline"><div data-timeline-key="old-group"></div><div data-timeline-key="message"></div></div></div>');
  try {
    const pane = dom.window.document.getElementById('pane')!;
    const timeline = dom.window.document.getElementById('timeline')!;
    const group = timeline.children[0] as HTMLElement, message = timeline.children[1] as HTMLElement;
    let added = 0;
    pane.scrollTop = 0;
    Object.defineProperties(pane, { clientHeight: { value: 400 }, scrollHeight: { value: 4000 } });
    pane.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    group.getBoundingClientRect = () => ({ top: added - pane.scrollTop, bottom: added + 30 - pane.scrollTop, height: 30 } as DOMRect);
    message.getBoundingClientRect = () => ({ top: added + 30 - pane.scrollTop, bottom: added + 100 - pane.scrollTop, height: 70 } as DOMRect);
    const restore = preserveTimelineViewport(pane, timeline, false);
    group.remove(); added = 2000;
    restore();
    expect(message.getBoundingClientRect().top).toBe(30);
    expect(pane.scrollTop).toBe(2000);
  } finally { dom.window.close(); }
});

it('uses semantic reader intent when growth has displaced the live tail geometry', () => {
  const dom = new JSDOM('<div id="pane"><div id="timeline"></div></div>');
  try {
    const pane = dom.window.document.getElementById('pane')!;
    const timeline = dom.window.document.getElementById('timeline')!;
    Object.defineProperties(pane, { clientHeight: { value: 200 }, scrollHeight: { value: 1200 } });
    pane.scrollTop = 700; // Content grew after the reader had been at the end.
    preserveTimelineViewport(pane, timeline, true, true)();
    expect(pane.scrollTop).toBe(1200);

    pane.scrollTop = 999; // One pixel away is a deliberate reading position.
    preserveTimelineViewport(pane, timeline, true, false)();
    expect(pane.scrollTop).toBe(999);
  } finally { dom.window.close(); }
});

/** Capture the visible logical row for one synchronous reconciliation. No retained
 * state: selection changes and user scrolling naturally get a fresh anchor. */
export function preserveTimelineViewport(
  pane: HTMLElement,
  timeline: HTMLElement,
  followBottom = true,
  atEnd?: boolean
): () => void {
  const previous = pane.scrollTop;
  // When the caller tracks reader intent, content growth or a layout clamp must not be
  // mistaken for the reader scrolling away. Without that semantic state retain the
  // strict geometric fallback; even a small deliberate move should remain readable.
  const following = followBottom && (atEnd ?? previous + pane.clientHeight >= pane.scrollHeight - 1);
  const previousReserve = Number.parseFloat(timeline.style.getPropertyValue('--timeline-scroll-reserve')) || 0;
  const previousContentHeight = timeline.getBoundingClientRect().height - previousReserve;
  const edge = pane.getBoundingClientRect().top;
  const rows = () => [...timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')]
    .filter(row => !row.matches('.tool-group[open]'));
  const anchors: Array<{ key: string | undefined; offset: number }> = [];
  if (!following) for (const row of rows()) {
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.top >= edge + pane.clientHeight) break;
    if (rect.bottom > edge) anchors.push({ key: row.dataset.timelineKey, offset: rect.top - edge });
  }
  return () => {
    timeline.style.removeProperty('--timeline-scroll-reserve');
    if (following) {
      const growth = Math.max(0, timeline.getBoundingClientRect().height - previousContentHeight);
      const reserve = Math.max(0, previousReserve - growth);
      if (reserve > 0) timeline.style.setProperty('--timeline-scroll-reserve', `${reserve}px`);
      pane.scrollTop = pane.scrollHeight;
      return;
    }
    const currentRows = new Map(rows().map(row => [row.dataset.timelineKey, row]));
    for (const anchor of anchors) {
      const rect = currentRows.get(anchor.key)?.getBoundingClientRect();
      if (!rect || rect.height <= 0) continue;
      const top = pane.scrollTop + rect.top - pane.getBoundingClientRect().top - anchor.offset;
      // An underfilled tail has real blank space below its last row. Prepending
      // must preserve that space too, otherwise Chromium clamps the restored
      // anchor to the new bottom and moves every visible message. Recompute the
      // reserve on each paint so later content naturally consumes it.
      const reserve = Math.ceil(top - Math.max(0, pane.scrollHeight - pane.clientHeight));
      if (reserve > 0) timeline.style.setProperty('--timeline-scroll-reserve', `${reserve}px`);
      pane.scrollTop = top;
      return;
    }
    pane.scrollTop = previous;
  };
}

/** Keep vertical wheel navigation on the transcript even when the pointer is over an old
 * nested overflow surface. Vertical reading has one owner, so a historical result cannot
 * turn the whole chat into a tiny wheel trap. */
export function redirectNestedTimelineWheel(pane: HTMLElement, event: WheelEvent): boolean {
  if (event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || event.deltaY === 0) return false;
  const view = pane.ownerDocument.defaultView;
  if (!view) return false;
  let node = event.target instanceof view.Element ? event.target : null;
  while (node && node !== pane) {
    if (node instanceof view.HTMLElement && node.scrollHeight > node.clientHeight) {
      const overflow = view.getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') {
        event.preventDefault();
        pane.scrollTop += event.deltaY;
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

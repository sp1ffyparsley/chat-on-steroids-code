/** Local presentation preference for chats pinned within their existing sidebar group. */
const STORAGE_KEY = 'chat-on-steroids.sidebar-pins';
const MAX_PINS = 500;
const PINNED_SCOPE = 'pinned:';

export function pinnedSortScope(scope: string, pinned: boolean): string {
  return pinned ? `${PINNED_SCOPE}${scope}` : scope;
}

export function createSidebarPins(storage: Storage = window.localStorage) {
  const pins = new Set<string>();
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const saved: unknown = raw && raw.length <= 100_000 ? JSON.parse(raw) : [];
    if (Array.isArray(saved)) {
      for (const id of saved) {
        if (pins.size >= MAX_PINS) break;
        if (typeof id === 'string' && id.length > 0 && id.length <= 160) pins.add(id);
      }
    }
  } catch { /* Corrupt or unavailable layout storage must not block the sidebar. */ }

  const save = (): void => {
    try { storage.setItem(STORAGE_KEY, JSON.stringify([...pins])); }
    catch { /* Keep the preference for this window when storage is unavailable. */ }
  };

  return {
    has(id: string): boolean { return pins.has(id); },
    toggle(id: string): boolean {
      if (pins.has(id)) pins.delete(id);
      else {
        if (pins.size >= MAX_PINS) pins.delete(pins.values().next().value!);
        pins.add(id);
      }
      save();
      return pins.has(id);
    },
    first<T extends { id: string }>(rows: T[]): T[] {
      return [...rows.filter(row => pins.has(row.id)), ...rows.filter(row => !pins.has(row.id))];
    }
  };
}

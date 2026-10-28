import { describe, expect, it } from 'vitest';
import { createSidebarPins, pinnedSortScope } from '../src/renderer/sidebar-pins.js';

class MapStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('sidebar pins', () => {
  it('keeps pinned chats first without changing either group order', () => {
    const pins = createSidebarPins(new MapStorage());
    pins.toggle('b');
    pins.toggle('d');
    expect(pins.first([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]).map(row => row.id))
      .toEqual(['b', 'd', 'a', 'c']);
  });

  it('persists toggles and gives pinned rows an independent drag scope', () => {
    const storage = new MapStorage();
    const pins = createSidebarPins(storage);
    expect(pins.toggle('chat-1')).toBe(true);
    expect(createSidebarPins(storage).has('chat-1')).toBe(true);
    expect(pinnedSortScope('project:a', true)).toBe('pinned:project:a');
    expect(pinnedSortScope('project:a', false)).toBe('project:a');
    expect(pins.toggle('chat-1')).toBe(false);
  });
});

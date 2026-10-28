import { describe, expect, it } from 'vitest';
import { manualPublicOriginSchema, manualPortSchema, persistentMcpPort } from '../src/shared/external-tunnel.js';

describe('external route validation', () => {
  it('accepts only a public HTTPS origin without credentials, path, query, fragment or alternative port', () => {
    expect(manualPublicOriginSchema.parse('https://Delta.example.com/')).toBe('https://Delta.example.com');
    expect(manualPublicOriginSchema.parse('')).toBe('');
    for (const value of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/mcp/token',
      'https://example.com?secret=value', 'https://example.com#secret', 'https://127.0.0.1', 'https://localhost', 'https://example.com:444'])
      expect(manualPublicOriginSchema.safeParse(value).success).toBe(false);
  });
  it('keeps one deterministic port per profile and refuses invalid or bridge-sharing ports', () => {
    expect(persistentMcpPort(0, 8770)).toBe(9770);
    expect(persistentMcpPort(0, 8771)).toBe(9771);
    expect(persistentMcpPort(18000, 8770)).toBe(18000);
    for (const value of [80, -1, 65536, NaN, 1.5]) expect(manualPortSchema.safeParse(value).success).toBe(false);
    expect(() => persistentMcpPort(8770, 8770)).toThrow();
    expect(() => persistentMcpPort(0, 65000)).toThrow();
  });
});

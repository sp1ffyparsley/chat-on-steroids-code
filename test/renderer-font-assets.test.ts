import { expect, it } from 'vitest';
import { rendererAssetsInlineLimit } from '../electron.vite.config';

it('ships font files without weakening the renderer font policy', () => {
  for (const name of ['KaTeX.woff2', 'face.woff', 'face.TTF', 'face.otf', 'face.eot']) {
    expect(rendererAssetsInlineLimit(name)).toBe(false);
  }
  expect(rendererAssetsInlineLimit('icon.svg')).toBeUndefined();
  expect(rendererAssetsInlineLimit('photo.png')).toBeUndefined();
});

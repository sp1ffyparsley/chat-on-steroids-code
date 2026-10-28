import { describe, expect, it } from 'vitest';
import { act, screenshot } from '../src/main/computer/index.js';
import { IS_WINDOWS } from './helpers.js';

describe.runIf(IS_WINDOWS)('desktop screenshot coordinate bounds', () => {
  it('refuses points outside the image instead of converting them into off-frame desktop input', async () => {
    const shot = await screenshot({ maxWidth: 320 });

    await expect(act([{ type: 'move', x: -1, y: 0 }], { frameId: shot.frameId })).rejects.toThrow(/OUT_OF_FRAME/);
    await expect(
      act([{ type: 'move', x: shot.width, y: Math.max(0, shot.height - 1) }], { frameId: shot.frameId })
    ).rejects.toThrow(/OUT_OF_FRAME/);
    await expect(
      act(
        [
          {
            type: 'drag',
            path: [
              { x: 0, y: 0 },
              { x: Math.max(0, shot.width - 1), y: shot.height }
            ]
          }
        ],
        { frameId: shot.frameId }
      )
    ).rejects.toThrow(/OUT_OF_FRAME/);
  });
});

import { describe, expect, it } from 'vitest';
import { placeMenu } from '../src/react/SlashMenu.js';

const viewport = { width: 1280, height: 800 };

describe('placeMenu', () => {
  it('opens below the caret when there is room', () => {
    expect(placeMenu({ top: 100, bottom: 120, left: 300 }, 340, viewport)).toMatchObject({ top: 126, left: 300 });
  });

  it('flips above the caret near the bottom of the viewport', () => {
    const p = placeMenu({ top: 612, bottom: 632, left: 300 }, 340, viewport);
    expect(p.top + 340).toBeLessThanOrEqual(612);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });

  it('never runs off screen when neither side fits', () => {
    const p = placeMenu({ top: 200, bottom: 220, left: 300 }, 340, { width: 375, height: 420 });
    expect(p.top + Math.min(340, p.maxHeight)).toBeLessThanOrEqual(420 - 8);
  });

  it('keeps the menu inside the right edge', () => {
    expect(placeMenu({ top: 100, bottom: 120, left: 1200 }, 340, viewport).left).toBe(1280 - 288 - 8);
  });
});

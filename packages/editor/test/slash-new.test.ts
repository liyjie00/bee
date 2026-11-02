import { describe, expect, it } from 'vitest';
import { promoteNew } from '../src/react/SlashMenu.js';

const item = (id: string) => ({ id, title: id, hint: '', icon: '', keywords: '', run: () => {} });

describe('promoteNew', () => {
  it('moves new blocks to the top in menu order and marks them', () => {
    const out = promoteNew([item('text'), item('h1'), item('sheet'), item('linkWhiteboard')], ['linkWhiteboard', 'sheet']);
    expect(out.map((i) => i.id)).toEqual(['sheet', 'linkWhiteboard', 'text', 'h1']);
    expect(out.map((i) => !!i.isNew)).toEqual([true, true, false, false]);
  });

  it('leaves the menu alone when nothing is new', () => {
    const items = [item('text'), item('sheet')];
    expect(promoteNew(items, [])).toBe(items);
  });
});

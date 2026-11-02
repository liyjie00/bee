import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// body and .main never scroll (styles.css); a page body taller than the window is only reachable
// inside a .view scroll container. Settings shipped without one and its lower sections were cut off.
const pages = ['DocView', 'FolderPage', 'HistoryPage', 'SettingsPage'];

describe('page scroll containers', () => {
  it.each(pages)('%s scrolls its body inside .view', (name) => {
    const src = readFileSync(join(process.cwd(), 'src/pages', `${name}.tsx`), 'utf8');
    expect(src).toMatch(/className=\{?["'`]?[^"'`]*\bview\b/);
  });
});

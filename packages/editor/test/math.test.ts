import { describe, expect, it } from 'vitest';
import { jsonToMarkdown, markdownToJSON, markdownToYUpdate, yUpdateToMarkdown } from '../src/markdown/index.js';
import type { JSONNode } from '../src/markdown/types.js';

const para = (md: string) => markdownToJSON(md).content![0]!;

describe('math in Markdown', () => {
  it('reads $…$, $$…$$ and \\(…\\) inline', () => {
    expect(para('Energy $E=mc^2$ here').content).toEqual([
      { type: 'text', text: 'Energy ' },
      { type: 'inlineMath', attrs: { latex: 'E=mc^2' } },
      { type: 'text', text: ' here' },
    ]);
    expect(para('a $$x+1$$ b').content![1]).toEqual({ type: 'inlineMath', attrs: { latex: 'x+1' } });
    expect(para('a \\(\\frac{1}{2}\\) b').content![1]).toEqual({ type: 'inlineMath', attrs: { latex: '\\frac{1}{2}' } });
  });

  it('leaves prices, escaped dollars and code alone', () => {
    expect(para('It costs $5 and $10.').content).toEqual([{ type: 'text', text: 'It costs $5 and $10.' }]);
    expect(para('From $5 to $10').content).toEqual([{ type: 'text', text: 'From $5 to $10' }]);
    expect(para('\\$x\\$').content).toEqual([{ type: 'text', text: '$x$' }]);
    expect(para('`$x$`').content).toEqual([{ type: 'text', text: '$x$', marks: [{ type: 'code' }] }]);
  });

  it('reads $$ and \\[ blocks, also right after a paragraph', () => {
    const doc = markdownToJSON('Roots:\n$$\nx = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n$$\n\n\\[ a^2 + b^2 \\]\n\nafter');
    expect(doc.content!.map((n) => n.type)).toEqual(['paragraph', 'blockMath', 'blockMath', 'paragraph']);
    expect(doc.content![1]!.attrs).toEqual({ latex: 'x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}' });
    expect(doc.content![2]!.attrs).toEqual({ latex: 'a^2 + b^2' });
  });

  it('round-trips through Markdown and Yjs', () => {
    const md = 'Energy $E=mc^2$ here\n\n$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$\n\nPrice $5 and $10\n';
    expect(yUpdateToMarkdown(markdownToYUpdate(md))).toBe(md);
  });

  it('escapes text dollars that would read back as math', () => {
    const doc: JSONNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'literal $x$ and $$' }] }] };
    const md = jsonToMarkdown(doc);
    expect(md).toBe('literal \\$x\\$ and \\$\\$\n');
    expect(markdownToJSON(md).content![0]!.content).toEqual([{ type: 'text', text: 'literal $x$ and $$' }]);
  });

  it('writes formulas that $…$ cannot hold as $$…$$', () => {
    const doc: JSONNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'inlineMath', attrs: { latex: ' x ' } }] }] };
    expect(jsonToMarkdown(doc)).toBe('$$ x $$\n');
  });
});

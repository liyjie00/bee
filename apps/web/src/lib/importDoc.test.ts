import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from './importDoc';

describe('htmlToMarkdown', () => {
  it('keeps headings, marks, lists, links and tables', () => {
    const md = htmlToMarkdown(
      '<h2>Plan</h2><p>Some <strong>bold</strong> and <a href="https://x.dev">a link</a></p>' +
        '<ul><li>one</li><li>two</li></ul>' +
        '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
    );
    expect(md).toContain('## Plan');
    expect(md).toContain('**bold**');
    expect(md).toContain('[a link](https://x.dev)');
    expect(md).toMatch(/- one\n- two/);
    expect(md).toMatch(/\| A \| B \|/);
  });
});

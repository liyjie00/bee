import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyMarkdown, markdownToYUpdate, yDocToJSON, yDocToMarkdown } from '../src/markdown/index.js';

const docFrom = (md: string) => {
  const d = new Y.Doc();
  Y.applyUpdate(d, markdownToYUpdate(md));
  return d;
};
const ids = (d: Y.Doc) => (yDocToJSON(d).content ?? []).map((n) => n.attrs?.blockId as string);

const SAMPLE = `# Title

First paragraph.

- one
- two

Last paragraph with **bold**.`;

describe('applyMarkdown', () => {
  it('replace keeps untouched blocks and their ids', () => {
    const d = docFrom(SAMPLE);
    const before = ids(d);
    const next = SAMPLE.replace('First paragraph.', 'First paragraph, edited.');
    const r = applyMarkdown(d, next, 'replace');
    expect(yDocToMarkdown(d).trim()).toBe(next);
    expect(r).toEqual({ kept: 3, removed: 1, inserted: 1 });
    // Same-type replacement keeps the block id too.
    expect(ids(d)).toEqual(before);
  });

  it('keeps Yjs items of untouched blocks (comment anchors survive)', () => {
    const d = docFrom(SAMPLE);
    const last = d.getXmlFragment('default').get(3);
    applyMarkdown(d, SAMPLE.replace('# Title', '# New title'), 'replace');
    expect(d.getXmlFragment('default').get(3)).toBe(last);
  });

  it('inserts and deletes blocks', () => {
    const d = docFrom(SAMPLE);
    applyMarkdown(d, '# Title\n\nInserted.\n\nLast paragraph with **bold**.', 'replace');
    expect(yDocToMarkdown(d).trim()).toBe('# Title\n\nInserted.\n\nLast paragraph with **bold**.');
  });

  it('replacing with empty markdown leaves one empty paragraph', () => {
    const d = docFrom(SAMPLE);
    applyMarkdown(d, '', 'replace');
    expect(yDocToJSON(d).content).toHaveLength(1);
  });

  it('append adds to the end, and replaces a fresh empty doc', () => {
    const d = docFrom(SAMPLE);
    applyMarkdown(d, '## More\n\nText.', 'append');
    expect(yDocToMarkdown(d).trim()).toBe(`${SAMPLE}\n\n## More\n\nText.`);
    const empty = new Y.Doc();
    applyMarkdown(empty, 'Hello', 'replace');
    applyMarkdown(empty, 'World', 'append');
    expect(yDocToMarkdown(empty).trim()).toBe('Hello\n\nWorld');
  });

  it('edits propagate to another replica as normal updates', () => {
    const a = docFrom(SAMPLE);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u));
    applyMarkdown(a, SAMPLE + '\n\nAdded.', 'replace');
    expect(yDocToMarkdown(b)).toBe(yDocToMarkdown(a));
  });
});

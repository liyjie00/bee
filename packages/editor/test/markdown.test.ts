import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  markdownToJSON,
  markdownToYUpdate,
  yUpdateBlockIds,
  yUpdateHasBlock,
  yUpdateToJSON,
  yUpdateToMarkdown,
} from '../src/markdown/index.js';

const SAMPLE = `# Title

Some **bold** and _italic_ and \`code\` with a [link](https://example.com).

- one
- two
  - nested

1. first
2. second

- [x] done
- [ ] todo

> quoted

\`\`\`ts
const a = 1;
\`\`\`

\`\`\`mermaid
graph TD; A-->B
\`\`\`

| a | b |
| --- | --- |
| 1 | 2 |

---

![alt](https://img/x.png)

<!-- bee:whiteboard wb_123 -->

<!-- bee:whiteboard wb_456 linked -->
`;

describe('markdown', () => {
  it('parses markdown to schema JSON', () => {
    const json = markdownToJSON(SAMPLE);
    const types = json.content!.map((n) => n.type);
    expect(types).toEqual([
      'heading',
      'paragraph',
      'bulletList',
      'orderedList',
      'taskList',
      'blockquote',
      'codeBlock',
      'codeBlock',
      'table',
      'horizontalRule',
      'image',
      'whiteboard',
      'whiteboard',
    ]);
  });

  it('round-trips through Yjs', () => {
    const update = markdownToYUpdate(SAMPLE);
    const md = yUpdateToMarkdown(update);
    expect(md).toContain('# Title');
    expect(md).toContain('Some **bold** and _italic_ and `code` with a [link](https://example.com).');
    expect(md).toContain('- one\n- two\n  - nested');
    expect(md).toContain('1. first\n2. second');
    expect(md).toContain('- [x] done\n- [ ] todo');
    expect(md).toContain('```ts\nconst a = 1;\n```');
    expect(md).toContain('```mermaid\ngraph TD; A-->B\n```');
    expect(md).toContain('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(md).toContain('![alt](https://img/x.png)');
    expect(md).toContain('<!-- bee:whiteboard wb_123 -->');
    expect(md).toContain('<!-- bee:whiteboard wb_456 linked -->');
    // Second pass is stable.
    expect(yUpdateToMarkdown(markdownToYUpdate(md))).toBe(md);
  });

  it('round-trips columns and whiteboard layout', () => {
    const md = [
      'Intro',
      '<!-- bee:columns -->',
      '<!-- bee:whiteboard wb_1 linked width=60 align=left height=300 view=-10,20,400,300 -->',
      '<!-- bee:column -->',
      'Right **side**',
      '<!-- bee:/columns -->',
      'After',
    ].join('\n\n') + '\n';
    const json = markdownToJSON(md);
    expect(json.content!.map((n) => n.type)).toEqual(['paragraph', 'columns', 'paragraph']);
    const cols = json.content![1]!;
    expect(cols.content!.map((c) => c.content![0]!.type)).toEqual(['whiteboard', 'paragraph']);
    expect(cols.content![0]!.content![0]!.attrs).toMatchObject({
      documentId: 'wb_1',
      linked: true,
      width: 60,
      align: 'left',
      height: 300,
      view: '-10,20,400,300',
    });
    expect(yUpdateToMarkdown(markdownToYUpdate(md))).toBe(md);
  });

  it('assigns unique block ids', () => {
    const update = markdownToYUpdate(SAMPLE);
    const ids = yUpdateBlockIds(update);
    expect(ids.size).toBeGreaterThan(10);
    const first = yUpdateToJSON(update).content![0]!.attrs!.blockId as string;
    expect(yUpdateHasBlock(update, first)).toBe(true);
    expect(yUpdateHasBlock(update, 'missing')).toBe(false);
  });

  it('handles empty state', () => {
    expect(yUpdateToMarkdown(Y.encodeStateAsUpdate(new Y.Doc()))).toBe('');
  });
});

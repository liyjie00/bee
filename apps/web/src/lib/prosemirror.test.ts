import { describe, expect, it } from 'vitest';
import { diffDocs, diffStats, docText, toBlocks } from './prosemirror';

const p = (text: string) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

describe('toBlocks', () => {
  it('flattens headings, lists and tasks', () => {
    const d = doc(
      { type: 'heading', attrs: { level: 2, blockId: 'h' }, content: [{ type: 'text', text: '标题' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [p('一')] }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('完成')] }] },
    );
    expect(toBlocks(d)).toEqual([
      { kind: 'h2', text: '标题', blockId: 'h' },
      { kind: 'li', text: '一', checked: undefined, blockId: undefined },
      { kind: 'task', text: '完成', checked: true, blockId: undefined },
    ]);
    expect(docText(d)).toBe('标题\n一\n完成');
  });
  it('tolerates empty input', () => {
    expect(toBlocks(null)).toEqual([]);
  });
});

describe('diffDocs', () => {
  it('marks inserted and removed blocks', () => {
    const r = diffDocs(doc(p('a'), p('b')), doc(p('a'), p('c'), p('d')));
    expect(r.map((x) => x.op)).toEqual(['same', 'mod', 'ins']);
  });
  it('shows in-place word changes', () => {
    const r = diffDocs(doc(p('面向个人用户')), doc(p('面向个人和小团队用户')));
    expect(r).toHaveLength(1);
    expect(r[0]!.op).toBe('mod');
    const ins = r[0]!.pieces.filter((x) => x.op === 'ins').map((x) => x.text).join('');
    expect(ins).toContain('小团队');
    expect(diffStats(r).added).toBeGreaterThan(0);
  });
  it('is all same for identical docs', () => {
    const d = doc(p('x'), p('y'));
    expect(diffDocs(d, d).every((x) => x.op === 'same')).toBe(true);
  });
});

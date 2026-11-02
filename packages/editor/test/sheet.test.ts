import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { markdownToJSON, markdownToYUpdate, yDocToMarkdown } from '../src/markdown/index.js';
import { cellKey, formatNumber, readSheet, renameSheet, sheetTextGrid, uniqueSheetName, writeSheet } from '../src/schema/sheet-data.js';

function docWithSheet() {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, markdownToYUpdate('Intro\n\n<!-- bee:sheet s1 -->\n\nAfter'));
  writeSheet(ydoc, 's1', {
    name: '预算',
    cells: [
      [cellKey(0, 0), { v: 'Item' }],
      [cellKey(0, 1), { v: 'Price' }],
      [cellKey(1, 0), { v: 'Server' }],
      [cellKey(1, 1), { v: 1200, s: { n: { pattern: '"¥"#,##0' } } }],
    ],
  });
  writeSheet(ydoc, 's2', { name: 'Summary', cells: [[cellKey(0, 0), { f: '=预算!B2*2', v: 2400 }]] });
  return ydoc;
}

describe('spreadsheet blocks', () => {
  it('exports the marker and the computed values as a Markdown table', () => {
    const md = yDocToMarkdown(docWithSheet());
    expect(md).toContain('<!-- bee:sheet s1 name="预算" -->\n| Item | Price |\n| --- | --- |\n| Server | ¥1,200 |');
  });

  it('imports the marker and skips its values table', () => {
    const json = markdownToJSON('<!-- bee:sheet s1 name="预算" -->\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nText');
    expect(json.content?.map((n) => n.type)).toEqual(['sheet', 'paragraph']);
    expect(json.content?.[0]?.attrs).toEqual({ sheetId: 's1' });
  });

  it('rewrites references when a table is renamed', () => {
    const ydoc = docWithSheet();
    renameSheet(ydoc, 's1', 'Budget 2027');
    expect(readSheet(ydoc, 's1')?.name).toBe('Budget 2027');
    expect(readSheet(ydoc, 's2')?.cells.get(cellKey(0, 0))?.f).toBe("='Budget 2027'!B2*2");
  });

  it('names new tables uniquely and formats numbers', () => {
    const ydoc = docWithSheet();
    expect(uniqueSheetName(ydoc, '表格')).toBe('表格1');
    expect(formatNumber(0.256, '0.0%')).toBe('25.6%');
    expect(formatNumber(-1234.5, '#,##0.00')).toBe('-1,234.50');
    expect(sheetTextGrid(readSheet(ydoc, 's2')!)).toEqual([['2400']]);
  });
});

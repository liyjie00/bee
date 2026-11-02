// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { Sheet, columnIndex, columnName, display } from '../src/react/formula.js';
import { schemaExtensions } from '../src/schema/index.js';
import { TableSheet } from '../src/react/table-sheet.js';

const value = (grid: string[][], ref: string) => {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  return display(new Sheet(grid).evaluate(Number(m[2]) - 1, columnIndex(m[1]!)) as never);
};

describe('formula engine', () => {
  it('names columns like a spreadsheet', () => {
    expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
    expect(columnIndex('AA')).toBe(26);
  });

  it('evaluates refs, arithmetic and precedence', () => {
    const g = [
      ['1', '2', '=A1+B1'],
      ['3', '4', '=A1+B1*A2^2-(B2/4)'],
      ['1,000', '50%', '=A3*B3'],
      ['0.1', '0.2', '=A4+B4'],
    ];
    expect(value(g, 'C1')).toBe('3');
    expect(value(g, 'C2')).toBe('18');
    expect(value(g, 'C3')).toBe('500');
    expect(value(g, 'C4')).toBe('0.3');
  });

  it('supports ranges and functions, skipping text in aggregates', () => {
    const g = [
      ['Item', 'Qty', 'Price'],
      ['a', '2', '10'],
      ['b', '3', '20'],
      ['c', '', 'n/a'],
      ['=SUM(B2:B4)', '=AVERAGE(B2:B3)', '=SUM(C2:C4)'],
      ['=MAX(B2:C3)', '=ROUND(10/3, 2)', '=IF(A5>4, "big", "small")'],
      ['=COUNT(B1:C4)', '=sum（B2，B3）', '=A1&" x"&B2'],
    ];
    expect(value(g, 'A5')).toBe('5');
    expect(value(g, 'B5')).toBe('2.5');
    expect(value(g, 'C5')).toBe('30');
    expect(value(g, 'A6')).toBe('20');
    expect(value(g, 'B6')).toBe('3.33');
    expect(value(g, 'C6')).toBe('big');
    expect(value(g, 'A7')).toBe('4');
    expect(value(g, 'B7')).toBe('5');
    expect(value(g, 'C7')).toBe('Item x2');
    // Ranges past the table are clipped rather than errors.
    expect(value([['1', '=SUM(A1:A99)'], ['2', '']], 'B1')).toBe('3');
  });

  it('reports errors', () => {
    const g = [
      ['=B1', '=A1', '=1/0'],
      ['=Z9', '=FOO(1)', '=A3+1'],
      ['text', '=1+', '=C1+1'],
    ];
    expect(value(g, 'A1')).toBe('#CYCLE!');
    expect(value(g, 'C1')).toBe('#DIV/0!');
    expect(value(g, 'A2')).toBe('#REF!');
    expect(value(g, 'B2')).toBe('#NAME?');
    expect(value(g, 'C2')).toBe('#VALUE!');
    expect(value(g, 'B3')).toBe('#ERROR!');
    expect(value(g, 'C3')).toBe('#DIV/0!');
  });
});

describe('TableSheet decorations', () => {
  const table = (rows: string[][]) =>
    `<table>${rows.map((r) => `<tr>${r.map((c) => `<td><p>${c}</p></td>`).join('')}</tr>`).join('')}</table>`;

  it('shows computed values and column/row headers', () => {
    const editor = new Editor({
      extensions: [...schemaExtensions({ collaborative: false }), TableSheet.configure({ headers: true })],
      content: `<p>intro</p>${table([
        ['1', '2', '=A1+B1'],
        ['3', '4', '=SUM(A1:B2)'],
      ])}`,
    });
    const dom = editor.view.dom;
    expect([...dom.querySelectorAll('.bee-formula-value')].map((e) => e.textContent)).toEqual(['3', '10']);
    expect([...dom.querySelectorAll('.bee-sheet-head-col .bee-sheet-label')].map((e) => e.textContent)).toEqual(['A', 'B', 'C']);
    expect([...dom.querySelectorAll('.bee-sheet-head-row .bee-sheet-label')].map((e) => e.textContent)).toEqual(['1', '2']);

    // Putting the cursor in a formula cell reveals the formula instead of the value.
    let c1 = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === '=A1+B1') c1 = pos;
    });
    editor.commands.setTextSelection(c1 + 1);
    expect([...dom.querySelectorAll('.bee-formula-value')].map((e) => e.textContent)).toEqual(['10']);
    expect(dom.querySelector('.bee-formula-editing')?.textContent).toContain('=A1+B1');
    expect(dom.querySelector('.bee-sheet-head-col .is-active')?.textContent).toBe('C');

    // Edits recompute dependents.
    editor.commands.insertContentAt(c1 + 1 + 6, '*10');
    expect(dom.querySelector('.bee-formula-value')?.textContent).toBe('10');
    editor.commands.setTextSelection(1);
    expect([...dom.querySelectorAll('.bee-formula-value')].map((e) => e.textContent)).toEqual(['21', '10']);
    editor.destroy();
  });

  it('omits headers when disabled', () => {
    const editor = new Editor({
      extensions: [...schemaExtensions({ collaborative: false }), TableSheet],
      content: table([['2', '=A1*3']]),
    });
    expect(editor.view.dom.querySelector('.bee-sheet-head')).toBeNull();
    expect(editor.view.dom.querySelector('.bee-formula-value')?.textContent).toBe('6');
    editor.destroy();
  });
});

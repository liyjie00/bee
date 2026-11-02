import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';
import type * as Y from 'yjs';
import {
  cellKey,
  uniqueSheetName,
  writeSheet,
  SHEET_COLUMN_WIDTH,
  SHEET_DEFAULT_COLUMNS,
  SHEET_DEFAULT_ROWS,
  type SheetCell,
  type SheetMerge,
  type SheetStyle,
} from '../../schema/sheet-data.js';
import { newBlockId } from '../../schema/block-id.js';
import { Sheet as FormulaSheet } from '../formula.js';

/** The document's Y.Doc, set on the `sheet` extension's storage by the React layer. */
export const sheetDoc = (editor: Editor): Y.Doc | null =>
  ((editor.storage as unknown as Record<string, { ydoc?: Y.Doc | null } | undefined>).sheet?.ydoc ?? null);

/** Creates an empty sheet (表格1, 表格2…) and inserts its block at the selection. */
export function insertNewSheet(editor: Editor, baseName: string): boolean {
  const ydoc = sheetDoc(editor);
  if (!ydoc) return false;
  const sheetId = newBlockId();
  writeSheet(ydoc, sheetId, { name: uniqueSheetName(ydoc, baseName), meta: { rowCount: SHEET_DEFAULT_ROWS, columnCount: SHEET_DEFAULT_COLUMNS } });
  return editor.chain().focus().insertSheet({ sheetId }).run();
}

/** Same colors as the doc table swatches (styles.css), as Univer needs hex values. */
const CELL_BG: Record<string, string> = {
  gray: '#e8e9e6', red: '#fbdcdc', orange: '#fde3d2', yellow: '#fdf3c4', green: '#d8efe1', blue: '#dbe7f8', purple: '#e9dcf5',
};
const CELL_FG: Record<string, string> = {
  gray: '#6f746c', red: '#c8353a', orange: '#c4520e', yellow: '#9a7a00', green: '#24804f', blue: '#2f64ad', purple: '#723ea3',
};
const ALIGN: Record<string, number> = { left: 1, center: 2, right: 3 };

/** A literal as Univer stores it: numbers as numbers, the rest as text. */
function literal(text: string): SheetCell['v'] {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return text;
}

/**
 * Replaces the doc table at `pos` with a spreadsheet holding the same content: text, `=` formulas,
 * merged cells, header row in bold, column widths, backgrounds, text colors and alignment.
 */
export function convertTableToSheet(editor: Editor, pos: number, baseName: string): boolean {
  const ydoc = sheetDoc(editor);
  const table = editor.state.doc.nodeAt(pos);
  if (!ydoc || !table || table.type.name !== 'table') return false;
  const map = TableMap.get(table);
  const cells: [string, SheetCell][] = [];
  const merges: SheetMerge[] = [];
  const columnData: Record<string, { w: number }> = {};
  const rowData: Record<string, { h: number }> = {};
  const seen = new Set<number>();
  // Formula results from the doc table's own engine, so the block shows values before Univer opens.
  const grid = Array.from({ length: map.height }, (_, r) =>
    Array.from({ length: map.width }, (_, c) => table.nodeAt(map.map[r * map.width + c]!)?.textContent ?? ''),
  );
  const formulas = new FormulaSheet(grid);

  table.forEach((row: PMNode, _offset, r) => {
    if (typeof row.attrs.height === 'number') rowData[r] = { h: row.attrs.height };
  });
  for (let r = 0; r < map.height; r++) {
    for (let c = 0; c < map.width; c++) {
      const offset = map.map[r * map.width + c]!;
      if (seen.has(offset)) continue;
      seen.add(offset);
      const cell = table.nodeAt(offset);
      if (!cell) continue;
      const rect = map.findCell(offset);
      if (rect.right - rect.left > 1 || rect.bottom - rect.top > 1)
        merges.push({ startRow: rect.top, endRow: rect.bottom - 1, startColumn: rect.left, endColumn: rect.right - 1 });
      const widths = cell.attrs.colwidth as number[] | null;
      widths?.forEach((w, i) => {
        if (w) columnData[rect.left + i] = { w };
      });

      const text = cell.textBetween(0, cell.content.size, '\n');
      const style: SheetStyle = {};
      if (cell.type.name === 'tableHeader') style.bl = 1;
      if (cell.attrs.background && CELL_BG[cell.attrs.background]) style.bg = { rgb: CELL_BG[cell.attrs.background] };
      if (cell.attrs.color && CELL_FG[cell.attrs.color]) style.cl = { rgb: CELL_FG[cell.attrs.color] };
      if (cell.attrs.align && ALIGN[cell.attrs.align]) style.ht = ALIGN[cell.attrs.align];
      const data: SheetCell = {};
      if (text.trimStart().startsWith('=') && text.trim().length > 1) {
        data.f = text.trim();
        const value = formulas.evaluate(r, c);
        if (typeof value === 'number' || (typeof value === 'string' && !formulas.isError(r, c))) data.v = value;
      }
      else if (text) data.v = literal(text);
      if (Object.keys(style).length) data.s = style;
      if (Object.keys(data).length) cells.push([cellKey(r, c), data]);
    }
  }

  const sheetId = newBlockId();
  writeSheet(ydoc, sheetId, {
    name: uniqueSheetName(ydoc, baseName),
    meta: {
      rowCount: Math.max(map.height, 1),
      columnCount: Math.max(map.width, 1),
      defaultColumnWidth: SHEET_COLUMN_WIDTH,
      columnData,
      rowData,
      mergeData: merges,
    },
    cells,
  });
  // Same transaction for the swap, so one undo brings the table back.
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.replaceWith(pos, pos + table.nodeSize, editor.schema.nodes.sheet!.create({ sheetId }));
      return true;
    })
    .run();
}

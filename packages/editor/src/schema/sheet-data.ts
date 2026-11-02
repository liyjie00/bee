import * as Y from 'yjs';

/**
 * Spreadsheet blocks keep their data in the host document's Y.Doc, outside the rich text:
 *
 *   Y.Map `sheets`: sheetId → Y.Map {
 *     name:  string             the table's name, used by formulas in other tables (`=预算!D5`)
 *     meta:  Y.Map<json>        Univer worksheet fields: rowCount, columnCount, columnData, rowData, mergeData…
 *     cells: Y.Map<SheetCell>   "row:col" → Univer cell data with styles inlined
 *   }
 *
 * The `sheet` node in the rich text only points at its entry by id, so all tables of a document form
 * one workbook (cross-table formulas are plain sheet references) and versions, access and sharing
 * work like the rest of the document. This module has no Univer dependency: the server uses it too.
 */
export const SHEETS_FIELD = 'sheets';

export type SheetCellValue = string | number | boolean | null;

/** Univer's ICellData with `s` always an inline style object (never a style id). */
export interface SheetCell {
  v?: SheetCellValue;
  f?: string | null;
  si?: string | null;
  s?: SheetStyle | null;
  t?: number | null;
  p?: unknown;
  [key: string]: unknown;
}

/** The parts of Univer's IStyleData that the static view renders. */
export interface SheetStyle {
  bl?: number;
  it?: number;
  ul?: { s?: number };
  st?: { s?: number };
  fs?: number;
  cl?: { rgb?: string | null };
  bg?: { rgb?: string | null };
  /** 1 left, 2 center, 3 right */
  ht?: number;
  /** 1 top, 2 middle, 3 bottom */
  vt?: number;
  n?: { pattern?: string };
  [key: string]: unknown;
}

export interface SheetMerge {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

export interface SheetMeta {
  rowCount: number;
  columnCount: number;
  defaultColumnWidth?: number;
  defaultRowHeight?: number;
  /** column index → { w: width px, hd: hidden } */
  columnData?: Record<string, { w?: number; hd?: number }>;
  /** row index → { h: height px, hd: hidden } */
  rowData?: Record<string, { h?: number; hd?: number }>;
  mergeData?: SheetMerge[];
  [key: string]: unknown;
}

export interface SheetSnapshot {
  id: string;
  name: string;
  meta: SheetMeta;
  /** "row:col" → cell */
  cells: Map<string, SheetCell>;
}

export const SHEET_DEFAULT_ROWS = 8;
export const SHEET_DEFAULT_COLUMNS = 5;
export const SHEET_COLUMN_WIDTH = 110;
export const SHEET_ROW_HEIGHT = 32;
/** Above this many rows an embedded sheet scrolls inside its block. */
export const SHEET_MAX_VISIBLE_ROWS = 20;

export const cellKey = (row: number, col: number) => `${row}:${col}`;
export function parseCellKey(key: string): [number, number] | null {
  const m = /^(\d+):(\d+)$/.exec(key);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export const sheetsMap = (ydoc: Y.Doc) => ydoc.getMap<Y.Map<unknown>>(SHEETS_FIELD);

export function sheetEntry(ydoc: Y.Doc, sheetId: string): Y.Map<unknown> | undefined {
  const entry = ydoc.share.has(SHEETS_FIELD) ? sheetsMap(ydoc).get(sheetId) : undefined;
  return entry instanceof Y.Map ? entry : undefined;
}

const defaultMeta = (): SheetMeta => ({
  rowCount: SHEET_DEFAULT_ROWS,
  columnCount: SHEET_DEFAULT_COLUMNS,
  defaultColumnWidth: SHEET_COLUMN_WIDTH,
  defaultRowHeight: SHEET_ROW_HEIGHT,
});

export function readSheet(ydoc: Y.Doc, sheetId: string): SheetSnapshot | null {
  const entry = sheetEntry(ydoc, sheetId);
  if (!entry) return null;
  const meta = { ...defaultMeta(), ...((entry.get('meta') as Y.Map<unknown> | undefined)?.toJSON() ?? {}) } as SheetMeta;
  const cells = new Map<string, SheetCell>();
  (entry.get('cells') as Y.Map<SheetCell> | undefined)?.forEach((cell, key) => cells.set(key, cell));
  return { id: sheetId, name: String(entry.get('name') ?? ''), meta, cells };
}

/** Names of all sheets in the document, by id. */
export function sheetNames(ydoc: Y.Doc): Map<string, string> {
  const out = new Map<string, string>();
  if (!ydoc.share.has(SHEETS_FIELD)) return out;
  sheetsMap(ydoc).forEach((entry, id) => {
    if (entry instanceof Y.Map) out.set(id, String(entry.get('name') ?? ''));
  });
  return out;
}

/** `base` + the first number that makes it unique among the document's tables: 表格1, 表格2… */
export function uniqueSheetName(ydoc: Y.Doc, base: string): string {
  const taken = new Set([...sheetNames(ydoc).values()].map((n) => n.toLowerCase()));
  for (let i = 1; ; i++) {
    const name = `${base}${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export interface NewSheet {
  name: string;
  meta?: Partial<SheetMeta>;
  cells?: Iterable<[string, SheetCell]>;
}

/** Writes a sheet's entry (replacing any with the same id) in one transaction. */
export function writeSheet(ydoc: Y.Doc, sheetId: string, sheet: NewSheet, origin?: unknown): void {
  ydoc.transact(() => {
    const entry = new Y.Map<unknown>();
    sheetsMap(ydoc).set(sheetId, entry);
    entry.set('name', sheet.name);
    const meta = new Y.Map<unknown>();
    entry.set('meta', meta);
    for (const [k, v] of Object.entries({ ...defaultMeta(), ...sheet.meta })) if (v !== undefined) meta.set(k, v);
    const cells = new Y.Map<SheetCell>();
    entry.set('cells', cells);
    for (const [k, v] of sheet.cells ?? []) cells.set(k, v);
  }, origin);
}

export const columnLetter = (col: number): string => {
  let s = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** A cell's display text, with the common number formats (thousands, decimals, %, currency) applied. */
export function cellText(cell: SheetCell | undefined): string {
  if (!cell) return '';
  if (cell.p && typeof cell.p === 'object') {
    const body = (cell.p as { body?: { dataStream?: string } }).body?.dataStream;
    if (typeof body === 'string') return body.replace(/\r?\n?$/, '').replace(/\r/g, '\n');
  }
  const v = cell.v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const pattern = cell.s?.n?.pattern;
  if (typeof v === 'number' && pattern) return formatNumber(v, pattern);
  if (typeof v === 'number') return String(Math.round(v * 1e10) / 1e10);
  return String(v);
}

/** Enough of Excel's number formats for display: `#,##0.00`, `0%`, `"¥"#,##0`, `$0.0`. */
export function formatNumber(v: number, pattern: string): string {
  const section = pattern.split(';')[0] ?? pattern;
  if (!/[0#]/.test(section)) return String(v);
  const percent = section.includes('%');
  const n = percent ? v * 100 : v;
  const decimals = /\.([0#]+)/.exec(section)?.[1]?.length ?? 0;
  const grouped = /[#0],[#0]/.test(section);
  const body = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouped,
  });
  const literal = (s: string) => s.replace(/"([^"]*)"/g, '$1').replace(/[\\_*]/g, '').replace(/\[[^\]]*\]/g, '');
  const firstDigit = section.search(/[0#]/);
  const lastDigit = Math.max(section.lastIndexOf('0'), section.lastIndexOf('#'));
  const prefix = literal(section.slice(0, firstDigit));
  const suffix = literal(section.slice(lastDigit + 1)).replace('%', '') + (percent ? '%' : '');
  return `${n < 0 ? '-' : ''}${prefix}${body}${suffix}`;
}

/** Display text of every cell, row by row (for Markdown export, search and AI reads). */
export function sheetTextGrid(sheet: SheetSnapshot): string[][] {
  let rows = 0;
  let cols = 0;
  for (const [key, cell] of sheet.cells) {
    const rc = parseCellKey(key);
    if (!rc || !cellText(cell)) continue;
    rows = Math.max(rows, rc[0] + 1);
    cols = Math.max(cols, rc[1] + 1);
  }
  const grid: string[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) row.push(cellText(sheet.cells.get(cellKey(r, c))));
    grid.push(row);
  }
  return grid;
}

/** A sheet name as written in formulas: quoted when it is not a plain identifier. */
export const formulaSheetName = (name: string) => (/^[\p{L}_][\p{L}\p{N}_.]*$/u.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Renames a sheet and rewrites references to it in every formula of the document (`=Old!A1` →
 * `=New!A1`). For when Univer is not open; Univer does the same itself when it is.
 */
export function renameSheet(ydoc: Y.Doc, sheetId: string, name: string, origin?: unknown): void {
  const entry = sheetEntry(ydoc, sheetId);
  if (!entry) return;
  const old = String(entry.get('name') ?? '');
  ydoc.transact(() => {
    entry.set('name', name);
    if (!old) return;
    // Plain or quoted, not preceded by a letter/digit (so "Table1!" does not match "MyTable1!").
    const ref = new RegExp(`(^|[^\\p{L}\\p{N}_'.])(?:${escapeRegExp(old)}|'${escapeRegExp(old.replace(/'/g, "''"))}')!`, 'giu');
    sheetsMap(ydoc).forEach((other) => {
      const cells = other instanceof Y.Map ? (other.get('cells') as Y.Map<SheetCell> | undefined) : undefined;
      cells?.forEach((cell, key) => {
        if (typeof cell.f !== 'string' || !cell.f.includes('!')) return;
        const f = cell.f.replace(ref, (_m, pre: string) => `${pre}${formulaSheetName(name)}!`);
        if (f !== cell.f) cells.set(key, { ...cell, f });
      });
    });
  }, origin);
}

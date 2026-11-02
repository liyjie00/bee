import { Extension } from '@tiptap/core';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { Sheet, columnName, display, isFormula } from './formula.js';

export interface TableSheetOptions {
  /** Show A/B/C column and 1/2/3 row headers around tables (editing only). */
  headers: boolean;
}

const key = new PluginKey<DecorationSet>('tableSheet');

const isCell = (node: PMNode) => {
  const role = node.type.spec.tableRole;
  return role === 'cell' || role === 'header_cell';
};

/** Absolute position of the cell holding a text cursor, or null (cell selections edit no single cell). */
function activeCell(state: EditorState): number | null {
  const sel = state.selection;
  if (sel instanceof CellSelection) return null;
  const $head = sel.$head;
  for (let d = $head.depth; d > 0; d--) if (isCell($head.node(d))) return $head.before(d);
  return null;
}

function headerWidget(kind: 'col' | 'row', labels: { index: number; text: string; active: boolean }[]) {
  return (view: EditorView) => {
    const box = document.createElement('span');
    box.className = `bee-sheet-head bee-sheet-head-${kind}`;
    box.contentEditable = 'false';
    for (const l of labels) {
      const el = document.createElement('span');
      el.className = l.active ? 'bee-sheet-label is-active' : 'bee-sheet-label';
      el.dataset[kind] = String(l.index);
      el.textContent = l.text;
      box.append(el);
    }
    if (!view.editable) box.hidden = true;
    return box;
  };
}

function valueWidget(text: string, error: boolean) {
  return () => {
    const el = document.createElement('span');
    el.className = error ? 'bee-formula-value is-error' : 'bee-formula-value';
    el.contentEditable = 'false';
    el.textContent = text;
    return el;
  };
}

function build(state: EditorState, headers: boolean): DecorationSet {
  const decos: Decoration[] = [];
  const active = activeCell(state);
  state.doc.descendants((table, tablePos) => {
    if (table.type.spec.tableRole !== 'table') return !table.isTextblock;
    const map = TableMap.get(table);
    const start = tablePos + 1;
    // Covered parts of merged cells read as blank; the value sits in the top-left slot.
    const seen = new Set<number>();
    const grid: string[][] = [];
    const cells: { row: number; col: number; pos: number; node: PMNode }[] = [];
    for (let row = 0; row < map.height; row++) {
      const line: string[] = [];
      for (let col = 0; col < map.width; col++) {
        const rel = map.map[row * map.width + col]!;
        if (seen.has(rel)) {
          line.push('');
          continue;
        }
        seen.add(rel);
        const node = table.nodeAt(rel)!;
        line.push(node.textContent);
        cells.push({ row, col, pos: start + rel, node });
      }
      grid.push(line);
    }

    const sheet = new Sheet(grid);
    let activeRect: { top: number; left: number; bottom: number; right: number } | null = null;
    for (const cell of cells) {
      if (cell.pos === active) activeRect = map.findCell(cell.pos - start);
      if (!isFormula(cell.node.textContent)) continue;
      if (cell.pos === active) {
        decos.push(Decoration.node(cell.pos, cell.pos + cell.node.nodeSize, { class: 'bee-formula-editing' }));
        continue;
      }
      const value = sheet.evaluate(cell.row, cell.col);
      const isError = sheet.isError(cell.row, cell.col);
      const text = display(value);
      decos.push(Decoration.node(cell.pos, cell.pos + cell.node.nodeSize, { class: 'bee-formula-cell' }));
      decos.push(Decoration.widget(cell.pos + 1, valueWidget(text, isError), { side: -1, key: `fv:${isError}:${text}` }));
    }

    if (headers) {
      for (const cell of cells) {
        const rect = map.findCell(cell.pos - start);
        if (rect.top === 0) {
          const labels = [];
          for (let c = rect.left; c < rect.right; c++) {
            labels.push({ index: c, text: columnName(c), active: !!activeRect && c >= activeRect.left && c < activeRect.right });
          }
          const k = labels.map((l) => `${l.index}${l.active ? '*' : ''}`).join(',');
          decos.push(Decoration.widget(cell.pos + 1, headerWidget('col', labels), { side: -3, key: `hc:${k}` }));
        }
        if (rect.left === 0) {
          const labels = [];
          for (let r = rect.top; r < rect.bottom; r++) {
            labels.push({ index: r, text: String(r + 1), active: !!activeRect && r >= activeRect.top && r < activeRect.bottom });
          }
          const k = labels.map((l) => `${l.index}${l.active ? '*' : ''}`).join(',');
          decos.push(Decoration.widget(cell.pos + 1, headerWidget('row', labels), { side: -2, key: `hr:${k}` }));
        }
      }
    }
    return false;
  });
  return DecorationSet.create(state.doc, decos);
}

/** Clicking a column letter selects the column; clicking a row number selects the row. */
function selectFromHeader(view: EditorView, target: HTMLElement): boolean {
  const label = target.closest<HTMLElement>('.bee-sheet-label');
  if (!label || !view.editable) return false;
  const pos = view.posAtDOM(label, 0);
  const $pos = view.state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const table = $pos.node(d);
    if (table.type.spec.tableRole !== 'table') continue;
    const start = $pos.start(d);
    const map = TableMap.get(table);
    const col = label.dataset.col;
    const row = label.dataset.row;
    const rel = col !== undefined ? map.map[Number(col)] : map.map[Number(row) * map.width];
    if (rel === undefined) return false;
    const $cell = view.state.doc.resolve(start + rel);
    const sel = col !== undefined ? CellSelection.colSelection($cell) : CellSelection.rowSelection($cell);
    view.dispatch(view.state.tr.setSelection(sel));
    view.focus();
    return true;
  }
  return false;
}

/**
 * Spreadsheet behaviour for tables: cells starting with `=` show their computed value (and the
 * formula while the cursor is in them), and editable tables get A/B/C and 1/2/3 headers.
 * Purely decorations: the document keeps the formula text, so Markdown and collaboration are unaffected.
 */
export const TableSheet = Extension.create<TableSheetOptions>({
  name: 'tableSheet',

  addOptions() {
    return { headers: false };
  },

  addProseMirrorPlugins() {
    const { headers } = this.options;
    return [
      new Plugin({
        key,
        state: {
          init: (_, state) => build(state, headers),
          apply: (tr, old, oldState, newState) => {
            if (!tr.docChanged && activeCell(oldState) === activeCell(newState)) return old;
            return build(newState, headers);
          },
        },
        props: {
          decorations: (state) => key.getState(state),
          attributes: headers ? { class: 'bee-sheet-headers' } : {},
          handleDOMEvents: {
            mousedown: (view, event) => {
              if (!selectFromHeader(view, event.target as HTMLElement)) return false;
              event.preventDefault();
              return true;
            },
          },
        },
      }),
    ];
  },
});

type Command = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;

/** The table around the selection and the column/rows the selection covers. */
export function selectedTable(state: EditorState) {
  const { $from, $to } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const table = $from.node(d);
    if (table.type.spec.tableRole !== 'table') continue;
    const start = $from.start(d);
    const map = TableMap.get(table);
    const cellAt = (pos: number) => {
      const $p = state.doc.resolve(pos);
      for (let k = $p.depth; k > d; k--) if (isCell($p.node(k))) return $p.before(k) - start;
      return null;
    };
    const sel = state.selection;
    const a = sel instanceof CellSelection ? sel.$anchorCell.pos - start : cellAt($from.pos);
    const b = sel instanceof CellSelection ? sel.$headCell.pos - start : cellAt($to.pos);
    const rect = a !== null && b !== null ? map.rectBetween(a, b) : null;
    return { table, pos: start - 1, start, map, rect };
  }
  return null;
}

/**
 * Sorts the table's body rows (rows below leading header rows) by the selected column, using the
 * computed value of formulas. Numbers sort before text; blank cells always go last.
 * Refuses tables with row-spanning cells, whose rows cannot be moved independently.
 */
export function sortTableByColumn(direction: 'asc' | 'desc'): Command {
  return (state, dispatch) => {
    const found = selectedTable(state);
    if (!found?.rect) return false;
    const { table, pos, map, rect } = found;
    let rowSpan = false;
    table.descendants((node) => {
      if (isCell(node) && (node.attrs.rowspan as number) > 1) rowSpan = true;
      return !isCell(node);
    });
    if (rowSpan) return false;

    const rows: PMNode[] = [];
    table.forEach((row) => rows.push(row));
    let head = 0;
    while (head < rows.length && rows[head]!.childCount && everyChild(rows[head]!, (c) => c.type.spec.tableRole === 'header_cell')) head++;
    if (rows.length - head < 2) return false;
    if (!dispatch) return true;

    const grid = rows.map((_, r) =>
      Array.from({ length: map.width }, (_, c) => table.nodeAt(map.map[r * map.width + c]!)!.textContent),
    );
    const sheet = new Sheet(grid);
    const col = rect.left;
    const keyed = rows.slice(head).map((row, i) => ({ row, value: sheet.evaluate(head + i, col) }));
    const rank = (v: unknown) => (v === null || v === '' ? 2 : typeof v === 'number' ? 0 : 1);
    keyed.sort((x, y) => {
      const rx = rank(x.value);
      const ry = rank(y.value);
      if (rx !== ry || rx === 2) return rx - ry;
      const cmp = rx === 0 ? (x.value as number) - (y.value as number) : display(x.value as never).localeCompare(display(y.value as never));
      return direction === 'asc' ? cmp : -cmp;
    });
    const sorted = table.copy(Fragment.from([...rows.slice(0, head), ...keyed.map((k) => k.row)]));
    dispatch(state.tr.replaceWith(pos, pos + table.nodeSize, sorted).scrollIntoView());
    return true;
  };
}

function everyChild(node: PMNode, test: (child: PMNode) => boolean): boolean {
  let ok = true;
  node.forEach((child) => {
    if (!test(child)) ok = false;
  });
  return ok;
}

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

const GRIP_SVG =
  '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 3h8M2 6h8M2 9h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/** The box where the row numbers meet the column letters: click selects the table, drag moves it. */
function cornerWidget(view: EditorView) {
  const box = document.createElement('span');
  box.className = 'bee-sheet-head bee-sheet-corner';
  box.contentEditable = 'false';
  box.innerHTML = GRIP_SVG;
  if (!view.editable) box.hidden = true;
  return box;
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
      const corner = start + map.map[0]!;
      decos.push(Decoration.widget(corner + 1, cornerWidget, { side: -4, key: 'corner' }));
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

/** The table node holding a DOM element inside the editor. */
function tableAt(view: EditorView, el: HTMLElement): { pos: number; node: PMNode } | null {
  const $pos = view.state.doc.resolve(view.posAtDOM(el, 0));
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.spec.tableRole === 'table') return { pos: $pos.before(d), node: $pos.node(d) };
  }
  return null;
}

function selectWholeTable(view: EditorView, tablePos: number) {
  const table = view.state.doc.nodeAt(tablePos);
  if (!table) return;
  const map = TableMap.get(table);
  const start = tablePos + 1;
  const doc = view.state.doc;
  const sel = new CellSelection(doc.resolve(start + map.map[0]!), doc.resolve(start + map.map[map.map.length - 1]!));
  view.dispatch(view.state.tr.setSelection(sel));
  view.focus();
}

/** Where a dragged table may land: the gaps between top-level blocks, with the y of each gap. */
function dropTargets(view: EditorView): { pos: number; y: number; left: number; right: number }[] {
  const out: { pos: number; y: number; left: number; right: number }[] = [];
  let prevBottom: number | null = null;
  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset);
    if (!(dom instanceof HTMLElement)) return;
    const r = dom.getBoundingClientRect();
    out.push({ pos: offset, y: prevBottom === null ? r.top : (prevBottom + r.top) / 2, left: r.left, right: r.right });
    prevBottom = r.bottom;
    if (offset + node.nodeSize === view.state.doc.content.size) {
      out.push({ pos: offset + node.nodeSize, y: r.bottom, left: r.left, right: r.right });
    }
  });
  return out;
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * Pressing the corner grip: a click selects the whole table; dragging past a few pixels picks the
 * table up, shows a line where it will land and moves it there on release (one transaction).
 */
function startGrip(view: EditorView, grip: HTMLElement, event: PointerEvent) {
  const found = tableAt(view, grip);
  if (!found) return;
  const startX = event.clientX;
  const startY = event.clientY;
  const tableDom = grip.closest('table');
  let dragging = false;
  let target: number | null = null;
  let line: HTMLDivElement | null = null;
  let lastY = startY;
  let frame = 0;
  const scroller = scrollParent(view.dom);

  const update = (y: number) => {
    const { pos, node } = found;
    let best: { pos: number; y: number; left: number; right: number } | null = null;
    for (const t of dropTargets(view)) if (!best || Math.abs(t.y - y) < Math.abs(best.y - y)) best = t;
    // Dropping right before or after itself would change nothing.
    target = best && best.pos !== pos && best.pos !== pos + node.nodeSize ? best.pos : null;
    if (!line) {
      line = document.createElement('div');
      line.className = 'bee-table-drop-line';
      document.body.append(line);
    }
    line.hidden = target === null || !best;
    if (best) {
      const editor = view.dom.getBoundingClientRect();
      const left = Math.max(best.left, editor.left);
      line.style.left = `${left}px`;
      line.style.width = `${Math.min(best.right, editor.right) - left}px`;
      line.style.top = `${best.y - 1}px`;
    }
  };
  // Near the top or bottom of the viewport the page scrolls, so a table can travel far.
  const autoScroll = () => {
    const edge = 48;
    const h = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const dy = lastY < h.top + edge ? -12 : lastY > h.bottom - edge ? 12 : 0;
    if (dy) {
      if (scroller) scroller.scrollTop += dy;
      else window.scrollBy(0, dy);
      update(lastY);
    }
    frame = requestAnimationFrame(autoScroll);
  };

  const onMove = (e: PointerEvent) => {
    lastY = e.clientY;
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
      dragging = true;
      tableDom?.classList.add('bee-table-dragging');
      document.body.classList.add('bee-table-grabbing');
      frame = requestAnimationFrame(autoScroll);
    }
    e.preventDefault();
    update(e.clientY);
  };
  const done = (e: PointerEvent) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', done);
    window.removeEventListener('pointercancel', done);
    cancelAnimationFrame(frame);
    (line as HTMLDivElement | null)?.remove();
    tableDom?.classList.remove('bee-table-dragging');
    document.body.classList.remove('bee-table-grabbing');
    if (!view.dom.isConnected) return;
    if (!dragging) {
      selectWholeTable(view, found.pos);
      return;
    }
    if (e.type === 'pointercancel' || target === null) return;
    // The document may have changed under the drag (collaborators): re-find the table by its DOM.
    const now = tableDom && view.dom.contains(tableDom) ? tableAt(view, grip) : null;
    if (!now || now.pos !== found.pos || now.node !== found.node) return;
    const { pos, node } = found;
    const tr = view.state.tr.insert(target, node);
    const from = tr.mapping.map(pos);
    tr.delete(from, from + node.nodeSize);
    const landed = tr.mapping.slice(1).map(target, -1);
    view.dispatch(tr.scrollIntoView());
    selectWholeTable(view, landed);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', done);
  window.addEventListener('pointercancel', done);
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
            pointerdown: (view, event) => {
              const grip = (event.target as HTMLElement).closest<HTMLElement>('.bee-sheet-corner');
              if (!grip || !view.editable || event.button !== 0) return false;
              event.preventDefault();
              startGrip(view, grip, event);
              return true;
            },
            mousedown: (view, event) => {
              // The grip is handled on pointerdown; keep ProseMirror from starting a text selection.
              if ((event.target as HTMLElement).closest('.bee-sheet-corner')) {
                event.preventDefault();
                return true;
              }
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

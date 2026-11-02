import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ROW_MIN_HEIGHT } from '../schema/table-style.js';

/** How close (px) the pointer must be to a row's bottom border to grab it. */
const GRAB = 5;

const key = new PluginKey('rowResize');

interface Drag {
  row: HTMLTableRowElement;
  startY: number;
  startHeight: number;
  height: number;
}

/** The row whose bottom border is under the pointer, if any. */
function rowAtEdge(view: EditorView, event: MouseEvent): HTMLTableRowElement | null {
  const target = event.target as HTMLElement | null;
  const cell = target?.closest?.('td, th');
  const row = cell?.parentElement;
  if (!(row instanceof HTMLTableRowElement) || !view.dom.contains(row)) return null;
  const rect = row.getBoundingClientRect();
  if (Math.abs(event.clientY - rect.bottom) > GRAB || event.clientY - rect.top < GRAB) return null;
  return row;
}

/** Document position of the tableRow node rendered as `row`. */
function rowPos(view: EditorView, row: HTMLTableRowElement): number | null {
  const $pos = view.state.doc.resolve(view.posAtDOM(row, 0));
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.spec.tableRole === 'row') return $pos.before(d);
  return null;
}

/** Height the row takes when only its content decides, measured by briefly clearing its height. */
function naturalHeight(row: HTMLTableRowElement): number {
  const prev = row.style.height;
  row.style.height = '';
  const h = row.getBoundingClientRect().height;
  row.style.height = prev;
  return h;
}

function setHeight(view: EditorView, row: HTMLTableRowElement, height: number | null) {
  const pos = rowPos(view, row);
  if (pos == null) return;
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.attrs.height === height) return;
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, height }));
}

/**
 * Drag a table row's bottom border to give it a minimum height; rows otherwise fit their text.
 * Dragging back up to (or above) the text's own height, or double-clicking the border, returns
 * the row to fitting its text. The height lives on the tableRow node, so it syncs like any edit.
 */
export const RowResize = Extension.create({
  name: 'rowResize',

  addProseMirrorPlugins() {
    let line: HTMLDivElement | null = null;
    let hover: HTMLTableRowElement | null = null;
    let drag: Drag | null = null;

    const showLine = (row: HTMLTableRowElement, bottom: number) => {
      const table = row.closest('table')!.getBoundingClientRect();
      const wrapper = row.closest('.tableWrapper')?.getBoundingClientRect() ?? table;
      if (!line) {
        line = document.createElement('div');
        line.className = 'bee-row-resize-line';
        document.body.append(line);
      }
      const left = Math.max(table.left, wrapper.left);
      line.style.left = `${left}px`;
      line.style.width = `${Math.min(table.right, wrapper.right) - left}px`;
      line.style.top = `${bottom - 1}px`;
    };
    const hideLine = () => {
      line?.remove();
      line = null;
    };
    const setHover = (view: EditorView, row: HTMLTableRowElement | null) => {
      hover = row;
      view.dom.classList.toggle('bee-row-resize-cursor', !!row);
      if (row) showLine(row, row.getBoundingClientRect().bottom);
      else hideLine();
    };

    const onMove = (event: MouseEvent) => {
      if (!drag) return;
      drag.height = Math.max(ROW_MIN_HEIGHT, drag.startHeight + event.clientY - drag.startY);
      showLine(drag.row, drag.row.getBoundingClientRect().top + drag.height);
    };
    const finish = (view: EditorView) => {
      window.removeEventListener('mousemove', onMove);
      const d = drag;
      drag = null;
      setHover(view, null);
      if (!d || d.height === d.startHeight || !view.dom.isConnected) return;
      const natural = naturalHeight(d.row);
      setHeight(view, d.row, d.height <= natural + 1 ? null : Math.round(d.height));
    };

    return [
      new Plugin({
        key,
        props: {
          handleDOMEvents: {
            mousemove(view, event) {
              if (drag || !view.editable) return false;
              // The column resize handle wins at a cell's bottom-right corner.
              const row = view.dom.classList.contains('resize-cursor') ? null : rowAtEdge(view, event);
              if (row !== hover) setHover(view, row);
              else if (row) showLine(row, row.getBoundingClientRect().bottom);
              return false;
            },
            mouseleave(view) {
              if (!drag && hover) setHover(view, null);
              return false;
            },
            mousedown(view, event) {
              if (event.button !== 0 || !view.editable || view.dom.classList.contains('resize-cursor')) return false;
              const row = hover ?? rowAtEdge(view, event);
              if (!row) return false;
              event.preventDefault();
              const height = row.getBoundingClientRect().height;
              drag = { row, startY: event.clientY, startHeight: height, height };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', () => finish(view), { once: true });
              return true;
            },
            dblclick(view, event) {
              const row = hover ?? rowAtEdge(view, event);
              if (!row || !view.editable) return false;
              event.preventDefault();
              setHeight(view, row, null);
              setHover(view, null);
              return true;
            },
          },
        },
        view: () => ({
          destroy() {
            window.removeEventListener('mousemove', onMove);
            hideLine();
          },
        }),
      }),
    ];
  },
});

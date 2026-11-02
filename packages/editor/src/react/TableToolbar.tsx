import type { Editor } from '@tiptap/react';
import { CellSelection } from '@tiptap/pm/tables';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CELL_COLORS, type CellAlign, type CellColor } from '../schema/table-style.js';
import { selectedTable, sortTableByColumn } from './table-sheet.js';
import type { Messages } from './i18n.js';

type Menu = 'row' | 'col' | 'bg' | 'fg' | null;

/** Floating toolbar above the table holding the cursor: rows/columns, merge, colors, alignment, sort, delete. */
export function TableToolbar({ editor, messages: t }: { editor: Editor; messages: Messages }) {
  const [place, setPlace] = useState<{ top: number; left: number; tablePos: number } | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [, rerender] = useState(0);
  const lastTable = useRef<number | null>(null);

  useEffect(() => {
    const update = () => {
      const found = editor.isEditable ? selectedTable(editor.state) : null;
      const dom = found ? (editor.view.nodeDOM(found.pos) as HTMLElement | null) : null;
      const wrapper = (editor.view.dom as HTMLElement).closest('.bee-editor') as HTMLElement | null;
      if (!found || !dom || !wrapper) {
        lastTable.current = null;
        setPlace(null);
        setMenu(null);
        return;
      }
      const box = (dom.closest?.('.tableWrapper') as HTMLElement | null) ?? dom;
      const table = box.querySelector('table') ?? box;
      const base = wrapper.getBoundingClientRect();
      const rect = table.getBoundingClientRect();
      if (lastTable.current !== found.pos) setMenu(null);
      lastTable.current = found.pos;
      setPlace({ top: box.getBoundingClientRect().top - base.top, left: rect.left - base.left, tablePos: found.pos });
      rerender((n) => n + 1);
    };
    update();
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor]);

  if (!place) return null;
  const run = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => {
    fn(editor.chain().focus()).run();
    setMenu(null);
  };
  const can = editor.can();
  const sel = editor.state.selection;
  const cellAttr = (name: string) => {
    const found = selectedTable(editor.state);
    if (!found?.rect) return null;
    const node = found.table.nodeAt(found.map.map[found.rect.top * found.map.width + found.rect.left]!);
    return (node?.attrs[name] as string | null) ?? null;
  };
  const align = cellAttr('align');

  const button = (label: string, onClick: () => void, content: ReactNode, opts: { active?: boolean; disabled?: boolean; danger?: boolean } = {}) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={opts.disabled}
      className={[opts.active && 'is-active', opts.danger && 'is-danger'].filter(Boolean).join(' ') || undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {content}
    </button>
  );
  const item = (label: string, onClick: () => void, disabled = false) => (
    <button type="button" className="bee-table-menu-item" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {label}
    </button>
  );
  const toggle = (m: Exclude<Menu, null>) => setMenu((cur) => (cur === m ? null : m));
  const swatches = (attr: 'background' | 'color') => (
    <div className="bee-table-menu bee-table-swatches">
      <button
        type="button"
        className="bee-swatch is-none"
        title={t.tableColorNone}
        aria-label={t.tableColorNone}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run((c) => c.setCellAttribute(attr, null))}
      />
      {CELL_COLORS.map((color: CellColor) => (
        <button
          key={color}
          type="button"
          className={`bee-swatch bee-swatch-${attr === 'background' ? 'bg' : 'fg'}`}
          data-swatch={color}
          title={t[`color_${color}`]}
          aria-label={t[`color_${color}`]}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run((c) => c.setCellAttribute(attr, color))}
        >
          {attr === 'color' ? 'A' : null}
        </button>
      ))}
    </div>
  );
  const setAlign = (a: CellAlign) => run((c) => c.setCellAttribute('align', align === a ? null : a));

  return (
    <div className="bee-table-toolbar" style={{ top: place.top, left: place.left }} onMouseDown={(e) => e.preventDefault()}>
      <div className="bee-table-group">
        {button(t.tableRow, () => toggle('row'), <>{t.tableRow} ▾</>, { active: menu === 'row' })}
        {menu === 'row' && (
          <div className="bee-table-menu">
            {item(t.tableRowAbove, () => run((c) => c.addRowBefore()))}
            {item(t.tableRowBelow, () => run((c) => c.addRowAfter()))}
            {item(t.tableHeaderRow, () => run((c) => c.toggleHeaderRow()))}
            {item(t.tableDeleteRow, () => run((c) => c.deleteRow()), !can.deleteRow())}
          </div>
        )}
      </div>
      <div className="bee-table-group">
        {button(t.tableCol, () => toggle('col'), <>{t.tableCol} ▾</>, { active: menu === 'col' })}
        {menu === 'col' && (
          <div className="bee-table-menu">
            {item(t.tableColLeft, () => run((c) => c.addColumnBefore()))}
            {item(t.tableColRight, () => run((c) => c.addColumnAfter()))}
            {item(t.tableSortAsc, () => run((c) => c.command(({ state, dispatch }) => sortTableByColumn('asc')(state, dispatch))))}
            {item(t.tableSortDesc, () => run((c) => c.command(({ state, dispatch }) => sortTableByColumn('desc')(state, dispatch))))}
            {item(t.tableHeaderCol, () => run((c) => c.toggleHeaderColumn()))}
            {item(t.tableDeleteCol, () => run((c) => c.deleteColumn()), !can.deleteColumn())}
          </div>
        )}
      </div>
      {(() => {
        const label = sel instanceof CellSelection ? t.tableMerge : t.tableSplit;
        return button(label, () => run((c) => c.mergeOrSplit()), label, { disabled: !can.mergeOrSplit() });
      })()}
      <span className="bee-bubble-sep" />
      <div className="bee-table-group">
        {button(t.tableBackground, () => toggle('bg'), <span className="bee-table-icon-bg">A</span>, { active: menu === 'bg' })}
        {menu === 'bg' && swatches('background')}
      </div>
      <div className="bee-table-group">
        {button(t.tableTextColor, () => toggle('fg'), <span className="bee-table-icon-fg">A</span>, { active: menu === 'fg' })}
        {menu === 'fg' && swatches('color')}
      </div>
      {button(t.alignLeft, () => setAlign('left'), <AlignIcon kind="left" />, { active: align === 'left' })}
      {button(t.alignCenter, () => setAlign('center'), <AlignIcon kind="center" />, { active: align === 'center' })}
      {button(t.alignRight, () => setAlign('right'), <AlignIcon kind="right" />, { active: align === 'right' })}
      <span className="bee-bubble-sep" />
      {button(t.tableDelete, () => run((c) => c.deleteTable()), <TrashIcon />, { danger: true })}
    </div>
  );
}

function AlignIcon({ kind }: { kind: CellAlign }) {
  const x = (w: number) => (kind === 'left' ? 2 : kind === 'right' ? 14 - w : 8 - w / 2);
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      {[12, 8, 12, 6].map((w, i) => (
        <rect key={i} x={x(w)} y={2.5 + i * 3.2} width={w} height={1.6} rx={0.8} fill="currentColor" />
      ))}
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5" />
    </svg>
  );
}

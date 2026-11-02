import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type * as Y from 'yjs';
import {
  cellKey,
  cellText,
  readSheet,
  renameSheet,
  sheetEntry,
  sheetNames,
  sheetsMap,
  uniqueSheetName,
  writeSheet,
  SHEET_COLUMN_WIDTH,
  SHEET_MAX_VISIBLE_ROWS,
  SHEET_ROW_HEIGHT,
  SHEETS_FIELD,
  type SheetCell,
  type SheetSnapshot,
} from '../../schema/sheet-data.js';
import { BLOCK_ID_ATTR } from '../../schema/block-id.js';
import { useBeeEditorContext } from '../context.js';
import { useMessages } from '../i18n.js';
import { blockLink } from '../blocks.js';
import { mountSheetEditor, type SheetEditor } from './univer-binding.js';

/** The Y.Doc whose `sheets` map holds the data of the document's spreadsheet blocks. */
export const SheetDocContext = createContext<Y.Doc | null>(null);

// ---- which sheet is being edited (one at a time per page: Univer is heavy) ---------------------
let activeKey: string | null = null;
const activeListeners = new Set<() => void>();
function setActive(key: string | null) {
  if (activeKey === key) return;
  activeKey = key;
  for (const l of activeListeners) l();
}
const subscribeActive = (l: () => void) => {
  activeListeners.add(l);
  return () => activeListeners.delete(l);
};

/** Re-renders when the sheet's data (or its existence) changes. */
function useSheet(ydoc: Y.Doc | null, sheetId: string | null): SheetSnapshot | null {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!ydoc) return;
    const map = sheetsMap(ydoc);
    const bump = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      if (events.some((e) => e.path.length === 0 ? e.changes.keys.has(sheetId ?? '') : e.path[0] === sheetId)) setVersion((v) => v + 1);
    };
    map.observeDeep(bump);
    return () => map.unobserveDeep(bump);
  }, [ydoc, sheetId]);
  return useMemo(() => (ydoc && sheetId ? readSheet(ydoc, sheetId) : null), [ydoc, sheetId, version]);
}

/** Sheet ids of the document's spreadsheet blocks, in document order. */
function docSheetIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'sheet' && typeof node.attrs.sheetId === 'string' && !ids.includes(node.attrs.sheetId)) ids.push(node.attrs.sheetId);
    return node.isBlock;
  });
  return ids;
}

const colWidth = (s: SheetSnapshot, c: number) => s.meta.columnData?.[c]?.w ?? s.meta.defaultColumnWidth ?? SHEET_COLUMN_WIDTH;
const rowHeight = (s: SheetSnapshot, r: number) => s.meta.rowData?.[r]?.h ?? s.meta.defaultRowHeight ?? SHEET_ROW_HEIGHT;
const INVALID_NAME = /[[\]:\\/?*']/;

/** Univer's chrome around the rows: ribbon, formula bar, column header and scrollbar (measured). */
const UNIVER_CHROME = 176;
const ROW_HEADER_WIDTH = 46;

/** Spreadsheet block: a static table until clicked, then a Univer editor bound to the document. */
export function SheetView({ node, editor, selected }: ReactNodeViewProps) {
  const ctx = useBeeEditorContext();
  const t = useMessages();
  const ydoc = useContext(SheetDocContext);
  const sheetId = (node.attrs.sheetId as string | null) ?? null;
  const blockId = node.attrs[BLOCK_ID_ATTR] as string | null;
  // Not editor.isEditable: node views are not re-rendered when the editor becomes editable after sync.
  const editable = !!ctx?.editable;
  const sheet = useSheet(ydoc, sheetId);

  // A key per node view, so two blocks showing the same sheet don't both mount Univer.
  const [viewKey] = useState(() => `${sheetId}:${Math.random().toString(36).slice(2)}`);
  const active = useSyncExternalStore(subscribeActive, () => activeKey === viewKey) && editable;
  const [fullscreen, setFullscreen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<SheetEditor | null>(null);

  // A block inserted from Markdown or another client before its data arrived: editors create it.
  useEffect(() => {
    if (!ydoc || !sheetId || !editable || sheetEntry(ydoc, sheetId)) return;
    const timer = setTimeout(() => {
      if (!sheetEntry(ydoc, sheetId)) writeSheet(ydoc, sheetId, { name: uniqueSheetName(ydoc, t.sheetBaseName) });
    }, 1500);
    return () => clearTimeout(timer);
  }, [ydoc, sheetId, editable, sheet, t.sheetBaseName]);

  // Mount Univer while active.
  useEffect(() => {
    if (!active || !ydoc || !sheetId || !host.current) return;
    let cancelled = false;
    let mounted: SheetEditor | null = null;
    setLoading(true);
    setError(null);
    const container = host.current;
    mountSheetEditor({
      container,
      ydoc,
      sheetIds: docSheetIds(editor),
      activeSheetId: sheetId,
      locale: ctx?.locale === 'zh-CN' ? 'zh-CN' : 'en',
      dark: ctx?.theme === 'dark',
    })
      .then((m) => {
        if (cancelled) return m.dispose();
        mounted = m;
        handle.current = m;
        setLoading(false);
      })
      .catch((err: unknown) => {
        console.error('[bee] spreadsheet failed to load', err);
        if (!cancelled) {
          setLoading(false);
          setError(t.sheetLoadError);
        }
      });
    // Tables added to or removed from the document change the workbook.
    const onUpdate = () => handle.current?.setSheets(docSheetIds(editor));
    editor.on('update', onUpdate);
    return () => {
      cancelled = true;
      editor.off('update', onUpdate);
      mounted?.dispose();
      handle.current = null;
      container.replaceChildren();
    };
  }, [active, ydoc, sheetId, editor, ctx?.locale]);

  useEffect(() => handle.current?.setDark(ctx?.theme === 'dark'), [ctx?.theme]);

  // Leave edit mode when clicking anywhere else (Univer's menus and dialogs render in the body).
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || wrapper.current?.contains(target)) return;
      if (target.closest('[class*="univer-"]')) return;
      setActive(null);
      setFullscreen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [active]);
  useEffect(() => () => {
    if (activeKey === viewKey) setActive(null);
  }, [viewKey]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement | null)?.closest?.('[class*="univer-"]')) setFullscreen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fullscreen]);

  const activate = useCallback(() => {
    if (!editable || !sheet) return;
    setActive(viewKey);
    // Phones edit full screen: the inline grid is too small to work in.
    if (typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches) setFullscreen(true);
  }, [editable, sheet, viewKey]);

  const commitRename = () => {
    const name = renaming?.trim();
    setRenaming(null);
    if (!name || !ydoc || !sheetId || !sheet || name === sheet.name) return;
    if (INVALID_NAME.test(name)) return setError(t.sheetNameInvalid);
    const taken = [...sheetNames(ydoc)].some(([id, n]) => id !== sheetId && n.toLowerCase() === name.toLowerCase());
    if (taken) return setError(t.sheetNameTaken);
    setError(null);
    // Through Univer when it is open, so formulas that reference the old name are rewritten too.
    if (handle.current) handle.current.rename(sheetId, name);
    else renameSheet(ydoc, sheetId, name);
  };

  const copyLink = async () => {
    if (!blockId || !ctx) return;
    try {
      await navigator.clipboard.writeText(blockLink(window.location.origin, ctx.documentId, blockId, ctx.shareToken));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: nothing useful to show.
    }
  };

  const height = useMemo(() => {
    if (!sheet) return 200;
    let h = 0;
    for (let r = 0; r < Math.min(sheet.meta.rowCount, SHEET_MAX_VISIBLE_ROWS); r++) h += rowHeight(sheet, r);
    return h + UNIVER_CHROME;
  }, [sheet]);
  const gridWidth = useMemo(() => {
    if (!sheet) return 0;
    let w = ROW_HEADER_WIDTH + 16;
    for (let c = 0; c < sheet.meta.columnCount; c++) w += colWidth(sheet, c);
    return w;
  }, [sheet]);

  return (
    <NodeViewWrapper
      ref={wrapper}
      className={`bee-ss${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}${fullscreen ? ' is-fullscreen' : ''}`}
      data-drag-handle
    >
      <div className="bee-ss-frame">
      <div className="bee-ss-header" contentEditable={false} style={active && !fullscreen ? { maxWidth: gridWidth } : undefined}>
        <span className="bee-ss-grip" aria-hidden>
          ⋮⋮
        </span>
        {renaming !== null ? (
          <input
            className="bee-ss-name-input"
            value={renaming}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            aria-label={t.sheetRename}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(null);
            }}
          />
        ) : (
          <button
            type="button"
            className="bee-ss-name"
            title={editable ? t.sheetRename : undefined}
            disabled={!editable || !sheet}
            onClick={() => sheet && setRenaming(sheet.name)}
          >
            {sheet?.name || t.sheet}
          </button>
        )}
        {error ? <span className="bee-ss-error">{error}</span> : editable && !active && <span className="bee-ss-hint">{t.sheetEditHint}</span>}
        <span className="bee-ss-tools">
          {blockId && ctx && (
            <button type="button" className="bee-embed-icon" title={copied ? t.copied : t.sheetCopyLink} aria-label={t.sheetCopyLink} onClick={copyLink}>
              {copied ? '✓' : '#'}
            </button>
          )}
          {active && (
            <button
              type="button"
              className="bee-embed-icon"
              title={fullscreen ? t.sheetExitFullscreen : t.sheetFullscreen}
              aria-label={fullscreen ? t.sheetExitFullscreen : t.sheetFullscreen}
              aria-pressed={fullscreen}
              onClick={() => setFullscreen((f) => !f)}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                {fullscreen ? <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" /> : <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />}
              </svg>
            </button>
          )}
          {active ? (
            <button type="button" className="bee-ss-done" onClick={() => (setActive(null), setFullscreen(false))}>
              {t.sheetDone}
            </button>
          ) : (
            editable &&
            sheet && (
              <button type="button" className="bee-ss-done" onClick={activate}>
                {t.sheetEdit}
              </button>
            )
          )}
        </span>
      </div>
      {active ? (
        <div className="bee-ss-editor" contentEditable={false} style={{ height: fullscreen ? undefined : height, maxWidth: fullscreen ? undefined : gridWidth }}>
          <div ref={host} className="bee-ss-univer" />
          {loading && <div className="bee-ss-loading">{t.sheetLoading}</div>}
        </div>
      ) : sheet ? (
        <div className="bee-ss-static" contentEditable={false} onClick={activate}>
          <SheetTable sheet={sheet} />
        </div>
      ) : (
        <div className="bee-ss-loading" contentEditable={false}>
          {ydoc && sheetId && !ydoc.share.has(SHEETS_FIELD) ? t.sheetLoading : t.sheetMissing}
        </div>
      )}
      </div>
    </NodeViewWrapper>
  );
}

const H_ALIGN: Record<number, CSSProperties['textAlign']> = { 1: 'left', 2: 'center', 3: 'right' };
const V_ALIGN: Record<number, CSSProperties['verticalAlign']> = { 1: 'top', 2: 'middle', 3: 'bottom' };

function cellStyle(cell: SheetCell | undefined): CSSProperties {
  const s = cell?.s;
  const style: CSSProperties = {};
  const numeric = typeof cell?.v === 'number';
  style.textAlign = (s?.ht && H_ALIGN[s.ht]) || (numeric ? 'right' : undefined);
  if (s?.vt && V_ALIGN[s.vt]) style.verticalAlign = V_ALIGN[s.vt];
  if (s?.bl) style.fontWeight = 600;
  if (s?.it) style.fontStyle = 'italic';
  const deco = [s?.ul?.s ? 'underline' : '', s?.st?.s ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) style.textDecoration = deco;
  if (s?.fs) style.fontSize = `${s.fs}pt`;
  if (s?.cl?.rgb) style.color = s.cl.rgb;
  if (s?.bg?.rgb) style.background = s.bg.rgb;
  if (numeric) style.fontVariantNumeric = 'tabular-nums';
  return style;
}

/** Read-only rendering of a sheet from its stored values; no Univer needed. */
export function SheetTable({ sheet }: { sheet: SheetSnapshot }) {
  const { rowCount, columnCount, mergeData = [] } = sheet.meta;
  const covered = new Set<string>();
  const spans = new Map<string, { rowSpan: number; colSpan: number }>();
  for (const m of mergeData) {
    spans.set(cellKey(m.startRow, m.startColumn), { rowSpan: m.endRow - m.startRow + 1, colSpan: m.endColumn - m.startColumn + 1 });
    for (let r = m.startRow; r <= m.endRow; r++)
      for (let c = m.startColumn; c <= m.endColumn; c++) if (r !== m.startRow || c !== m.startColumn) covered.add(cellKey(r, c));
  }
  const cols = Array.from({ length: columnCount }, (_, c) => c).filter((c) => !sheet.meta.columnData?.[c]?.hd);
  const rows = Array.from({ length: rowCount }, (_, r) => r).filter((r) => !sheet.meta.rowData?.[r]?.hd);
  const width = cols.reduce((w, c) => w + colWidth(sheet, c), 0);
  return (
    <table className="bee-ss-table" style={{ width }}>
      <colgroup>
        {cols.map((c) => (
          <col key={c} style={{ width: colWidth(sheet, c) }} />
        ))}
      </colgroup>
      <tbody>
        {rows.map((r) => (
          <tr key={r} style={{ height: rowHeight(sheet, r) }}>
            {cols.map((c) => {
              const key = cellKey(r, c);
              if (covered.has(key)) return null;
              const cell = sheet.cells.get(key);
              const span = spans.get(key);
              return (
                <td key={c} rowSpan={span?.rowSpan} colSpan={span?.colSpan} style={cellStyle(cell)}>
                  {cellText(cell)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

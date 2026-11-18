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
import { loadUniver, mountSheetEditor, type SheetEditor } from './univer-binding.js';

/** The Y.Doc whose `sheets` map holds the data of the document's spreadsheet blocks. */
export const SheetDocContext = createContext<Y.Doc | null>(null);

// ---- which sheet is being edited (one at a time per page: Univer is heavy) ---------------------
// The last edited (or hovered) sheet keeps its Univer instance, hidden, so opening it again is
// instant instead of rebuilding Univer and showing its loading skeleton every time.
let activeKey: string | null = null;
let warmKey: string | null = null;
const activeListeners = new Set<() => void>();
const notifyActive = () => {
  for (const l of activeListeners) l();
};
function setActive(key: string | null) {
  if (activeKey === key && (key === null || warmKey === key)) return;
  activeKey = key;
  if (key) warmKey = key;
  notifyActive();
}
function setWarm(key: string | null) {
  if (warmKey === key) return;
  warmKey = key;
  notifyActive();
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

const ROW_HEADER_WIDTH = 46;
const COLUMN_HEADER_HEIGHT = 20;
/** Below the last row: horizontal scrollbar and border. */
const UNIVER_BOTTOM = 14;
/**
 * Univer's chrome above the rows (toolbar, formula bar, column header). It depends on the width
 * (the toolbar wraps), so it is measured once Univer has drawn and remembered for the page.
 */
let measuredChromeTop = 82;
/** Univer's hidden cell editor, which holds the keyboard focus while a sheet is being edited. */
const UNIVER_CELL_EDITOR = '[id="__editor___INTERNAL_EDITOR__DOCS_NORMAL"]';

/** Top of the first row inside the editing box, from the position of Univer's grid canvas. */
function measureChromeTop(box: HTMLElement): number | null {
  const top = box.getBoundingClientRect().top;
  let best: HTMLCanvasElement | null = null;
  for (const c of box.querySelectorAll('canvas')) if (!best || c.clientHeight * c.clientWidth > best.clientHeight * best.clientWidth) best = c;
  if (!best || !best.clientHeight) return null;
  const y = best.getBoundingClientRect().top - top + COLUMN_HEADER_HEIGHT;
  return y > COLUMN_HEADER_HEIGHT && y < 400 ? Math.round(y) : null;
}

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
  const warm = useSyncExternalStore(subscribeActive, () => warmKey === viewKey) && editable;
  const mounted = active || warm;
  const [fullscreen, setFullscreen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [chromeTop, setChromeTop] = useState(measuredChromeTop);
  const box = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<SheetEditor | null>(null);
  // Width of the editing box, fixed when editing starts: following the columns live made the
  // centered box (and the grid under the pointer) jump sideways after every column resize.
  const [editWidth, setEditWidth] = useState<number | null>(null);

  // Editors fetch Univer ahead of the first click (it is a few MB), so editing opens at once.
  const preload = useCallback(() => {
    void loadUniver(ctx?.locale === 'zh-CN' ? 'zh-CN' : 'en').catch(() => undefined);
  }, [ctx?.locale]);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onPointerEnter = useCallback(() => {
    if (!editable) return;
    preload();
    // Resting on a sheet builds its (hidden) editor, so the click that follows opens it at once.
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      if (activeKey === null && sheet) setWarm(viewKey);
    }, 200);
  }, [editable, preload, sheet, viewKey]);
  const onPointerLeave = useCallback(() => clearTimeout(hoverTimer.current), []);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  useEffect(() => {
    if (!editable || !sheetId) return;
    const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) {
      const id = idle(preload, { timeout: 4000 });
      return () => (window as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(id);
    }
    const timer = setTimeout(preload, 1500);
    return () => clearTimeout(timer);
  }, [editable, sheetId, preload]);

  // A block inserted from Markdown or another client before its data arrived: editors create it.
  useEffect(() => {
    if (!ydoc || !sheetId || !editable || sheetEntry(ydoc, sheetId)) return;
    const timer = setTimeout(() => {
      if (!sheetEntry(ydoc, sheetId)) writeSheet(ydoc, sheetId, { name: uniqueSheetName(ydoc, t.sheetBaseName) });
    }, 1500);
    return () => clearTimeout(timer);
  }, [ydoc, sheetId, editable, sheet, t.sheetBaseName]);

  // Mount Univer while active (or kept warm).
  useEffect(() => {
    if (!mounted || !ydoc || !sheetId || !host.current) return;
    let cancelled = false;
    let instance: SheetEditor | null = null;
    setReady(false);
    setError(null);
    // A fresh element per instance: Univer unmounts its React tree asynchronously, so the old
    // one is removed only after that (clearing it right away crashed React's removeChild).
    const container = document.createElement('div');
    container.className = 'bee-ss-univer-root';
    host.current.appendChild(container);
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
        instance = m;
        handle.current = m;
        // Our placeholder stays over Univer's own skeleton until the grid is drawn.
        void m.rendered.then(() => {
          if (cancelled) return;
          // Fit the box to Univer's real chrome (hidden while warm, so the change is not seen).
          const y = box.current && measureChromeTop(box.current);
          if (y) setChromeTop((measuredChromeTop = y));
          setReady(true);
        });
      })
      .catch((err: unknown) => {
        console.error('[bee] spreadsheet failed to load', err);
        if (!cancelled) {
          setError(t.sheetLoadError);
          if (activeKey === viewKey) setActive(null);
          if (warmKey === viewKey) setWarm(null);
        }
      });
    // Tables added to or removed from the document change the workbook.
    const onUpdate = () => handle.current?.setSheets(docSheetIds(editor));
    editor.on('update', onUpdate);
    return () => {
      cancelled = true;
      editor.off('update', onUpdate);
      const old = instance;
      handle.current = null;
      setReady(false);
      // Not during React's commit (the node view may be unmounting): Univer renders with React too.
      setTimeout(() => {
        old?.dispose();
        setTimeout(() => container.remove(), 0);
      }, 0);
    };
  }, [mounted, ydoc, sheetId, editor, ctx?.locale]);

  // Keyboard focus belongs to Univer only while editing. A hidden (warm) instance grabs focus when
  // it is created, which would swallow what the person types in the document: hand it back.
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const el = host.current;
    if (!mounted || !el) return;
    let outside: HTMLElement | null = document.activeElement as HTMLElement | null;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      // Univer focuses its cell editor before moving it into the container.
      if (!el.contains(target) && !target.matches?.(UNIVER_CELL_EDITOR)) {
        outside = target;
        return;
      }
      if (activeRef.current) return;
      target.blur();
      const back = outside;
      // Not from inside this focus event: the browser ignores it there.
      setTimeout(() => {
        const now = document.activeElement;
        if (activeRef.current || (now && now !== document.body && !el.contains(now))) return;
        if (back && editor.view.dom.contains(back)) editor.view.focus();
        else back?.focus({ preventScroll: true });
      }, 0);
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, [mounted, editor]);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (active && ready) {
      // Opening a warm instance: give it the keyboard, as a fresh one takes it by itself. After the
      // click that opened it is fully handled (ProseMirror focuses the document on mouseup).
      const focus = () => {
        if (!el.contains(document.activeElement)) el.querySelector<HTMLElement>(UNIVER_CELL_EDITOR)?.focus({ preventScroll: true });
      };
      focus();
      const timer = setTimeout(focus, 0);
      return () => clearTimeout(timer);
    } else if (!active) {
      // Leaving edit mode keeps Univer alive but hidden: save a cell edit in progress, drop focus.
      void handle.current?.endEditing();
      const focused = document.activeElement as HTMLElement | null;
      if (focused && el.contains(focused)) focused.blur();
    }
  }, [active, ready]);

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
    if (warmKey === viewKey) setWarm(null);
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
    return h + chromeTop + UNIVER_BOTTOM;
  }, [sheet, chromeTop]);
  const gridWidth = useMemo(() => {
    if (!sheet) return 0;
    let w = ROW_HEADER_WIDTH + 16;
    for (let c = 0; c < sheet.meta.columnCount; c++) w += colWidth(sheet, c);
    return w;
  }, [sheet]);
  // Freeze the box width for the whole edit session (see editWidth).
  useEffect(() => {
    if (active && editWidth === null && gridWidth) setEditWidth(gridWidth);
    if (!active && editWidth !== null) setEditWidth(null);
  }, [active, editWidth, gridWidth]);
  const boxWidth = editWidth ?? gridWidth;

  return (
    <NodeViewWrapper
      ref={wrapper}
      className={`bee-ss${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}${fullscreen ? ' is-fullscreen' : ''}`}
      data-drag-handle
      onPointerEnter={editable ? onPointerEnter : undefined}
      onPointerLeave={editable ? onPointerLeave : undefined}
    >
      <div className="bee-ss-frame">
      <div className="bee-ss-header" contentEditable={false} style={active && !fullscreen ? { maxWidth: boxWidth } : undefined}>
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
      {mounted && (
        <div
          ref={box}
          className={`bee-ss-editor${active ? '' : ' is-warm'}`}
          contentEditable={false}
          aria-hidden={!active || undefined}
          style={{ height: fullscreen ? undefined : height, maxWidth: fullscreen ? undefined : boxWidth }}
        >
          <div ref={host} className="bee-ss-univer" />
          {active && !ready && (
            // The table stays visible where Univer will draw its grid, instead of a blank box.
            <div className="bee-ss-placeholder" aria-busy>
              <div className="bee-ss-placeholder-bar">{t.sheetLoading}</div>
              {sheet && (
                <div className="bee-ss-placeholder-grid" style={{ paddingLeft: ROW_HEADER_WIDTH, paddingTop: chromeTop }}>
                  <SheetTable sheet={sheet} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {active ? null : sheet ? (
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

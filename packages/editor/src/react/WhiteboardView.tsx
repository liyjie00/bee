import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BeeWhiteboard, type WhiteboardHandle } from './Whiteboard.js';
import { useBeeEditorContext } from './context.js';
import { useMessages } from './i18n.js';
import { formatWhiteboardView, parseWhiteboardView, WHITEBOARD_DEFAULT_HEIGHT, type WhiteboardAlign, type WhiteboardView as WhiteboardViewRange } from '../schema/whiteboard.js';

const MIN_WIDTH = 20;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 1600;

/** Per-viewer memory of the last range shown in an embed, so a reload comes back to it. */
const localViewKey = (documentId: string) => `bee:wb-view:${documentId}`;
function readLocalView(documentId: string | null): WhiteboardViewRange | null {
  if (!documentId) return null;
  try {
    return parseWhiteboardView(localStorage.getItem(localViewKey(documentId)));
  } catch {
    return null;
  }
}
function writeLocalView(documentId: string | null, v: WhiteboardViewRange | null) {
  if (!documentId) return;
  try {
    if (v && v.w > 0 && v.h > 0) localStorage.setItem(localViewKey(documentId), formatWhiteboardView(v));
    else localStorage.removeItem(localViewKey(documentId));
  } catch {
    // Storage unavailable (private mode): the embed just falls back to its saved range.
  }
}

/** Touch screens: a one-finger drag on an embedded board should scroll the document, not pan the board. */
const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

const ALIGN_ICONS: Record<WhiteboardAlign, string> = { left: '⇤', center: '↔', right: '⇥' };

/** Embedded whiteboard: a live view of a separate whiteboard document. */
export function WhiteboardView({ node, selected, updateAttributes }: ReactNodeViewProps) {
  const ctx = useBeeEditorContext();
  const t = useMessages();
  const documentId = node.attrs.documentId as string | null;
  const linked = !!node.attrs.linked;
  const align = (['left', 'right'].includes(node.attrs.align as string) ? node.attrs.align : 'center') as WhiteboardAlign;
  const view = parseWhiteboardView(node.attrs.view);
  const title = (linked && documentId && ctx?.whiteboardTitle?.(documentId)) || t.whiteboardTitle;
  const editable = !!ctx?.editable;
  const wrapper = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const board = useRef<WhiteboardHandle | null>(null);
  const onHandle = useCallback((h: WhiteboardHandle | null) => (board.current = h), []);
  // Size while dragging the resize handle; written to the node on release.
  const [draft, setDraft] = useState<{ width: number; height: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [touch] = useState(coarsePointer);
  // Read once: later pans and zooms only go to storage, so they never re-place the board.
  const [localView, setLocalView] = useState(() => readLocalView(documentId));
  const width = draft?.width ?? Math.min(100, Math.max(MIN_WIDTH, Number(node.attrs.width) || 100));
  const height = draft?.height ?? (Number(node.attrs.height) || WHITEBOARD_DEFAULT_HEIGHT);

  // Excalidraw pans on every wheel event, which trapped the page scroll on the board. Let plain wheel
  // events scroll the document; pinch / ctrl+wheel still zooms the board.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    };
    el.addEventListener('wheel', onWheel, { capture: true });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  // Remember where this viewer left the board (drag to pan, pinch / ctrl+wheel to zoom).
  useEffect(() => {
    const el = body.current;
    if (!el || fullscreen) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remember = () => {
      clearTimeout(timer);
      timer = setTimeout(() => writeLocalView(documentId, board.current?.getView() ?? null), 400);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) remember();
    };
    el.addEventListener('pointerup', remember);
    el.addEventListener('wheel', onWheel);
    return () => {
      clearTimeout(timer);
      el.removeEventListener('pointerup', remember);
      el.removeEventListener('wheel', onWheel);
    };
  }, [documentId, fullscreen]);
  const forgetLocalView = () => {
    writeLocalView(documentId, null);
    setLocalView(null);
  };

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = wrapper.current;
    const container = el?.parentElement;
    if (!el || !container) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, w: el.offsetWidth, h: height, total: container.clientWidth || el.offsetWidth };
    // The handle sits on the free side; a centred embed grows on both sides.
    const dir = align === 'right' ? -1 : 1;
    const factor = align === 'center' ? 2 : 1;
    let last = { width, height };
    const move = (ev: PointerEvent) => {
      const w = start.w + dir * factor * (ev.clientX - start.x);
      last = {
        width: Math.round(Math.min(100, Math.max(MIN_WIDTH, (w / start.total) * 100))),
        height: Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, start.h + ev.clientY - start.y))),
      };
      setDraft(last);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      updateAttributes(last);
      setDraft(null);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  // Full screen fills the window (not the Fullscreen API, which embedded webviews ignore) and shows
  // the whole drawing; the saved range comes back on exit (Esc or the button).
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fullscreen]);
  const toggleFullscreen = () => setFullscreen((f) => !f);

  const saveView = () => {
    const v = board.current?.getView();
    if (v && v.w > 0 && v.h > 0) {
      forgetLocalView();
      updateAttributes({ view: formatWhiteboardView(v) });
    }
  };

  return (
    <NodeViewWrapper
      ref={wrapper}
      className={`bee-embed bee-embed-whiteboard${selected ? ' is-selected' : ''}${draft ? ' is-resizing' : ''}${fullscreen ? ' is-fullscreen' : ''}`}
      style={{ width: `${width}%`, marginLeft: align === 'left' ? 0 : 'auto', marginRight: align === 'right' ? 0 : 'auto' }}
      data-drag-handle
    >
      <div className="bee-embed-header" contentEditable={false}>
        <span className="bee-embed-title">{title}</span>
        {editable && <span className="bee-embed-hint">{t.linkedWhiteboardHint}</span>}
        <span className="bee-embed-tools">
          {editable && (
            <>
              {(['left', 'center', 'right'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  className={`bee-embed-icon${align === a ? ' is-active' : ''}`}
                  title={t[`embedAlign_${a}`]}
                  aria-label={t[`embedAlign_${a}`]}
                  aria-pressed={align === a}
                  onClick={() => updateAttributes({ align: a })}
                >
                  {ALIGN_ICONS[a]}
                </button>
              ))}
              <button type="button" className="bee-embed-icon" title={t.whiteboardSetViewHint} aria-label={t.whiteboardSetView} onClick={saveView}>
                ⛶
              </button>
              {view && (
                <button type="button" className="bee-embed-icon" title={t.whiteboardResetView} aria-label={t.whiteboardResetView} onClick={() => {
                    forgetLocalView();
                    updateAttributes({ view: null });
                  }}>
                  ⤢
                </button>
              )}
            </>
          )}
          {documentId && (
            <button
              type="button"
              className="bee-embed-icon bee-embed-fit"
              title={t.whiteboardFitAll}
              aria-label={t.whiteboardFitAll}
              onClick={() => {
                board.current?.fitAll();
                // Excalidraw applies the new zoom/scroll in a later render; read it after that.
                setTimeout(() => writeLocalView(documentId, board.current?.getView() ?? null), 100);
              }}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
                <path d="M1.5 4V1.5H4M12 1.5h2.5V4M1.5 12v2.5H4M12 14.5h2.5V12" />
              </svg>
            </button>
          )}
          {documentId && (
            <button
              type="button"
              className={`bee-embed-icon bee-embed-fullscreen${fullscreen ? ' is-active' : ''}`}
              title={fullscreen ? t.whiteboardExitFullscreen : t.whiteboardFullscreen}
              aria-label={fullscreen ? t.whiteboardExitFullscreen : t.whiteboardFullscreen}
              aria-pressed={fullscreen}
              onClick={toggleFullscreen}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                {fullscreen ? (
                  <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
                ) : (
                  <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
                )}
              </svg>
            </button>
          )}
          {documentId && ctx?.onOpenWhiteboard && (
            <button type="button" className="bee-embed-action" title={t.openWhiteboard} onClick={() => ctx.onOpenWhiteboard!(documentId)}>
              <span className="bee-embed-action-icon" aria-hidden>
                ↗
              </span>
              <span className="bee-embed-action-label">{t.openWhiteboard}</span>
            </button>
          )}
        </span>
      </div>
      <div ref={body} className="bee-embed-body" contentEditable={false} style={{ height }}>
        {documentId && ctx ? (
          <BeeWhiteboard
            documentId={documentId}
            collabUrl={ctx.collabUrl}
            shareToken={ctx.shareToken}
            user={ctx.user}
            // Read-only in documents (pan and zoom only); edits happen on the whiteboard page.
            editable={false}
            locale={ctx.locale}
            theme={ctx.theme}
            embedded
            // Without a saved range the embed always shows the whole drawing.
            fitContent
            view={fullscreen ? null : (localView ?? view)}
            onHandle={onHandle}
          />
        ) : (
          <div className="bee-whiteboard-loading">{t.whiteboardMissing}</div>
        )}
        {documentId && touch && !fullscreen && (
          <button type="button" className="bee-embed-shield" onClick={() => setFullscreen(true)}>
            <span>{t.whiteboardTapToOpen}</span>
          </button>
        )}
      </div>
      {editable && (
        <div
          className={`bee-embed-resize bee-embed-resize-${align === 'right' ? 'left' : 'right'}`}
          contentEditable={false}
          draggable={false}
          title={t.embedResize}
          onPointerDown={startResize}
          onMouseDown={(e) => e.preventDefault()}
          onDragStart={(e) => e.preventDefault()}
        />
      )}
    </NodeViewWrapper>
  );
}

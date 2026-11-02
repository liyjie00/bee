import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BeeWhiteboard, type WhiteboardHandle } from './Whiteboard.js';
import { useBeeEditorContext } from './context.js';
import { useMessages } from './i18n.js';
import { formatWhiteboardView, parseWhiteboardView, WHITEBOARD_DEFAULT_HEIGHT, type WhiteboardAlign } from '../schema/whiteboard.js';

const MIN_WIDTH = 20;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 1600;

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

  const saveView = () => {
    const v = board.current?.getView();
    if (v && v.w > 0 && v.h > 0) updateAttributes({ view: formatWhiteboardView(v) });
  };

  return (
    <NodeViewWrapper
      ref={wrapper}
      className={`bee-embed bee-embed-whiteboard${selected ? ' is-selected' : ''}${draft ? ' is-resizing' : ''}`}
      style={{ width: `${width}%`, marginLeft: align === 'left' ? 0 : 'auto', marginRight: align === 'right' ? 0 : 'auto' }}
      data-drag-handle
    >
      <div className="bee-embed-header" contentEditable={false}>
        <span className="bee-embed-title">{title}</span>
        {linked && editable && <span className="bee-embed-hint">{t.linkedWhiteboardHint}</span>}
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
                <button type="button" className="bee-embed-icon" title={t.whiteboardResetView} aria-label={t.whiteboardResetView} onClick={() => updateAttributes({ view: null })}>
                  ⤢
                </button>
              )}
            </>
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
            editable={ctx.editable && !linked}
            locale={ctx.locale}
            theme={ctx.theme}
            embedded
            fitContent={linked}
            view={view}
            onHandle={onHandle}
          />
        ) : (
          <div className="bee-whiteboard-loading">{t.whiteboardMissing}</div>
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

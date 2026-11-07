import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useMessages } from './i18n.js';

/** What the lightbox shows: an image URL, or sanitized SVG markup (Mermaid). */
export type LightboxContent = { src: string; alt?: string } | { svg: string; alt?: string };

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const STEP = 1.25;
/** Space kept around the fitted image, in px. */
const MARGIN = 48;

interface View {
  scale: number;
  x: number;
  y: number;
}

/** Natural size of SVG markup from its viewBox (Mermaid sets width="100%"). */
function svgSize(svg: string): { width: number; height: number } | null {
  const box = /viewBox="([^"]+)"/.exec(svg)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (!box || box.length !== 4 || !(box[2]! > 0) || !(box[3]! > 0)) return null;
  return { width: box[2]!, height: box[3]! };
}

/** Full-window viewer: wheel / pinch / buttons zoom, drag pans, Esc or a click outside closes. */
export function Lightbox({ content, onClose }: { content: LightboxContent; onClose: () => void }) {
  const t = useMessages();
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(() => ('svg' in content ? svgSize(content.svg) : null));
  const [fit, setFit] = useState(1);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const vector = 'svg' in content;

  // Fit inside the window; vectors may scale up (small diagrams), bitmaps never past 100%.
  const computeFit = useCallback(() => {
    const el = stage.current;
    if (!el || !size) return 1;
    const f = Math.min((el.clientWidth - MARGIN * 2) / size.width, (el.clientHeight - MARGIN * 2) / size.height);
    return Math.max(MIN_SCALE, Math.min(vector ? 3 : 1, f));
  }, [size, vector]);

  useLayoutEffect(() => {
    if (!size) return;
    const f = computeFit();
    setFit(f);
    setView({ scale: f, x: 0, y: 0 });
  }, [size, computeFit]);

  useEffect(() => {
    const onResize = () => setFit(computeFit());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [computeFit]);

  /** Zooms to `scale` keeping the point (px from the stage centre) under the cursor still. */
  const zoomTo = useCallback((scale: number, at = { x: 0, y: 0 }) => {
    const v = viewRef.current;
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    const k = s / v.scale;
    setView({ scale: s, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k });
  }, []);
  const reset = useCallback(() => setView({ scale: fit, x: 0, y: 0 }), [fit]);

  const fromCentre = (clientX: number, clientY: number) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') zoomTo(viewRef.current.scale * STEP);
      else if (e.key === '-') zoomTo(viewRef.current.scale / STEP);
      else if (e.key === '0') reset();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, zoomTo, reset]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Trackpad pinch arrives as ctrl+wheel with small deltas; a mouse wheel notch is ~100.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      zoomTo(viewRef.current.scale * factor, fromCentre(e.clientX, e.clientY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // Pointers: one drags, two pinch. A click that did not move closes when it lands outside the image.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; pinch?: { dist: number; scale: number } } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.bee-lightbox-tools')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) gesture.current = { moved: false };
    else if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.pinch = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), scale: viewRef.current.scale };
      gesture.current.moved = true;
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    const g = gesture.current;
    if (!prev || !g) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pinch && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const mid = fromCentre((a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
      zoomTo((g.pinch.scale * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / g.pinch.dist, mid);
      return;
    }
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    if (!g.moved && Math.hypot(dx, dy) < 3) {
      pointers.current.set(e.pointerId, prev);
      return;
    }
    g.moved = true;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (pointers.current.size > 0) {
      if (g) g.pinch = undefined;
      return;
    }
    gesture.current = null;
    if (g && !g.moved && e.type === 'pointerup' && !(e.target as HTMLElement).closest('.bee-lightbox-content')) onClose();
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    if (!(e.target as HTMLElement).closest('.bee-lightbox-content')) return;
    if (Math.abs(viewRef.current.scale - fit) > 0.01) reset();
    else zoomTo(Math.max(fit * 2, vector ? fit * 2 : 1), fromCentre(e.clientX, e.clientY));
  };

  const label = content.alt || t.lightboxTitle;
  const body =
    'svg' in content ? (
      <div className="bee-lightbox-svg" dangerouslySetInnerHTML={{ __html: content.svg }} />
    ) : (
      <img
        src={content.src}
        alt={content.alt ?? ''}
        draggable={false}
        onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth || 1, height: e.currentTarget.naturalHeight || 1 })}
      />
    );

  return createPortal(
    <div className="bee-lightbox" role="dialog" aria-modal="true" aria-label={label}>
      <div
        ref={stage}
        className="bee-lightbox-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        <div
          className={`bee-lightbox-content${size ? '' : ' is-loading'}`}
          style={
            size
              ? { width: size.width, height: size.height, transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})` }
              : undefined
          }
        >
          {body}
        </div>
      </div>
      <div className="bee-lightbox-tools">
        <button type="button" title={t.zoomOut} aria-label={t.zoomOut} onClick={() => zoomTo(view.scale / STEP)}>
          −
        </button>
        <button type="button" className="bee-lightbox-pct" title={t.zoomReset} aria-label={t.zoomReset} onClick={reset}>
          {Math.round(view.scale * 100)}%
        </button>
        <button type="button" title={t.zoomIn} aria-label={t.zoomIn} onClick={() => zoomTo(view.scale * STEP)}>
          +
        </button>
        <span className="bee-lightbox-sep" />
        <button type="button" title={t.lightboxClose} aria-label={t.lightboxClose} onClick={onClose}>
          ✕
        </button>
      </div>
    </div>,
    document.body,
  );
}

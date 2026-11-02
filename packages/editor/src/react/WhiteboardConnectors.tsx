import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

type ExcalidrawModule = typeof import('@excalidraw/excalidraw');
type ExcalidrawAPI = Parameters<
  NonNullable<import('@excalidraw/excalidraw/types').ExcalidrawProps['excalidrawAPI']>
>[0];
type AppState = ReturnType<ExcalidrawAPI['getAppState']>;
type SceneElement = Parameters<ExcalidrawModule['reconcileElements']>[0][number];

/** Shapes that get connection dots and that arrows can bind to. */
const CONNECTABLE = new Set(['rectangle', 'ellipse', 'diamond']);
/** Scene-unit distance between a bound arrow's end and the shape outline. */
const GAP = 6;
/** How far (screen px) around a shape the pointer still counts as hovering it. */
const HOVER_MARGIN = 36;
/** Arrow length (scene units) when a dot is clicked without dragging. */
const CLICK_ARROW = 120;

type Side = 'top' | 'right' | 'bottom' | 'left';
const SIDES: Record<Side, [number, number]> = {
  top: [0, -1],
  right: [1, 0],
  bottom: [0, 1],
  left: [-1, 0],
};

interface Pt {
  x: number;
  y: number;
}

const center = (el: SceneElement): Pt => ({ x: el.x + el.width / 2, y: el.y + el.height / 2 });

function rotate(p: Pt, c: Pt, angle: number): Pt {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** Whether a scene point lies within the element's (rotated) box grown by `margin`. */
function contains(el: SceneElement, p: Pt, margin: number): boolean {
  const c = center(el);
  const local = rotate(p, c, -el.angle);
  return (
    Math.abs(local.x - c.x) <= el.width / 2 + margin &&
    Math.abs(local.y - c.y) <= el.height / 2 + margin
  );
}

/** The point `gap` outside the element's outline on the ray from its center toward `toward`. */
function outlinePoint(el: SceneElement, toward: Pt, gap: number): Pt {
  const c = center(el);
  const local = rotate(toward, c, -el.angle);
  let dx = local.x - c.x;
  let dy = local.y - c.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const hw = Math.max(el.width / 2, 1);
  const hh = Math.max(el.height / 2, 1);
  const t =
    el.type === 'ellipse'
      ? 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh))
      : el.type === 'diamond'
        ? 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
        : Math.min(
            Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity,
            Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity,
          );
  return rotate({ x: c.x + dx * (t + gap), y: c.y + dy * (t + gap) }, c, el.angle);
}

/** Midpoint of one side of the element, pushed `offset` scene units outward. */
function sidePoint(el: SceneElement, side: Side, offset: number): Pt {
  const c = center(el);
  const [sx, sy] = SIDES[side];
  return rotate(
    { x: c.x + sx * (el.width / 2 + offset), y: c.y + sy * (el.height / 2 + offset) },
    c,
    el.angle,
  );
}

function topmostShapeAt(
  elements: readonly SceneElement[],
  p: Pt,
  margin: number,
  except?: string,
): SceneElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]!;
    if (el.isDeleted || el.locked || el.id === except || !CONNECTABLE.has(el.type)) continue;
    if (contains(el, p, margin)) return el;
  }
  return null;
}

interface Drag {
  sourceId: string;
  side: Side;
  arrowId: string;
  start: Pt;
  moved: boolean;
  targetId: string | null;
}

interface Props {
  api: ExcalidrawAPI;
  mod: ExcalidrawModule;
}

/**
 * Connection dots: hovering a box, ellipse or diamond shows a dot on each side. Pressing one starts an
 * arrow bound to that shape; dropping it on another shape binds the other end too, so Excalidraw's
 * own binding logic keeps both ends attached when either shape moves. A plain click leaves a short
 * arrow pointing out of that side.
 */
export function WhiteboardConnectors({ api, mod }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [, setTick] = useState(0);

  // Re-render on scroll / zoom / scene edits so the dots stay on their shape.
  useEffect(() => {
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTick((n) => n + 1));
    };
    const offChange = api.onChange(refresh);
    const offScroll = api.onScrollChange(refresh);
    return () => {
      cancelAnimationFrame(frame);
      offChange();
      offScroll();
    };
  }, [api]);

  const toScene = useCallback(
    (clientX: number, clientY: number, state: AppState): Pt => {
      const p = mod.viewportCoordsToSceneCoords({ clientX, clientY }, state);
      return { x: p.x, y: p.y };
    },
    [mod],
  );

  const idle = (state: AppState) =>
    state.activeTool.type === 'selection' &&
    !state.editingTextElement &&
    !state.newElement &&
    !state.viewModeEnabled;

  // Track which shape the pointer is near. Listens on the whole board because the dots themselves
  // sit outside the shape, on top of the canvas.
  useEffect(() => {
    const host = layer.current?.parentElement;
    if (!host) return;
    const onMove = (e: PointerEvent) => {
      if (dragRef.current) return;
      const state = api.getAppState();
      if (e.buttons !== 0 || !idle(state)) {
        setHoverId(null);
        return;
      }
      const p = toScene(e.clientX, e.clientY, state);
      const el = topmostShapeAt(api.getSceneElements(), p, HOVER_MARGIN / state.zoom.value);
      setHoverId(el?.id ?? null);
    };
    const onLeave = () => !dragRef.current && setHoverId(null);
    host.addEventListener('pointermove', onMove, { capture: true });
    host.addEventListener('pointerleave', onLeave);
    return () => {
      host.removeEventListener('pointermove', onMove, { capture: true });
      host.removeEventListener('pointerleave', onLeave);
    };
  }, [api, toScene]);

  /**
   * Patches elements (by id) in the scene, bumping their versions so they sync. In-drag updates are not
   * recorded in undo history; the finished arrow is.
   */
  const replace = useCallback(
    (
      changes: Map<string, Record<string, unknown>>,
      added: SceneElement[],
      capture: 'never' | 'now',
    ) => {
      const next = api.getSceneElementsIncludingDeleted().map((el: SceneElement) => {
        const patch = changes.get(el.id);
        return patch ? mod.newElementWith(el as never, patch as never) : el;
      });
      api.updateScene({
        elements: [...next, ...added] as never,
        captureUpdate:
          capture === 'now' ? mod.CaptureUpdateAction.IMMEDIATELY : mod.CaptureUpdateAction.NEVER,
      });
    },
    [api, mod],
  );

  const arrowGeometry = (start: Pt, end: Pt) => ({
    x: start.x,
    y: start.y,
    points: [
      [0, 0],
      [end.x - start.x, end.y - start.y],
    ],
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  });

  const onDotDown = (e: ReactPointerEvent, source: SceneElement, side: Side) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const state = api.getAppState();
    const start = sidePoint(source, side, GAP);
    const [arrow] = mod.convertToExcalidrawElements([
      {
        type: 'arrow',
        x: start.x,
        y: start.y,
        width: 1,
        height: 0,
        strokeColor: state.currentItemStrokeColor,
        strokeWidth: state.currentItemStrokeWidth,
        strokeStyle: state.currentItemStrokeStyle,
        roughness: state.currentItemRoughness,
        roundness: state.currentItemArrowType === 'round' ? { type: 2 } : null,
        opacity: state.currentItemOpacity,
        startArrowhead: state.currentItemStartArrowhead,
        endArrowhead: state.currentItemEndArrowhead,
      } as never,
    ]);
    if (!arrow) return;
    const [dx, dy] = SIDES[side];
    const tip = rotate({ x: start.x + dx * 1, y: start.y + dy * 1 }, start, source.angle);
    const shaped = {
      ...arrow,
      ...arrowGeometry(start, tip),
      startBinding: { elementId: source.id, focus: 0, gap: GAP },
    };
    replace(new Map(), [shaped as SceneElement], 'never');
    const next = {
      sourceId: source.id,
      side,
      arrowId: arrow.id,
      start,
      moved: false,
      targetId: null,
    };
    dragRef.current = next;
    setDrag(next);
    // The dot unmounts once dragging starts, so follow the pointer on the window.
    const move = (ev: PointerEvent) => onDragMove(ev);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      onDragEnd(ev);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  };

  const onDragMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const state = api.getAppState();
    const p = toScene(e.clientX, e.clientY, state);
    const moved = d.moved || Math.hypot(p.x - d.start.x, p.y - d.start.y) * state.zoom.value > 8;
    if (!moved) return;
    const target = topmostShapeAt(api.getSceneElements(), p, 4 / state.zoom.value, d.sourceId);
    replace(new Map([[d.arrowId, arrowGeometry(d.start, p)]]), [], 'never');
    const next = { ...d, moved, targetId: target?.id ?? null };
    dragRef.current = next;
    setDrag(next);
  };

  const onDragEnd = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    e.stopPropagation();
    dragRef.current = null;
    setDrag(null);
    const elements = api.getSceneElements();
    const source = elements.find((el: SceneElement) => el.id === d.sourceId);
    const target = d.targetId
      ? elements.find((el: SceneElement) => el.id === d.targetId)
      : undefined;
    if (!source) return;
    const changes = new Map<string, Record<string, unknown>>();
    const bindArrow = (el: SceneElement) => ({
      boundElements: [
        ...(el.boundElements ?? []).filter((b: { id: string }) => b.id !== d.arrowId),
        { id: d.arrowId, type: 'arrow' },
      ],
    });
    changes.set(source.id, bindArrow(source));
    if (target) {
      // Both ends aim at the other shape's center, which is where Excalidraw keeps a focus-0 binding.
      const start = outlinePoint(source, center(target), GAP);
      const end = outlinePoint(target, center(source), GAP);
      changes.set(d.arrowId, {
        ...arrowGeometry(start, end),
        startBinding: { elementId: source.id, focus: 0, gap: GAP },
        endBinding: { elementId: target.id, focus: 0, gap: GAP },
      });
      changes.set(target.id, bindArrow(target));
    } else if (!d.moved) {
      const [dx, dy] = SIDES[d.side];
      const end = rotate(
        { x: d.start.x + dx * CLICK_ARROW, y: d.start.y + dy * CLICK_ARROW },
        d.start,
        source.angle,
      );
      changes.set(d.arrowId, arrowGeometry(d.start, end));
    }
    // Drop the in-progress arrow unrecorded and add the finished one, so one undo removes it whole.
    const all = api.getSceneElementsIncludingDeleted();
    const arrow = all.find((el: SceneElement) => el.id === d.arrowId);
    if (!arrow) return;
    api.updateScene({
      elements: all.filter((el: SceneElement) => el.id !== d.arrowId) as never,
      captureUpdate: mod.CaptureUpdateAction.NEVER,
    });
    replace(
      changes,
      [mod.newElementWith(arrow as never, (changes.get(d.arrowId) ?? {}) as never)],
      'now',
    );
    api.updateScene({ appState: { selectedElementIds: { [d.arrowId]: true } } as never });
    setHoverId(null);
  };

  const state = api.getAppState();
  const elements = api.getSceneElements();
  const hovered =
    !drag && hoverId && idle(state)
      ? elements.find((el: SceneElement) => el.id === hoverId)
      : undefined;
  const target = drag?.targetId
    ? elements.find((el: SceneElement) => el.id === drag.targetId)
    : undefined;
  const box = layer.current?.getBoundingClientRect();

  const toLayer = (p: Pt) => {
    const v = mod.sceneCoordsToViewportCoords({ sceneX: p.x, sceneY: p.y }, state);
    return { left: v.x - (box?.left ?? 0), top: v.y - (box?.top ?? 0) };
  };

  // Keep the dots clear of Excalidraw's own resize and rotate handles when the shape is selected.
  const selected = hovered ? state.selectedElementIds[hovered.id] : false;
  const offsetFor = (side: Side) => (selected ? (side === 'top' ? 40 : 22) : 14) / state.zoom.value;

  return (
    <div ref={layer} className="bee-wb-connectors">
      {hovered &&
        (Object.keys(SIDES) as Side[]).map((side) => (
          <button
            key={side}
            type="button"
            className="bee-wb-dot"
            aria-label={`connect ${side}`}
            style={toLayer(sidePoint(hovered, side, offsetFor(side)))}
            onPointerDown={(e) => onDotDown(e, hovered, side)}
          />
        ))}
      {target && <TargetOutline el={target} toLayer={toLayer} zoom={state.zoom.value} />}
    </div>
  );
}

function TargetOutline({
  el,
  toLayer,
  zoom,
}: {
  el: SceneElement;
  toLayer: (p: Pt) => { left: number; top: number };
  zoom: number;
}) {
  const c = toLayer(center(el));
  const pad = 6;
  return (
    <div
      className={`bee-wb-target bee-wb-target-${el.type}`}
      style={{
        left: c.left,
        top: c.top,
        width: el.width * zoom + pad * 2,
        height: el.height * zoom + pad * 2,
        transform: `translate(-50%, -50%) rotate(${el.angle}rad)`,
      }}
    />
  );
}

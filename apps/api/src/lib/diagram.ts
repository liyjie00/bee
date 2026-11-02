import { randomBytes, randomInt } from 'node:crypto';

/**
 * Turns a node/edge diagram into Excalidraw elements for a Bee whiteboard (Y.Map `elements`
 * keyed by element id): shapes with their label bound as container text, and arrows bound to
 * the shapes they connect, so moving a shape in the editor drags its arrows along.
 */

export type Shape = 'rectangle' | 'ellipse' | 'diamond';

export interface DiagramNode {
  id: string;
  label: string;
  shape?: Shape;
  /** fill color (#rrggbb or an Excalidraw palette name) */
  color?: string;
  x?: number;
  y?: number;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}

export interface Diagram {
  nodes: DiagramNode[];
  edges?: DiagramEdge[];
  direction?: 'down' | 'right';
}

/** Excalidraw element, kept loose: the whiteboard stores whatever Excalidraw produces. */
export type Element = Record<string, unknown> & {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  isDeleted: boolean;
  index?: string | null;
};

const FONT_SIZE = 20;
const LINE_HEIGHT = 1.25;
const FONT_FAMILY = 5; // Excalifont, Excalidraw's default hand-drawn font
const LAYER_GAP = 90;
const SIBLING_GAP = 50;

/** Light fills from Excalidraw's palette, by name. */
const COLORS: Record<string, string> = {
  white: '#ffffff',
  gray: '#e9ecef',
  red: '#ffc9c9',
  pink: '#fcc2d7',
  grape: '#eebefa',
  violet: '#d0bfff',
  blue: '#a5d8ff',
  cyan: '#99e9f2',
  teal: '#96f2d7',
  green: '#b2f2bb',
  yellow: '#ffec99',
  orange: '#ffd8a8',
};

const newId = () => randomBytes(15).toString('base64url').slice(0, 20);

/** Rough rendered width of a line (CJK and other wide characters count double). */
function textWidth(line: string, size = FONT_SIZE) {
  let w = 0;
  for (const ch of line) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 1 : 0.55;
  return Math.ceil(w * size);
}

function base(type: string, x: number, y: number, width: number, height: number): Element {
  return {
    id: newId(),
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: randomInt(1, 2 ** 31 - 1),
    version: 1,
    versionNonce: randomInt(1, 2 ** 31 - 1),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
    index: null,
  };
}

function textElement(text: string, cx: number, cy: number, containerId: string | null): Element {
  const lines = text.split('\n');
  const width = Math.max(...lines.map((l) => textWidth(l)), 1);
  const height = lines.length * FONT_SIZE * LINE_HEIGHT;
  return {
    ...base('text', cx - width / 2, cy - height / 2, width, height),
    text,
    originalText: text,
    fontSize: FONT_SIZE,
    fontFamily: FONT_FAMILY,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
  };
}

// ---------- fractional indices (Excalidraw orders elements by these keys) ----------

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** The integer part of a fractional-indexing key ("a0", "b1Z", ...). */
function integerPart(key: string): string {
  const head = key[0]!;
  if (head < 'a' || head > 'z') return 'a0';
  return key.slice(0, head.charCodeAt(0) - 'a'.charCodeAt(0) + 2);
}

/** The next integer key after `key`, which sorts after `key` and any key starting with it. */
function nextKey(key: string): string {
  const int = integerPart(key);
  const digits = int.slice(1).split('');
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]!);
    if (d < DIGITS.length - 1) {
      digits[i] = DIGITS[d + 1]!;
      return int[0] + digits.join('');
    }
    digits[i] = '0';
  }
  // Overflow: one more digit, e.g. "az" -> "b00".
  return String.fromCharCode(int.charCodeAt(0) + 1) + '0'.repeat(digits.length + 1);
}

/** Assigns increasing indices to `elements`, after every index already on the board. */
export function assignIndices(existing: Element[], elements: Element[]) {
  const max = existing
    .map((e) => e.index)
    .filter((i): i is string => typeof i === 'string' && /^[a-z]/.test(i))
    .sort()
    .pop();
  let key = max ? nextKey(max) : 'a0';
  for (const el of elements) {
    el.index = key;
    key = nextKey(key);
  }
}

// ---------- layout ----------

interface Box {
  node: DiagramNode;
  width: number;
  height: number;
  x: number;
  y: number;
}

/** Layered layout: each node goes one layer below its deepest parent (cycles are broken). */
function layout(d: Diagram, origin: { x: number; y: number }): Map<string, Box> {
  const boxes = new Map<string, Box>();
  for (const n of d.nodes) {
    const lines = n.label.split('\n');
    const tw = Math.max(...lines.map((l) => textWidth(l)), 20);
    const th = lines.length * FONT_SIZE * LINE_HEIGHT;
    const pad = n.shape === 'diamond' ? 2 : n.shape === 'ellipse' ? 1.5 : 1;
    boxes.set(n.id, {
      node: n,
      width: Math.max(160, Math.ceil(tw * pad + 40)),
      height: Math.max(70, Math.ceil(th * pad + 30)),
      x: 0,
      y: 0,
    });
  }
  const parents = new Map<string, string[]>();
  for (const e of d.edges ?? []) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ps = (parents.get(id) ?? []).filter((p) => boxes.has(p) && p !== id);
    const v = ps.length ? Math.max(...ps.map(depth)) + 1 : 0;
    visiting.delete(id);
    layer.set(id, v);
    return v;
  };
  const layers: Box[][] = [];
  for (const n of d.nodes) (layers[depth(n.id)] ??= []).push(boxes.get(n.id)!);

  const down = (d.direction ?? 'down') === 'down';
  // Leave room for edge labels between layers.
  const labels = (d.edges ?? []).map((e) => e.label ?? '').filter(Boolean);
  const gap = Math.max(
    LAYER_GAP,
    ...labels.map((l) => (down ? l.split('\n').length * 16 * LINE_HEIGHT : textWidth(l, 16)) + 50),
  );
  // Main-axis position of each layer, and cross-axis extent so layers are centred on each other.
  const cross = (b: Box) => (down ? b.width : b.height);
  const main = (b: Box) => (down ? b.height : b.width);
  const spans = layers.map(
    (l) => (l ?? []).reduce((s, b) => s + cross(b), 0) + SIBLING_GAP * ((l?.length ?? 1) - 1),
  );
  const widest = Math.max(...spans, 0);
  let pos = 0;
  layers.forEach((l, i) => {
    if (!l) return;
    let c = (widest - spans[i]!) / 2;
    const thickness = Math.max(...l.map(main));
    for (const b of l) {
      const offset = (thickness - main(b)) / 2;
      if (down) {
        b.x = origin.x + c;
        b.y = origin.y + pos + offset;
      } else {
        b.x = origin.x + pos + offset;
        b.y = origin.y + c;
      }
      c += cross(b) + SIBLING_GAP;
    }
    pos += thickness + gap;
  });
  // Explicit positions win (relative to the diagram origin).
  for (const b of boxes.values()) {
    if (b.node.x !== undefined) b.x = origin.x + b.node.x;
    if (b.node.y !== undefined) b.y = origin.y + b.node.y;
  }
  return boxes;
}

/** Where the segment from the box centre towards (tx, ty) leaves the box. */
function boundaryPoint(b: Box, tx: number, ty: number, gap: number): [number, number] {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const hw = b.width / 2;
  const hh = b.height / 2;
  let t: number;
  if (b.node.shape === 'ellipse') t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  else if (b.node.shape === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  const len = Math.hypot(dx, dy);
  const extra = gap / len;
  return [cx + dx * (t + extra), cy + dy * (t + extra)];
}

const colorOf = (c: string | undefined) => (c ? (COLORS[c.toLowerCase()] ?? c) : 'transparent');

/** Bounding box of the visible elements on a board, or null when it is empty. */
export function boardBounds(elements: Element[]) {
  const live = elements.filter((e) => !e.isDeleted);
  if (!live.length) return null;
  return {
    minX: Math.min(...live.map((e) => e.x)),
    minY: Math.min(...live.map((e) => e.y)),
    maxX: Math.max(...live.map((e) => e.x + e.width)),
    maxY: Math.max(...live.map((e) => e.y + e.height)),
  };
}

/**
 * Builds the elements for `d`, placed below the elements in `existing`, with indices after
 * those in `indexAfter` (all elements on the board). Throws on edges to unknown nodes.
 */
export function diagramElements(
  d: Diagram,
  existing: Element[] = [],
  indexAfter: Element[] = existing,
): Element[] {
  const ids = new Set(d.nodes.map((n) => n.id));
  if (ids.size !== d.nodes.length) throw new Error('Node ids must be unique');
  for (const e of d.edges ?? []) {
    if (!ids.has(e.from) || !ids.has(e.to))
      throw new Error(`Edge ${e.from} -> ${e.to} refers to an unknown node id`);
  }
  const bounds = boardBounds(existing);
  // An empty board starts a little inset, clear of the embed toolbar and the canvas edge.
  const boxes = layout(d, { x: bounds?.minX ?? 40, y: bounds ? bounds.maxY + 120 : 100 });
  const out: Element[] = [];
  const shapes = new Map<string, Element>();
  for (const b of boxes.values()) {
    const shape = base(b.node.shape ?? 'rectangle', b.x, b.y, b.width, b.height);
    shape.backgroundColor = colorOf(b.node.color);
    const kind = b.node.shape ?? 'rectangle';
    shape.roundness = kind === 'rectangle' ? { type: 3 } : kind === 'diamond' ? { type: 2 } : null;
    const label = textElement(b.node.label, b.x + b.width / 2, b.y + b.height / 2, shape.id);
    shape.boundElements = [{ type: 'text', id: label.id }];
    shapes.set(b.node.id, shape);
    out.push(shape, label);
  }
  for (const e of d.edges ?? []) {
    const from = boxes.get(e.from)!;
    const to = boxes.get(e.to)!;
    const [sx, sy] = boundaryPoint(from, to.x + to.width / 2, to.y + to.height / 2, 6);
    const [ex, ey] = boundaryPoint(to, from.x + from.width / 2, from.y + from.height / 2, 6);
    const arrow = base('arrow', sx, sy, Math.abs(ex - sx), Math.abs(ey - sy));
    const startShape = shapes.get(e.from)!;
    const endShape = shapes.get(e.to)!;
    Object.assign(arrow, {
      strokeStyle: e.dashed ? 'dashed' : 'solid',
      roundness: { type: 2 },
      points: [
        [0, 0],
        [ex - sx, ey - sy],
      ],
      lastCommittedPoint: null,
      startBinding: { elementId: startShape.id, focus: 0, gap: 6 },
      endBinding: { elementId: endShape.id, focus: 0, gap: 6 },
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: false,
    });
    (startShape.boundElements as unknown[]).push({ type: 'arrow', id: arrow.id });
    (endShape.boundElements as unknown[]).push({ type: 'arrow', id: arrow.id });
    out.push(arrow);
    if (e.label) {
      const label = textElement(e.label, (sx + ex) / 2, (sy + ey) / 2, arrow.id);
      label.fontSize = 16;
      arrow.boundElements = [{ type: 'text', id: label.id }];
      out.push(label);
    }
  }
  assignIndices(indexAfter, out);
  return out;
}

/** Marks every live element deleted (Excalidraw syncs deletions as a newer version). */
export function deleteAll(existing: Element[]): Element[] {
  return existing
    .filter((e) => !e.isDeleted)
    .map((e) => ({
      ...e,
      isDeleted: true,
      version: e.version + 1,
      versionNonce: randomInt(1, 2 ** 31 - 1),
      updated: Date.now(),
    }));
}

/** Plain-text description of a board: labelled shapes, arrows between them, free text. */
export function describeBoard(elements: Element[]): string {
  const live = elements.filter((e) => !e.isDeleted);
  if (!live.length) return 'The whiteboard is empty.';
  const byId = new Map(live.map((e) => [e.id, e]));
  const labelOf = (id: string | undefined | null): string => {
    const el = id ? byId.get(id) : undefined;
    if (!el) return '?';
    if (el.type === 'text') return JSON.stringify(el.text);
    const text = live.find((t) => t.type === 'text' && t.containerId === el.id);
    return text ? JSON.stringify(text.text) : `${el.type} ${el.id}`;
  };
  const lines: string[] = [];
  const shapes = live.filter((e) => ['rectangle', 'ellipse', 'diamond'].includes(e.type));
  if (shapes.length) {
    lines.push('Shapes:');
    for (const s of shapes)
      lines.push(
        `- ${s.type} ${labelOf(s.id)} at (${Math.round(s.x)}, ${Math.round(s.y)}) ${Math.round(s.width)}x${Math.round(s.height)}${s.backgroundColor && s.backgroundColor !== 'transparent' ? `, fill ${String(s.backgroundColor)}` : ''}`,
      );
  }
  const arrows = live.filter((e) => e.type === 'arrow' || e.type === 'line');
  if (arrows.length) {
    lines.push('Connectors:');
    for (const a of arrows) {
      const start = (a.startBinding as { elementId?: string } | null)?.elementId;
      const end = (a.endBinding as { elementId?: string } | null)?.elementId;
      const label = live.find((t) => t.type === 'text' && t.containerId === a.id);
      lines.push(
        `- ${start ? labelOf(start) : 'unbound'} -> ${end ? labelOf(end) : 'unbound'}${label ? ` (label ${JSON.stringify(label.text)})` : ''}`,
      );
    }
  }
  const free = live.filter((e) => e.type === 'text' && !e.containerId);
  if (free.length) {
    lines.push('Text:');
    for (const t of free)
      lines.push(`- ${JSON.stringify(t.text)} at (${Math.round(t.x)}, ${Math.round(t.y)})`);
  }
  const other = live.filter(
    (e) => !['rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'text'].includes(e.type),
  );
  if (other.length)
    lines.push(
      `Other: ${other.length} element(s) (${[...new Set(other.map((o) => o.type))].join(', ')})`,
    );
  return lines.join('\n');
}

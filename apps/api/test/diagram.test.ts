import { describe, expect, it } from 'vitest';
import { assignIndices, deleteAll, diagramElements, type Element } from '../src/lib/diagram.js';

describe('diagramElements', () => {
  const d = {
    nodes: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ],
    edges: [
      { from: 'a', to: 'b', label: 'go' },
      { from: 'a', to: 'c' },
    ],
  };

  it('binds labels and arrows both ways and lays out in layers', () => {
    const els = diagramElements(d);
    const shapes = els.filter((e) => e.type === 'rectangle');
    const arrows = els.filter((e) => e.type === 'arrow');
    expect(shapes).toHaveLength(3);
    expect(arrows).toHaveLength(2);
    const [a, b, c] = shapes as Element[];
    expect(b!.y).toBeGreaterThan(a!.y + a!.height);
    expect(b!.y).toBe(c!.y);
    for (const s of shapes) {
      const label = els.find((e) => e.type === 'text' && e.containerId === s.id)!;
      expect(s.boundElements).toContainEqual({ type: 'text', id: label.id });
    }
    const ab = arrows[0]!;
    expect(ab.startBinding).toMatchObject({ elementId: a!.id });
    expect(ab.endBinding).toMatchObject({ elementId: b!.id });
    expect(a!.boundElements).toContainEqual({ type: 'arrow', id: ab.id });
    expect(els.find((e) => e.containerId === ab.id)?.text).toBe('go');
    // Arrow ends lie between the shapes.
    const pts = ab.points as number[][];
    const end = pts[pts.length - 1]!;
    expect(ab.y).toBeGreaterThanOrEqual(a!.y + a!.height);
    expect(ab.y + end[1]!).toBeLessThanOrEqual(b!.y);
  });

  it('assigns increasing indices after the existing ones and draws below them', () => {
    const first = diagramElements(d);
    const keys = first.map((e) => e.index!);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
    const second = diagramElements(d, first);
    expect(second[0]!.index! > keys[keys.length - 1]!).toBe(true);
    const bottom = Math.max(...first.map((e) => e.y + e.height));
    expect(Math.min(...second.map((e) => e.y))).toBeGreaterThan(bottom);
  });

  it('rolls index keys over', () => {
    const els = Array.from({ length: 70 }, (_, i) => ({ id: String(i) }) as Element);
    assignIndices([{ index: 'ax' } as Element], els);
    expect(els[0]!.index).toBe('ay');
    expect(els[2]!.index).toBe('b00');
    const keys = els.map((e) => e.index!);
    expect([...keys].sort()).toEqual(keys);
  });

  it('deletes by bumping versions', () => {
    const els = diagramElements(d);
    const del = deleteAll(els);
    expect(del.every((e) => e.isDeleted && e.version === 2)).toBe(true);
  });

  it('routes elbow arrows at right angles, turning only between layers', () => {
    const els = diagramElements({
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'a', to: 'd' },
      ],
      arrows: 'elbow',
    });
    const shapes = els.filter((e) => e.type === 'rectangle');
    for (const arrow of els.filter((e) => e.type === 'arrow')) {
      expect(arrow.elbowed).toBe(true);
      expect(arrow.startBinding).toMatchObject({ fixedPoint: [0.5, 1] });
      expect(arrow.endBinding).toMatchObject({ fixedPoint: [0.5, 0] });
      const pts = (arrow.points as number[][]).map(
        ([x, y]) => [arrow.x + x!, arrow.y + y!] as const,
      );
      for (let i = 1; i < pts.length; i++) {
        const [p, q] = [pts[i - 1]!, pts[i]!];
        expect(p[0] === q[0] || p[1] === q[1]).toBe(true);
        // No segment runs through a shape (apart from touching its own ends' gap).
        for (const s of shapes) {
          const inside = (x: number, y: number) =>
            x > s.x && x < s.x + s.width && y > s.y && y < s.y + s.height;
          for (let t = 0.1; t < 1; t += 0.1)
            expect(inside(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)).toBe(false);
        }
      }
    }
  });

  it('draws straight arrows by default', () => {
    const els = diagramElements(d);
    for (const a of els.filter((e) => e.type === 'arrow')) {
      expect(a.elbowed).toBe(false);
      expect((a.points as unknown[]).length).toBe(2);
    }
  });

  it('rejects edges to unknown nodes', () => {
    expect(() =>
      diagramElements({ nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'x' }] }),
    ).toThrow(/unknown node/);
  });

  it('bends edges that skip a layer around the nodes in between', () => {
    const els = diagramElements({
      nodes: [
        { id: 'q', label: 'Signed in?', shape: 'diamond' },
        { id: 'login', label: 'Login' },
        { id: 'home', label: 'Home' },
      ],
      edges: [
        { from: 'q', to: 'login' },
        { from: 'q', to: 'home', label: 'yes' },
        { from: 'login', to: 'home' },
      ],
      arrows: 'straight',
    });
    const login = els.find(
      (e) =>
        e.type === 'rectangle' && els.some((t) => t.containerId === e.id && t.text === 'Login'),
    )!;
    const skip = els.filter((e) => e.type === 'arrow')[1]!;
    const pts = (skip.points as number[][]).map(([x, y]) => [skip.x + x!, skip.y + y!]);
    expect(pts).toHaveLength(3);
    const [bx, by] = pts[1]!;
    const inside =
      bx! >= login.x &&
      bx! <= login.x + login.width &&
      by! >= login.y &&
      by! <= login.y + login.height;
    expect(inside).toBe(false);
    expect(by).toBeGreaterThan(login.y - 1);
  });
});

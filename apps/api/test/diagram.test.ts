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
    const end = (ab.points as number[][])[1]!;
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

  it('rejects edges to unknown nodes', () => {
    expect(() =>
      diagramElements({ nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'x' }] }),
    ).toThrow(/unknown node/);
  });
});

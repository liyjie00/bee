import { useEffect, useRef } from 'react';

interface Line {
  d: string;
  x: number;
  y: number;
}

/** Path from the start of the comment's highlight to its card, or null when it shouldn't be drawn. */
function measure(id: string): Line | null {
  const sel = CSS.escape(id);
  const card = document.querySelector<HTMLElement>(`.panel .thread[data-thread-id="${sel}"]`);
  const mark = document.querySelector<HTMLElement>(`.prose [data-comment-id="${sel}"]`);
  const view = mark?.closest<HTMLElement>('.view');
  const body = card?.closest<HTMLElement>('.pbody');
  const r = mark?.getClientRects()[0];
  if (!card || !view || !body || !r) return null;
  const c = card.getBoundingClientRect();
  const v = view.getBoundingClientRect();
  const b = body.getBoundingClientRect();
  // the sticky toolbar covers the top of the view
  const top = Math.max(v.top, view.querySelector('.toolbar')?.getBoundingClientRect().bottom ?? v.top);
  const x1 = Math.round(r.right);
  const y1 = Math.round(r.bottom) - 0.5;
  const x2 = Math.round(c.left);
  const y2 = Math.round(c.top) + 20.5;
  // hidden when either end is scrolled out of sight, or the panel overlays the text (narrow screens)
  if (y1 < top || y1 > v.bottom || y2 < b.top || y2 > b.bottom || x2 - x1 < 24) return null;
  // along the highlight's underline to the gutter, then a soft curve into the card
  const gx = Math.max(x1, Math.min(v.right, x2) - 40);
  const k = (x2 - gx) / 2;
  return { d: `M${x1},${y1}H${gx}C${gx + k},${y1} ${x2 - k},${y2} ${x2},${y2}`, x: x1, y: y1 };
}

/**
 * Thin line from the active comment card in the side panel to its highlighted text, like Google Docs / Word.
 * Re-measured every frame (a few rects; the DOM is written only when the path changes), so it follows
 * scrolling on either side, resizes, typing and remote edits without wiring up observers.
 */
export function CommentConnector({ activeId }: { activeId: string | null }) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!activeId || !svg) return;
    const path = svg.querySelector('path')!;
    const dot = svg.querySelector('circle')!;
    let raf = 0;
    let last = '';
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const line = measure(activeId);
      const d = line?.d ?? '';
      if (d === last) return;
      last = d;
      svg.style.display = line ? '' : 'none';
      if (!line) return;
      path.setAttribute('d', line.d);
      dot.setAttribute('cx', String(line.x));
      dot.setAttribute('cy', String(line.y));
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      svg.style.display = 'none';
    };
  }, [activeId]);

  return (
    <svg ref={svgRef} className="cm-connector" style={{ display: 'none' }} aria-hidden="true">
      <path />
      <circle r={2} />
    </svg>
  );
}

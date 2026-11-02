import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Editor } from '@bee/editor';
import { useI18n } from '../i18n';

export type Heading = { pos: number; level: number; text: string };

/** Every non-empty heading in document order, wherever it sits (columns, callouts…). */
export function collectHeadings(editor: Editor): Heading[] {
  const out: Heading[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true;
    const text = node.textContent.trim();
    if (text) out.push({ pos, level: node.attrs.level ?? 1, text });
    return false;
  });
  return out;
}

/** Room left above a heading after jumping to it, below the sticky toolbar. */
const GAP = 16;

/**
 * Table of contents of the doc's H1–H6. Collapsed it is a column of short dashes on the left edge;
 * hovering the left edge opens the list, moving back into the text closes it.
 */
export function DocOutline({ editor, viewRef }: { editor: Editor; viewRef: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const [headings, setHeadings] = useState<Heading[]>(() => collectHeadings(editor));
  const [current, setCurrent] = useState(0);
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setHeadings(collectHeadings(editor)));
    };
    update();
    editor.on('update', update);
    return () => {
      cancelAnimationFrame(raf);
      editor.off('update', update);
    };
  }, [editor]);

  const toolbarHeight = () => viewRef.current?.querySelector<HTMLElement>('.toolbar')?.offsetHeight ?? 0;
  const headingTop = (h: Heading, view: HTMLElement) => {
    const dom = editor.view.nodeDOM(h.pos);
    if (!(dom instanceof HTMLElement)) return null;
    return dom.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
  };

  // The heading being read: the last one whose top has scrolled past the toolbar.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let raf = 0;
    const spy = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const tb = toolbarHeight();
        setTop(tb);
        const line = view.scrollTop + tb + GAP + 8;
        let cur = 0;
        headings.forEach((h, i) => {
          const y = headingTop(h, view);
          if (y !== null && y <= line) cur = i;
        });
        setCurrent(cur);
      });
    };
    spy();
    view.addEventListener('scroll', spy, { passive: true });
    addEventListener('resize', spy);
    return () => {
      cancelAnimationFrame(raf);
      view.removeEventListener('scroll', spy);
      removeEventListener('resize', spy);
    };
  }, [headings, viewRef]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  if (!headings.length) return null;

  const show = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = (e: React.MouseEvent) => {
    // Sliding between the edge strip and the list keeps it open.
    if (e.relatedTarget instanceof Node && e.currentTarget.parentElement?.contains(e.relatedTarget)) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 160);
  };
  const jump = (h: Heading) => {
    const view = viewRef.current;
    const dom = editor.view.nodeDOM(h.pos);
    if (!view || !(dom instanceof HTMLElement)) return;
    const y = headingTop(h, view);
    if (y !== null) view.scrollTo({ top: y - toolbarHeight() - GAP, behavior: 'smooth' });
    // Same flash as .bee-landed, but without touching the class: ProseMirror redraws a node whose
    // attributes change, which would drop the class at once.
    const wash = { background: 'var(--be-honey-wash)', boxShadow: '-12px 0 0 var(--be-honey-wash),12px 0 0 var(--be-honey-wash)' };
    const clear = { background: 'transparent', boxShadow: '-12px 0 0 transparent,12px 0 0 transparent' };
    dom.animate([wash, { ...wash, offset: 0.4 }, clear], { duration: 2400, easing: 'ease-out' });
  };
  const minLevel = Math.min(...headings.map((h) => h.level));

  return (
    <div className={'outline' + (open ? ' open' : '')} style={{ top }}>
      <div className="outline-edge" onMouseEnter={show} onMouseLeave={hide} />
      <div className="outline-rail" aria-hidden onMouseEnter={show} onMouseLeave={hide}>
        {headings.slice(0, 40).map((h, i) => (
          <i key={h.pos} className={i === current ? 'on' : undefined} style={{ width: Math.max(6, 22 - (h.level - minLevel) * 4) }} />
        ))}
      </div>
      <nav className="outline-list" aria-label={t('doc.outline')} onMouseEnter={show} onMouseLeave={hide}>
        <div className="outline-ttl">{t('doc.outline')}</div>
        {headings.map((h, i) => (
          <button
            key={h.pos}
            className={'lv' + (h.level - minLevel + 1) + (i === current ? ' on' : '')}
            title={h.text}
            onClick={() => jump(h)}
            onFocus={show}
          >
            {h.text}
          </button>
        ))}
      </nav>
    </div>
  );
}

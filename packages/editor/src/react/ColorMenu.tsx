import type { Editor } from '@tiptap/core';
import { useEffect, useRef, useState } from 'react';
import { TEXT_COLORS, type TextColor } from '../schema/text-color.js';
import type { Messages } from './i18n.js';

/** "A" button with a palette: preset text colors and background highlights for the selection. */
export function ColorMenu({ editor, messages: t, className }: { editor: Editor; messages: Messages; className?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const fg = editor.getAttributes('textColor').color as TextColor | undefined;
  const bg = editor.isActive('highlight') ? ((editor.getAttributes('highlight').color as TextColor | undefined) ?? 'yellow') : undefined;
  const run = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => fn(editor.chain().focus()).run();
  const swatch = (kind: 'fg' | 'bg', color: TextColor | null) => {
    const on = kind === 'fg' ? (fg ?? null) === color : (bg ?? null) === color;
    const label = color ? t[`color_${color}`] : kind === 'fg' ? t.colorDefault : t.highlightNone;
    return (
      <button
        key={kind + (color ?? 'none')}
        type="button"
        className={`bee-swatch bee-swatch-${kind}${color ? '' : ' is-none'}${on ? ' is-on' : ''}`}
        data-swatch={color ?? undefined}
        title={label}
        aria-label={label}
        aria-pressed={on}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() =>
          run((c) =>
            kind === 'fg' ? (color ? c.setTextColor(color) : c.unsetTextColor()) : color ? c.setHighlight(color) : c.unsetHighlight(),
          )
        }
      >
        {kind === 'fg' && color ? 'A' : null}
      </button>
    );
  };
  return (
    <span ref={box} className={`bee-color-menu ${className ?? ''}`}>
      <button
        type="button"
        className={`bee-color-btn${open ? ' is-active' : ''}`}
        title={t.textColor}
        aria-label={t.textColor}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="bee-color-a" data-swatch={fg} data-bg={bg}>
          A
        </span>
      </button>
      {open && (
        <span className="bee-color-pop" role="dialog" aria-label={t.textColor} onMouseDown={(e) => e.preventDefault()}>
          <span className="bee-color-cap">{t.textColor}</span>
          <span className="bee-color-row">{[null, ...TEXT_COLORS].map((c) => swatch('fg', c))}</span>
          <span className="bee-color-cap">{t.highlight}</span>
          <span className="bee-color-row">{[null, ...TEXT_COLORS].map((c) => swatch('bg', c))}</span>
        </span>
      )}
    </span>
  );
}

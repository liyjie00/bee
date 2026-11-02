import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  /** shown greyed out after the label, e.g. a file extension or shortcut */
  hint?: string;
  /** a checkbox option: toggles in place without closing the menu */
  checked?: boolean;
  onSelect(): void;
}
/** A small caption above a group of items. */
export interface MenuCaption {
  caption: string;
}
export type MenuEntry = MenuItem | MenuCaption | '-';

/** Floating context menu at a viewport point. Closes on outside click or Escape. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [checks, setChecks] = useState<Record<number, boolean>>({});
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: Math.min(x, innerWidth - r.width - 8), y: Math.min(y, innerHeight - r.height - 8) });
  }, [x, y]);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);
  return (
    <div className="ctx" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((it, i) => {
        if (it === '-') return <hr key={i} />;
        if ('caption' in it)
          return (
            <div key={i} className="ctx-cap">
              {it.caption}
            </div>
          );
        if (it.checked !== undefined) {
          const on = checks[i] ?? it.checked;
          return (
            <button
              key={i}
              role="menuitemcheckbox"
              aria-checked={on}
              className="ctx-check"
              onClick={() => {
                setChecks((c) => ({ ...c, [i]: !on }));
                it.onSelect();
              }}
            >
              <span className={'ctx-box' + (on ? ' on' : '')}>{on && <Icon name="check" size={11} />}</span>
              {it.label}
            </button>
          );
        }
        return (
          <button
            key={i}
            role="menuitem"
            className={it.danger ? 'danger' : undefined}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.icon && <Icon name={it.icon} />}
            {it.label}
            {it.hint && <small className="ctx-hint">{it.hint}</small>}
          </button>
        );
      })}
    </div>
  );
}

export function useMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const open = (
    e: { clientX: number; clientY: number; currentTarget?: EventTarget | null; preventDefault(): void; stopPropagation(): void },
    items: MenuEntry[],
  ) => {
    e.preventDefault();
    e.stopPropagation();
    let { clientX: x, clientY: y } = e;
    // Keyboard activation reports (0, 0): open under the button instead of the top-left corner.
    if (!x && !y && e.currentTarget instanceof Element) {
      const r = e.currentTarget.getBoundingClientRect();
      x = r.left;
      y = r.bottom + 4;
    }
    setMenu({ x, y, items });
  };
  const node: ReactNode = menu ? <ContextMenu {...menu} onClose={() => setMenu(null)} /> : null;
  return { open, node };
}

export function Avatar({ name, color, sm }: { name: string; color?: string | null; sm?: boolean }) {
  return (
    <span className={'av' + (sm ? ' sm' : '')} style={{ background: color ?? '#5b6b4f' }} title={name}>
      {[...name][0]?.toUpperCase() ?? '?'}
    </span>
  );
}

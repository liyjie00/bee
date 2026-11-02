import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  onSelect(): void;
}

/** Floating context menu at a viewport point. Closes on outside click or Escape. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: (MenuItem | '-')[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
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
      {items.map((it, i) =>
        it === '-' ? (
          <hr key={i} />
        ) : (
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
          </button>
        ),
      )}
    </div>
  );
}

export function useMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | '-')[] } | null>(null);
  const open = (
    e: { clientX: number; clientY: number; currentTarget?: EventTarget | null; preventDefault(): void; stopPropagation(): void },
    items: (MenuItem | '-')[],
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

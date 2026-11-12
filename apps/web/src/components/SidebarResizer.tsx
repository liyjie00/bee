import { useEffect, type KeyboardEvent, type PointerEvent } from 'react';
import { useT } from '../i18n';

const WIDTH_KEY = 'bee-side-width';
/** Sidebar width bounds in rem (the UI is sized in rem, see html{font-size} in styles.css). */
const DEFAULT_REM = 17.5;
const MIN_REM = 14.5;
const MAX_REM = 30;

const clamp = (rem: number) => Math.min(MAX_REM, Math.max(MIN_REM, rem));
const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

function apply(rem: number | null) {
  const root = document.documentElement;
  if (rem == null) root.style.removeProperty('--side-w');
  else root.style.setProperty('--side-w', `${rem}rem`);
  // Narrower than the default, the create buttons drop their "+" so the labels still fit.
  root.toggleAttribute('data-side-narrow', rem != null && rem < DEFAULT_REM);
}

function save(rem: number | null) {
  try {
    if (rem == null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(rem));
  } catch {
    /* private mode: width just isn't remembered */
  }
}

function current(): number {
  const v = parseFloat(document.documentElement.style.getPropertyValue('--side-w'));
  return Number.isFinite(v) ? v : DEFAULT_REM;
}

/**
 * Drag handle on the sidebar's right edge (desktop only; hidden by CSS in the drawer layout).
 * The width lives in the --side-w CSS variable that sizes the .app grid's first column.
 * Double-click restores the default width; arrow keys nudge it when the handle has focus.
 */
export function SidebarResizer() {
  const t = useT();

  useEffect(() => {
    let stored: number | null = null;
    try {
      const v = parseFloat(localStorage.getItem(WIDTH_KEY) ?? '');
      if (Number.isFinite(v)) stored = clamp(v);
    } catch {
      /* ignore */
    }
    apply(stored);
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const side = handle.parentElement;
    if (!side) return;
    handle.setPointerCapture(e.pointerId);
    const left = side.getBoundingClientRect().left;
    const px = remPx();
    let rem = current();
    document.body.classList.add('side-resizing');
    const move = (ev: globalThis.PointerEvent) => {
      rem = clamp(Math.round(((ev.clientX - left) / px) * 4) / 4);
      apply(rem);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('side-resizing');
      save(rem === DEFAULT_REM ? null : rem);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const reset = () => {
    apply(null);
    save(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!step) return;
    e.preventDefault();
    const rem = clamp(current() + step);
    apply(rem);
    save(rem === DEFAULT_REM ? null : rem);
  };

  return (
    <div
      className="side-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('nav.resizeSidebar')}
      aria-valuemin={MIN_REM}
      aria-valuemax={MAX_REM}
      title={t('nav.resizeSidebar')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  );
}

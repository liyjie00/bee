import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';

/** Named cell colors; the stylesheet maps each to a theme-aware color. */
export const CELL_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type CellColor = (typeof CELL_COLORS)[number];
export const CELL_ALIGNS = ['left', 'center', 'right'] as const;
export type CellAlign = (typeof CELL_ALIGNS)[number];

const pick = <T extends string>(allowed: readonly T[], value: unknown): T | null =>
  allowed.includes(value as T) ? (value as T) : null;

const styleAttributes = () => ({
  background: {
    default: null,
    parseHTML: (el: HTMLElement) => pick(CELL_COLORS, el.getAttribute('data-bg')),
    renderHTML: (attrs: Record<string, unknown>) => (pick(CELL_COLORS, attrs.background) ? { 'data-bg': attrs.background } : {}),
  },
  color: {
    default: null,
    parseHTML: (el: HTMLElement) => pick(CELL_COLORS, el.getAttribute('data-color')),
    renderHTML: (attrs: Record<string, unknown>) => (pick(CELL_COLORS, attrs.color) ? { 'data-color': attrs.color } : {}),
  },
  align: {
    default: null,
    parseHTML: (el: HTMLElement) => pick(CELL_ALIGNS, el.getAttribute('data-align') ?? el.style.textAlign),
    renderHTML: (attrs: Record<string, unknown>) => (pick(CELL_ALIGNS, attrs.align) ? { 'data-align': attrs.align } : {}),
  },
});

/** Table cells with background color, text color and alignment. */
export const StyledTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...styleAttributes() };
  },
});

export const StyledTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...styleAttributes() };
  },
});

/** Smallest row height a drag can set, in px. */
export const ROW_MIN_HEIGHT = 24;

/**
 * Rows with an optional height set by dragging. A table row's CSS height is a minimum:
 * rows still grow to fit their text, the dragged height only keeps short rows taller.
 */
export const StyledTableRow = TableRow.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      height: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const h = parseInt(el.getAttribute('data-height') ?? el.style.height, 10);
          return Number.isFinite(h) && h >= ROW_MIN_HEIGHT ? h : null;
        },
        renderHTML: (attrs: Record<string, unknown>) =>
          typeof attrs.height === 'number' ? { 'data-height': attrs.height, style: `height: ${attrs.height}px` } : {},
      },
    };
  },
});

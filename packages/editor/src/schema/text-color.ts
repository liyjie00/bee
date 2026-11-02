import { Mark, mergeAttributes } from '@tiptap/core';
import { CELL_COLORS, type CellColor } from './table-style.js';

/** Preset colors for text and highlights: the same named set as table cells, theme-aware in CSS. */
export const TEXT_COLORS = CELL_COLORS;
export type TextColor = CellColor;

const pick = (v: unknown): TextColor | null => (TEXT_COLORS.includes(v as TextColor) ? (v as TextColor) : null);

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    textColor: {
      setTextColor: (color: TextColor) => ReturnType;
      unsetTextColor: () => ReturnType;
    };
    highlight: {
      setHighlight: (color: TextColor) => ReturnType;
      unsetHighlight: () => ReturnType;
    };
  }
}

/** Colored text: <span data-text-color="red">. */
export const TextColorMark = Mark.create({
  name: 'textColor',
  addAttributes: () => ({
    color: {
      default: null,
      parseHTML: (el: HTMLElement) => pick(el.getAttribute('data-text-color')),
      renderHTML: (attrs: Record<string, unknown>) => (pick(attrs.color) ? { 'data-text-color': attrs.color } : {}),
    },
  }),
  parseHTML: () => [{ tag: 'span[data-text-color]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes), 0],
  addCommands() {
    return {
      setTextColor:
        (color) =>
        ({ commands }) =>
          commands.setMark(this.name, { color }),
      unsetTextColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

/** Background highlight: <mark data-color="yellow">. */
export const HighlightMark = Mark.create({
  name: 'highlight',
  addAttributes: () => ({
    color: {
      default: 'yellow',
      parseHTML: (el: HTMLElement) => pick(el.getAttribute('data-color')) ?? 'yellow',
      renderHTML: (attrs: Record<string, unknown>) => ({ 'data-color': pick(attrs.color) ?? 'yellow' }),
    },
  }),
  parseHTML: () => [{ tag: 'mark' }],
  renderHTML: ({ HTMLAttributes }) => ['mark', mergeAttributes(HTMLAttributes), 0],
  addCommands() {
    return {
      setHighlight:
        (color) =>
        ({ commands }) =>
          commands.setMark(this.name, { color }),
      unsetHighlight:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-h': () => (this.editor.isActive(this.name) ? this.editor.commands.unsetHighlight() : this.editor.commands.setHighlight('yellow')) };
  },
});

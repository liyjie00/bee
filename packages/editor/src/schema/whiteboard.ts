import { Node, mergeAttributes } from '@tiptap/core';

/** Part of a board's scene shown by an embed: top-left corner and size, in scene units. */
export interface WhiteboardView {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `"x,y,w,h"` → view; null when missing or malformed. */
export function parseWhiteboardView(value: unknown): WhiteboardView | null {
  if (typeof value !== 'string') return null;
  const n = value.split(',').map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v)) || n[2]! <= 0 || n[3]! <= 0) return null;
  return { x: n[0]!, y: n[1]!, w: n[2]!, h: n[3]! };
}

export const formatWhiteboardView = (v: WhiteboardView) => [v.x, v.y, v.w, v.h].map((n) => Math.round(n)).join(',');

export type WhiteboardAlign = 'left' | 'center' | 'right';
export const WHITEBOARD_DEFAULT_HEIGHT = 420;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    whiteboard: {
      /** Inserts an embed of a whiteboard document (the board itself lives in its own Y.Doc). */
      insertWhiteboard: (attrs: { documentId: string; height?: number; linked?: boolean }) => ReturnType;
    };
  }
}

export const Whiteboard = Node.create({
  name: 'whiteboard',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      documentId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-document-id'),
        renderHTML: (attrs) => ({ 'data-document-id': attrs.documentId }),
      },
      /** A standalone whiteboard shown read-only here (edited on its own page), not one owned by this doc. */
      linked: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-linked') === 'true',
        renderHTML: (attrs) => (attrs.linked ? { 'data-linked': 'true' } : {}),
      },
      height: {
        default: WHITEBOARD_DEFAULT_HEIGHT,
        parseHTML: (el) => Number(el.getAttribute('data-height')) || WHITEBOARD_DEFAULT_HEIGHT,
        renderHTML: (attrs) => ({ 'data-height': attrs.height }),
      },
      /** Percent of the column width. */
      width: {
        default: 100,
        parseHTML: (el) => Number(el.getAttribute('data-width')) || 100,
        renderHTML: (attrs) => (attrs.width && attrs.width !== 100 ? { 'data-width': attrs.width } : {}),
      },
      align: {
        default: 'center',
        parseHTML: (el) => el.getAttribute('data-align') || 'center',
        renderHTML: (attrs) => (attrs.align && attrs.align !== 'center' ? { 'data-align': attrs.align } : {}),
      },
      /** Saved display range, `"x,y,w,h"` in scene units; null shows the whole drawing. */
      view: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-view'),
        renderHTML: (attrs) => (attrs.view ? { 'data-view': attrs.view } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="whiteboard"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'whiteboard' })];
  },

  addCommands() {
    return {
      insertWhiteboard:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});

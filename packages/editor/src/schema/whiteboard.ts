import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    whiteboard: {
      /** Inserts an embed of a whiteboard document (the board itself lives in its own Y.Doc). */
      insertWhiteboard: (attrs: { documentId: string; height?: number }) => ReturnType;
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
      height: {
        default: 420,
        parseHTML: (el) => Number(el.getAttribute('data-height')) || 420,
        renderHTML: (attrs) => ({ 'data-height': attrs.height }),
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

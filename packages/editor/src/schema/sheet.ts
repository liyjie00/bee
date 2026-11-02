import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    sheet: {
      /** Inserts a spreadsheet block; its data lives under `sheetId` in the document's `sheets` map. */
      insertSheet: (attrs: { sheetId: string }) => ReturnType;
    };
  }
}

/** A Univer spreadsheet embedded in the document (see sheet-data.ts for where its cells live). */
export const Sheet = Node.create({
  name: 'sheet',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      sheetId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-sheet-id'),
        renderHTML: (attrs) => ({ 'data-sheet-id': attrs.sheetId }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="sheet"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'sheet' })];
  },

  addCommands() {
    return {
      insertSheet:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});

import { Node, mergeAttributes } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    columns: {
      /** Inserts a row of `count` (2–4) borderless columns. */
      insertColumns: (count: number) => ReturnType;
      /** Replaces the columns around the selection with their contents, one after another. */
      unsetColumns: () => ReturnType;
    };
  }
}

/** One column of a `columns` row. */
export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-type="column"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'column', class: 'bee-column' }), 0];
  },
});

/** A row split into invisible columns, so blocks (e.g. whiteboards) can sit side by side. */
export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column{2,4}',
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-type="columns"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'columns', class: 'bee-columns' }), 0];
  },

  addCommands() {
    return {
      insertColumns:
        (count) =>
        ({ commands }) => {
          const n = Math.min(4, Math.max(2, Math.round(count)));
          return commands.insertContent({
            type: this.name,
            content: Array.from({ length: n }, () => ({ type: 'column', content: [{ type: 'paragraph' }] })),
          });
        },
      unsetColumns:
        () =>
        ({ state, dispatch }) => {
          const { $from } = state.selection;
          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d);
            if (node.type.name !== this.name) continue;
            if (dispatch) {
              const blocks: import('@tiptap/pm/model').Node[] = [];
              node.forEach((col) => col.forEach((b) => blocks.push(b)));
              dispatch(state.tr.replaceWith($from.before(d), $from.after(d), Fragment.from(blocks)).scrollIntoView());
            }
            return true;
          }
          return false;
        },
    };
  },
});

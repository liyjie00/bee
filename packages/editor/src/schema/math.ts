import { InputRule, Node, mergeAttributes } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

/**
 * `$…$` inline math, Pandoc's rule: no space just inside either `$`, and the closing `$` is not
 * followed by a digit, so prices like "$5 and $10" stay text. `\$` is a literal dollar.
 */
export const INLINE_DOLLAR_MATH = /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/;
const INLINE_DOLLAR_ANYWHERE = /\$(?!\s)(?:\\.|[^\\$\n])+?(?<!\s)\$(?!\d)/;

/** True when `$` in plain text would be read back as math and so must be escaped in Markdown. */
export const dollarsNeedEscape = (text: string) => text.includes('$$') || INLINE_DOLLAR_ANYWHERE.test(text);

const latexAttr = {
  latex: {
    default: '',
    parseHTML: (el: HTMLElement) => el.getAttribute('data-latex') ?? el.textContent ?? '',
    renderHTML: (attrs: Record<string, unknown>) => ({ 'data-latex': String(attrs.latex ?? '') }),
  },
};

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    math: {
      /** Inserts an inline formula; an empty one opens its editor. */
      insertInlineMath: (latex?: string) => ReturnType;
      /** Inserts a formula block; an empty one opens its editor. */
      insertBlockMath: (latex?: string) => ReturnType;
    };
  }
}

export const InlineMath = Node.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes: () => latexAttr,

  parseHTML() {
    return [{ tag: 'span[data-type="inline-math"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'inline-math' }), `$${String(node.attrs.latex)}$`];
  },

  renderText: ({ node }) => `$${String(node.attrs.latex)}$`,

  addCommands() {
    return {
      insertInlineMath:
        (latex = '') =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { latex } }),
    };
  },

  addInputRules() {
    // Typing the closing `$` of `$E=mc^2$` turns it into a formula (Backspace right after undoes it).
    return [
      new InputRule({
        find: /(?:^|[^\\$\w])(\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$)$/,
        handler: ({ state, range, match }) => {
          // The typed `$` is not in the document yet; range.from includes the char before the opening `$`.
          const start = range.from + (match[0].length - match[1]!.length);
          const $start = state.doc.resolve(start);
          if ($start.parent.type.spec.code || $start.marks().some((m) => m.type.name === 'code')) return null;
          state.tr.replaceWith(start, range.to, this.type.create({ latex: match[2] }));
        },
      }),
    ];
  },
});

export const BlockMath = Node.create({
  name: 'blockMath',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes: () => latexAttr,

  parseHTML() {
    return [{ tag: 'div[data-type="block-math"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'block-math' }), `$$${String(node.attrs.latex)}$$`];
  },

  renderText: ({ node }) => `$$\n${String(node.attrs.latex)}\n$$`,

  addCommands() {
    return {
      insertBlockMath:
        (latex = '') =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { latex } }),
    };
  },

  addKeyboardShortcuts() {
    return {
      // `$$` alone in a paragraph, then Enter: a formula block (like ``` for code).
      Enter: ({ editor }) => {
        const { state } = editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.parent.type.name !== 'paragraph' || $from.parent.textContent !== '$$') return false;
        if ($from.parentOffset !== 2) return false;
        const parent = $from.node(-1);
        const index = $from.index(-1);
        if (!parent.canReplaceWith(index, index + 1, this.type)) return false;
        const from = $from.before();
        const tr = state.tr.replaceWith(from, $from.after(), this.type.create({ latex: '' }));
        tr.setSelection(TextSelection.near(tr.doc.resolve(from)));
        editor.view.dispatch(tr);
        return true;
      },
    };
  },
});

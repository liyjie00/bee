import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { markdownToJSON } from '../markdown/from-markdown.js';
import { jsonToMarkdown } from '../markdown/to-markdown.js';
import type { JSONNode } from '../markdown/types.js';

const MARKDOWN_HINT = /^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.*\|\s*$|- \[[ xX]\]\s)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/m;

export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_HINT.test(text);
}

/** Inserts Markdown at the selection, converted to Bee blocks. */
export function insertMarkdown(editor: Editor, markdown: string): boolean {
  const json = markdownToJSON(markdown);
  return editor.chain().focus().insertContent(json.content ?? []).run();
}

export function editorToMarkdown(editor: Editor): string {
  return jsonToMarkdown(editor.getJSON() as JSONNode);
}

/** Plain-text pastes that look like Markdown are converted instead of pasted literally. */
export const MarkdownPaste = Extension.create({
  name: 'beeMarkdownPaste',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('beeMarkdownPaste'),
        props: {
          handlePaste(view, event) {
            const data = event.clipboardData;
            if (!data || data.types.includes('text/html') || data.files.length) return false;
            const text = data.getData('text/plain');
            if (!text || !looksLikeMarkdown(text)) return false;
            if (view.state.selection.$from.parent.type.name === 'codeBlock') return false;
            return insertMarkdown(editor, text);
          },
        },
      }),
    ];
  },
});

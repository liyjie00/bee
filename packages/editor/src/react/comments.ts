import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import * as Y from 'yjs';
import { isChangeOrigin } from '@tiptap/extension-collaboration';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import { BLOCK_ID_ATTR } from '../schema/block-id.js';

/** Where a comment thread is pinned. `from`/`to` are Y.RelativePosition JSON, stable across edits. */
export interface CommentAnchor {
  blockId: string;
  from: unknown;
  to: unknown;
  quote: string;
}

export interface CommentHighlight {
  id: string;
  anchor: CommentAnchor | null;
  resolved?: boolean;
}

interface CommentsState {
  comments: CommentHighlight[];
  activeId: string | null;
  set: DecorationSet;
}

export const commentsPluginKey = new PluginKey<CommentsState>('beeComments');

interface YBinding {
  doc: Y.Doc;
  type: Y.XmlFragment;
  mapping: Parameters<typeof absolutePositionToRelativePosition>[2];
}

function yBinding(state: EditorState): YBinding | null {
  const ystate = ySyncPluginKey.getState(state) as { doc: Y.Doc; type: Y.XmlFragment; binding?: { mapping: YBinding['mapping'] } } | undefined;
  if (!ystate?.binding) return null;
  return { doc: ystate.doc, type: ystate.type, mapping: ystate.binding.mapping };
}

/** Resolves a comment anchor to the current document range, or null when it no longer exists. */
export function resolveAnchor(state: EditorState, anchor: CommentAnchor): { from: number; to: number } | null {
  const y = yBinding(state);
  if (!y) return null;
  try {
    const from = relativePositionToAbsolutePosition(y.doc, y.type, Y.createRelativePositionFromJSON(anchor.from), y.mapping);
    const to = relativePositionToAbsolutePosition(y.doc, y.type, Y.createRelativePositionFromJSON(anchor.to), y.mapping);
    if (from === null || to === null || to <= from) return null;
    return { from, to };
  } catch {
    return null;
  }
}

/** Builds an anchor for the current selection, or null if the selection is empty. */
export function createAnchor(editor: Editor): CommentAnchor | null {
  const { state } = editor;
  const { from, to, $from } = state.selection;
  if (from === to) return null;
  const y = yBinding(state);
  if (!y) return null;
  let blockId = '';
  for (let d = $from.depth; d > 0; d--) {
    const id = $from.node(d).attrs[BLOCK_ID_ATTR];
    if (typeof id === 'string' && id) {
      blockId = id;
      break;
    }
  }
  return {
    blockId,
    from: Y.relativePositionToJSON(absolutePositionToRelativePosition(from, y.type, y.mapping)),
    to: Y.relativePositionToJSON(absolutePositionToRelativePosition(to, y.type, y.mapping)),
    quote: state.doc.textBetween(from, to, ' ').slice(0, 500),
  };
}

export interface CommentHighlightsOptions {
  onClick: ((id: string) => void) | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    commentHighlights: {
      setComments: (comments: CommentHighlight[], activeId?: string | null) => ReturnType;
    };
  }
}

/**
 * Highlights comment anchors as decorations. Nothing is written into the document, so read-only
 * commenters can comment and anchors survive concurrent edits via Yjs relative positions.
 */
export const CommentHighlights = Extension.create<CommentHighlightsOptions>({
  name: 'commentHighlights',

  addOptions() {
    return { onClick: null };
  },

  addCommands() {
    return {
      setComments:
        (comments, activeId = null) =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(commentsPluginKey, { comments, activeId }).setMeta('addToHistory', false);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const build = (state: EditorState, value: Omit<CommentsState, 'set'>): DecorationSet => {
      const decos: Decoration[] = [];
      for (const c of value.comments) {
        if (c.resolved || !c.anchor) continue;
        const range = resolveAnchor(state, c.anchor);
        if (!range) continue;
        decos.push(
          Decoration.inline(range.from, range.to, {
            class: c.id === value.activeId ? 'bee-comment bee-comment-active' : 'bee-comment',
            'data-comment-id': c.id,
          }),
        );
      }
      return DecorationSet.create(state.doc, decos);
    };
    return [
      new Plugin<CommentsState>({
        key: commentsPluginKey,
        state: {
          init: () => ({ comments: [], activeId: null, set: DecorationSet.empty }),
          apply: (tr, value, _old, newState) => {
            const meta = tr.getMeta(commentsPluginKey) as Omit<CommentsState, 'set'> | undefined;
            if (meta) return { ...meta, set: build(newState, meta) };
            if (!tr.docChanged) return value;
            // Remote (Yjs-originated) changes: Yjs and the PM doc agree, so resolve anchors afresh.
            // Local changes reach Yjs only after this transaction, so map the existing decorations.
            if (isChangeOrigin(tr)) return { ...value, set: build(newState, value) };
            return { ...value, set: value.set.map(tr.mapping, tr.doc) };
          },
        },
        props: {
          decorations: (state) => commentsPluginKey.getState(state)?.set,
          handleClick(_view, _pos, event) {
            const el = (event.target as HTMLElement | null)?.closest?.('[data-comment-id]');
            const id = el?.getAttribute('data-comment-id');
            if (id && options.onClick) options.onClick(id);
            return false;
          },
        },
      }),
    ];
  },
});

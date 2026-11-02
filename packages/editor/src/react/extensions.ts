import type { AnyExtension } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import Collaboration from '@tiptap/extension-collaboration';
import { Placeholder } from '@tiptap/extensions';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import { schemaExtensions } from '../schema/index.js';
import { BLOCK_ID_ATTR } from '../schema/block-id.js';
import { CodeBlockView } from './CodeBlockView.js';
import { WhiteboardView } from './WhiteboardView.js';
import { CommentHighlights } from './comments.js';
import { SlashCommand, type SlashHost } from './SlashMenu.js';
import { ImageUpload, type UploadImage } from './image-upload.js';
import { MarkdownPaste } from './markdown-paste.js';
import type { BeeUser } from './collab.js';
import { IdleCollaborationCaret } from './caret-idle.js';

export interface BuildOptions {
  ydoc?: Y.Doc;
  provider?: HocuspocusProvider;
  user?: BeeUser;
  editable: boolean;
  placeholder?: string;
  slash?: SlashHost;
  uploadImage?: UploadImage;
  onUploadError?: (err: unknown) => void;
  onCommentClick?: (id: string) => void;
  /** Hide remote carets idle for this long; defaults to CURSOR_IDLE_MS. */
  cursorIdleMs?: number;
}

/** Schema extensions plus React node views and editing UI. */
export function buildExtensions(opts: BuildOptions): AnyExtension[] {
  const collaborative = !!opts.ydoc;
  const base = schemaExtensions({ collaborative }).map((ext) => {
    if (ext.name === 'codeBlock') return ext.extend({ addNodeView: () => ReactNodeViewRenderer(CodeBlockView) });
    if (ext.name === 'whiteboard') {
      return ext.extend({
        addNodeView: () =>
          ReactNodeViewRenderer(WhiteboardView, {
            // Excalidraw owns all input inside the board; ProseMirror must not handle it.
            stopEvent: ({ event }) => !!(event.target as HTMLElement | null)?.closest?.('.bee-embed-body'),
            ignoreMutation: () => true,
          }),
      });
    }
    // Read-only clients must not write block ids: the server would reject the change anyway.
    if (ext.name === 'uniqueID' && !opts.editable) return ext.configure({ updateDocument: false, attributeName: BLOCK_ID_ATTR });
    return ext;
  });

  const extensions: AnyExtension[] = [...base, CommentHighlights.configure({ onClick: opts.onCommentClick ?? null })];
  if (opts.placeholder) {
    extensions.push(
      Placeholder.configure({
        placeholder: ({ node, editor }) => (editor.isEmpty || node.type.name === 'paragraph' ? opts.placeholder! : ''),
        showOnlyCurrent: true,
      }),
    );
  }
  if (opts.editable) {
    extensions.push(MarkdownPaste);
    if (opts.slash) extensions.push(SlashCommand.configure({ host: opts.slash }));
    if (opts.uploadImage) extensions.push(ImageUpload.configure({ upload: opts.uploadImage, onError: opts.onUploadError ?? null }));
  }
  if (opts.ydoc) {
    extensions.push(Collaboration.configure({ document: opts.ydoc, field: 'default' }));
    if (opts.provider && opts.user) {
      extensions.push(
        IdleCollaborationCaret.configure({
          provider: opts.provider,
          user: opts.user,
          ...(opts.cursorIdleMs ? { idleMs: opts.cursorIdleMs } : {}),
        }),
      );
    }
  }
  return extensions;
}

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
import { SheetView } from './sheet/SheetView.js';
import { CommentHighlights } from './comments.js';
import { SlashCommand, type SlashHost } from './SlashMenu.js';
import { ImageUpload, type UploadImage } from './image-upload.js';
import { MarkdownPaste } from './markdown-paste.js';
import type { BeeUser } from './collab.js';
import { IdleCollaborationCaret } from './caret-idle.js';
import { TableSheet } from './table-sheet.js';
import { TableResize, TableScrollCenter } from './table-resize.js';

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
  /** Public link token: appended to uploaded image URLs, since <img> requests cannot send the header. */
  shareToken?: string;
}

/** Adds `?share=` to Bee upload URLs so anonymous viewers of a public link can load them. */
export function withShareToken(src: string, shareToken: string | undefined): string {
  if (!shareToken || !src.startsWith('/api/uploads/') || /[?&]share=/.test(src)) return src;
  return `${src}${src.includes('?') ? '&' : '?'}share=${encodeURIComponent(shareToken)}`;
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
            stopEvent: ({ event }) =>
              !!(event.target as HTMLElement | null)?.closest?.('.bee-embed-body, .bee-embed-tools, .bee-embed-resize'),
            ignoreMutation: () => true,
          }),
      });
    }
    if (ext.name === 'sheet') {
      return ext.extend({
        // The document's Y.Doc, where the sheet's cells live (see sheet/commands.ts sheetDoc).
        addStorage: () => ({ ydoc: opts.ydoc ?? null }),
        addNodeView: () =>
          ReactNodeViewRenderer(SheetView, {
            // Univer owns all input inside the grid and its menus; ProseMirror must not handle it.
            stopEvent: ({ event }) => !!(event.target as HTMLElement | null)?.closest?.('.bee-ss-editor, .bee-ss-header input, .bee-ss-tools, .bee-ss-name'),
            ignoreMutation: () => true,
          }),
      });
    }
    if (ext.name === 'image') {
      // Editors drag a corner to resize (width/height are stored on the node, aspect ratio kept).
      const image = ext.configure({
        inline: false,
        allowBase64: false,
        resize: opts.editable
          ? { enabled: true, directions: ['top-left', 'top-right', 'bottom-left', 'bottom-right'], minWidth: 48, minHeight: 24, alwaysPreserveAspectRatio: true }
          : false,
      });
      const token = opts.shareToken;
      if (!token) return image;
      // On the attribute, so both the plain <img> and the resizable node view get the token.
      return image.extend({
        addAttributes(this: { parent?: () => Record<string, object> }) {
          const parent = this.parent?.() ?? {};
          return {
            ...parent,
            src: { ...parent.src, renderHTML: (attrs: Record<string, unknown>) => ({ src: withShareToken(String(attrs.src ?? ''), token) }) },
          };
        },
      });
    }
    // Read-only clients must not write block ids: the server would reject the change anyway.
    if (ext.name === 'uniqueID' && !opts.editable) return ext.configure({ updateDocument: false, attributeName: BLOCK_ID_ATTR });
    return ext;
  });

  const extensions: AnyExtension[] = [
    ...base,
    CommentHighlights.configure({ onClick: opts.onCommentClick ?? null }),
    TableSheet.configure({ headers: opts.editable }),
    TableScrollCenter,
  ];
  if (opts.placeholder) {
    extensions.push(
      Placeholder.configure({
        placeholder: ({ node, editor }) => (editor.isEmpty || node.type.name === 'paragraph' ? opts.placeholder! : ''),
        showOnlyCurrent: true,
      }),
    );
  }
  if (opts.editable) {
    extensions.push(MarkdownPaste, TableResize);
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

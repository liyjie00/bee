import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export type UploadImage = (file: File) => Promise<string>;

/** Uploads image files and inserts them at `pos` (or the selection). */
export async function insertImages(editor: Editor, files: File[], upload: UploadImage, pos?: number, onError?: (err: unknown) => void) {
  for (const file of files.filter((f) => f.type.startsWith('image/'))) {
    try {
      const src = await upload(file);
      if (editor.isDestroyed) return;
      const content = { type: 'image', attrs: { src, alt: file.name.replace(/\.[^.]+$/, '') } };
      if (pos === undefined) editor.chain().focus().insertContent(content).run();
      else editor.chain().insertContentAt(Math.min(pos, editor.state.doc.content.size), content).run();
    } catch (err) {
      onError?.(err);
    }
  }
}

/** Paste and drop of image files go through the host's upload endpoint, never base64. */
export const ImageUpload = Extension.create<{ upload: UploadImage | null; onError: ((err: unknown) => void) | null }>({
  name: 'beeImageUpload',

  addOptions() {
    return { upload: null, onError: null };
  },

  addProseMirrorPlugins() {
    const { upload, onError } = this.options;
    const editor = this.editor;
    if (!upload) return [];
    return [
      new Plugin({
        key: new PluginKey('beeImageUpload'),
        props: {
          handlePaste(_view, event) {
            const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
            if (!files.length) return false;
            void insertImages(editor, files, upload, undefined, onError ?? undefined);
            return true;
          },
          handleDrop(view, event) {
            const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
            if (!files.length) return false;
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            void insertImages(editor, files, upload, pos, onError ?? undefined);
            return true;
          },
        },
      }),
    ];
  },
});

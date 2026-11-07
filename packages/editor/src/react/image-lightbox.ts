import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { LightboxContent } from './Lightbox.js';

/** The image node's <img> under the event, if any (not images inside embeds such as sheets). */
function imageTarget(view: EditorView, event: Event): HTMLImageElement | null {
  const img = (event.target as HTMLElement | null)?.closest?.('img');
  if (!img || !view.dom.contains(img)) return null;
  try {
    const pos = view.posAtDOM(img, 0);
    const $pos = view.state.doc.resolve(pos);
    if ($pos.nodeAfter?.type.name === 'image' || $pos.nodeBefore?.type.name === 'image') return img;
  } catch {
    // Not inside a ProseMirror node.
  }
  return null;
}

/**
 * Opens document images in the lightbox: a click when reading, a double click when editing (a single
 * click there selects the image so it can be resized, moved or deleted).
 */
export const ImageLightbox = Extension.create<{ open: ((content: LightboxContent) => void) | null }>({
  name: 'beeImageLightbox',

  addOptions() {
    return { open: null };
  },

  addProseMirrorPlugins() {
    const { open } = this.options;
    if (!open) return [];
    const show = (view: EditorView, event: MouseEvent, when: 'click' | 'dblclick') => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return false;
      if ((when === 'click') === view.editable) return false;
      const img = imageTarget(view, event);
      if (!img) return false;
      event.preventDefault();
      open({ src: img.currentSrc || img.src, alt: img.alt || undefined });
      return true;
    };
    return [
      new Plugin({
        key: new PluginKey('beeImageLightbox'),
        props: {
          handleDOMEvents: {
            click: (view, event) => show(view, event, 'click'),
            dblclick: (view, event) => show(view, event, 'dblclick'),
          },
        },
      }),
    ];
  },
});

import type { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { BLOCK_ID_ATTR } from '../schema/block-id.js';

/** `/d/<docId>#b-<blockId>` — the shareable link to one block. */
export function blockLink(origin: string, documentId: string, blockId: string, shareToken?: string): string {
  const base = shareToken ? `${origin}/s/${shareToken}` : `${origin}/d/${documentId}`;
  return `${base}#b-${blockId}`;
}

/** Reads the block id from a location hash like `#b-abc123`. */
export function blockIdFromHash(hash: string): string | null {
  const m = /^#b-([A-Za-z0-9_-]+)$/.exec(hash);
  return m ? m[1]! : null;
}

export function findBlockPos(editor: Editor, blockId: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.attrs[BLOCK_ID_ATTR] === blockId) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Scrolls to a block and briefly highlights it. Returns false when the block no longer exists, so
 * the caller can show "该段落已不存在".
 */
export function scrollToBlock(editor: Editor, blockId: string): boolean {
  const pos = findBlockPos(editor, blockId);
  if (pos === null) return false;
  const dom = editor.view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return false;
  dom.scrollIntoView({ block: 'center', behavior: 'smooth' });
  dom.classList.remove('bee-landed');
  // Restart the animation even if the class was just applied.
  void dom.offsetWidth;
  dom.classList.add('bee-landed');
  setTimeout(() => dom.classList.remove('bee-landed'), 2600);
  return true;
}

/**
 * The block under a viewport point: the innermost node with a block id, except that a paragraph
 * directly inside a list item resolves to the list item.
 */
export function blockAtCoords(view: EditorView, x: number, y: number): { blockId: string; dom: HTMLElement } | null {
  const hit = view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const $pos = view.state.doc.resolve(hit.inside >= 0 ? hit.inside : hit.pos);
  // `inside` points at the node itself; check it first.
  const candidates: { pos: number; id: unknown; type: string; parentHasId: boolean }[] = [];
  if (hit.inside >= 0) {
    const node = view.state.doc.nodeAt(hit.inside);
    if (node) candidates.push({ pos: hit.inside, id: node.attrs[BLOCK_ID_ATTR], type: node.type.name, parentHasId: false });
  }
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    candidates.push({
      pos: $pos.before(d),
      id: node.attrs[BLOCK_ID_ATTR],
      type: node.type.name,
      parentHasId: d > 1 && !!$pos.node(d - 1).attrs[BLOCK_ID_ATTR],
    });
  }
  for (const c of candidates) {
    if (typeof c.id !== 'string' || !c.id) continue;
    if (c.type === 'paragraph' && c.parentHasId) continue;
    const dom = view.nodeDOM(c.pos);
    if (dom instanceof HTMLElement) return { blockId: c.id, dom };
  }
  return null;
}

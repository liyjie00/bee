import {
  jsonToText,
  markdownToYUpdate,
  yUpdateBlockIds,
  yUpdateToJSON,
  yUpdateToMarkdown,
  type JSONNode,
} from '@bee/editor/markdown';

/** Derived caches stored next to ydoc_state. */
export interface ContentCaches {
  markdown: string;
  text: string;
  blockIds: string[];
}

export function deriveCaches(update: Uint8Array): ContentCaches {
  const json = yUpdateToJSON(update);
  return {
    markdown: yUpdateToMarkdown(update),
    text: jsonToText(json),
    blockIds: [...yUpdateBlockIds(update)],
  };
}

export function contentJSON(update: Uint8Array): { content: JSONNode; text: string } {
  const content = yUpdateToJSON(update);
  return { content, text: jsonToText(content) };
}

export { markdownToYUpdate, yUpdateToMarkdown };

export function snippet(text: string | null, q: string, len = 160): string {
  if (!text) return '';
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  const start = Math.max(0, i < 0 ? 0 : i - 40);
  return (
    (start > 0 ? '…' : '') +
    text
      .slice(start, start + len)
      .replace(/\s+/g, ' ')
      .trim()
  );
}

const textOf = (n: JSONNode): string => n.text ?? (n.content ?? []).map(textOf).join('');
const hasBlock = (n: JSONNode, id: string): boolean =>
  n.attrs?.blockId === id || (n.content ?? []).some((c) => hasBlock(c, id));

/** Text of the heading a block sits under (the block itself when it is a heading). */
export function sectionOf(update: Uint8Array, blockId: string): string | null {
  let heading: string | null = null;
  for (const n of yUpdateToJSON(update).content ?? []) {
    if (n.type === 'heading') heading = textOf(n).trim() || heading;
    if (hasBlock(n, blockId)) return heading;
  }
  return null;
}

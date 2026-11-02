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

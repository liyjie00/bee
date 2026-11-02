import * as Y from 'yjs';
import { BLOCK_ID_ATTR } from '../schema/block-id.js';
import { markdownToJSON } from './from-markdown.js';
import { jsonToMarkdown } from './to-markdown.js';
import type { JSONNode } from './types.js';
import { jsonToYUpdate, RICH_TEXT_FIELD, yDocToJSON } from './index.js';

export interface ApplyResult {
  /** top-level blocks kept as they were */
  kept: number;
  /** top-level blocks removed / inserted */
  removed: number;
  inserted: number;
}

const blockKey = (node: JSONNode) => jsonToMarkdown({ type: 'doc', content: [node] }).trim();

type Op = { op: 'keep' } | { op: 'del' } | { op: 'ins'; index: number };

/** Longest common subsequence alignment of two key lists, as keep/del/ins operations. */
function align(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ op: 'keep' });
      i++;
      j++;
    } else if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      ops.push({ op: 'del' });
      i++;
    } else {
      ops.push({ op: 'ins', index: j++ });
    }
  }
  return ops;
}

/** Yjs elements for top-level blocks, built through the Bee schema (block ids assigned). */
function yBlocks(blocks: JSONNode[], field: string): (Y.XmlElement | Y.XmlText)[] {
  if (!blocks.length) return [];
  const tmp = new Y.Doc();
  Y.applyUpdate(tmp, jsonToYUpdate({ type: 'doc', content: blocks }, field));
  return tmp
    .getXmlFragment(field)
    .toArray()
    .map((c) => (c as Y.XmlElement | Y.XmlText).clone());
}

/**
 * Applies Markdown to a live document as ordinary Yjs operations, so connected editors see the
 * change like any other edit.
 *
 * `replace` makes the document equal to `markdown`, but only touches top-level blocks whose
 * Markdown changed: untouched blocks keep their Yjs items, block ids and comment anchors (and
 * content Markdown cannot express, such as embedded whiteboards). A block replaced one-for-one by
 * a block of the same type keeps its block id, so block links survive small edits.
 * `append` adds the blocks at the end.
 */
export function applyMarkdown(
  ydoc: Y.Doc,
  markdown: string,
  mode: 'replace' | 'append',
  field = RICH_TEXT_FIELD,
): ApplyResult {
  const next = markdownToJSON(markdown).content ?? [];
  const fragment = ydoc.getXmlFragment(field);
  if (mode === 'append') {
    // Drop a lone empty paragraph (a fresh document) so the appended content starts at the top.
    const cur = yDocToJSON(ydoc, field).content ?? [];
    const empty = cur.length === 1 && cur[0]!.type === 'paragraph' && !cur[0]!.content?.length;
    const items = yBlocks(next, field);
    ydoc.transact(() => {
      if (empty && items.length) fragment.delete(0, 1);
      fragment.insert(fragment.length, items);
    });
    return { kept: empty ? 0 : cur.length, removed: empty && items.length ? 1 : 0, inserted: items.length };
  }

  const cur = yDocToJSON(ydoc, field).content ?? [];
  const ops = align(cur.map(blockKey), next.map(blockKey));
  // Pair a run of deletions with the insertions that follow it: same-type pairs keep the block id.
  const ids = new Map<number, string>();
  for (let k = 0; k < ops.length; ) {
    if (ops[k]!.op !== 'del') {
      k++;
      continue;
    }
    const dels: number[] = [];
    let oldIndex = ops.slice(0, k).filter((o) => o.op !== 'ins').length;
    while (k < ops.length && ops[k]!.op === 'del') {
      dels.push(oldIndex++);
      k++;
    }
    let d = 0;
    while (k < ops.length && ops[k]!.op === 'ins') {
      const ins = ops[k] as { op: 'ins'; index: number };
      const old = dels[d++];
      const id = old !== undefined ? cur[old]!.attrs?.[BLOCK_ID_ATTR] : undefined;
      if (typeof id === 'string' && cur[old!]!.type === next[ins.index]!.type) ids.set(ins.index, id);
      k++;
    }
  }
  const withIds = next.map((node, i) =>
    ids.has(i) ? { ...node, attrs: { ...node.attrs, [BLOCK_ID_ATTR]: ids.get(i) } } : node,
  );

  const result: ApplyResult = { kept: 0, removed: 0, inserted: 0 };
  ydoc.transact(() => {
    let pos = 0;
    let k = 0;
    while (k < ops.length) {
      const o = ops[k]!;
      if (o.op === 'keep') {
        pos++;
        result.kept++;
        k++;
      } else if (o.op === 'del') {
        let count = 0;
        while (k < ops.length && ops[k]!.op === 'del') {
          count++;
          k++;
        }
        fragment.delete(pos, count);
        result.removed += count;
      } else {
        const batch: JSONNode[] = [];
        while (k < ops.length && ops[k]!.op === 'ins') batch.push(withIds[(ops[k++] as { index: number }).index]!);
        const items = yBlocks(batch, field);
        fragment.insert(pos, items);
        pos += items.length;
        result.inserted += items.length;
      }
    }
    // Tiptap needs at least one block.
    if (fragment.length === 0) fragment.insert(0, yBlocks([{ type: 'paragraph' }], field));
  });
  return result;
}

/** Helpers over ProseMirror JSON (version snapshots from the API). DOM-free so they are unit-testable. */
import { diffArrays } from 'diff';

interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
}

export interface Block {
  kind: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'li' | 'task' | 'code' | 'quote' | 'embed' | 'hr';
  text: string;
  checked?: boolean;
  blockId?: string;
}

function inline(n: PMNode | undefined): string {
  if (!n) return '';
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'mention') return '@' + String(n.attrs?.label ?? n.attrs?.id ?? '');
  return (n.content ?? []).map(inline).join('');
}

/** Placeholder text for non-text blocks in diffs (language-neutral). */
const EMBED_LABEL: Record<string, string> = {
  image: '🖼',
  whiteboard: '▦',
  whiteboardEmbed: '▦',
  mermaid: '⧉',
};

/** Flattens a document into comparable blocks (one per paragraph, heading, list item, ...). */
export function toBlocks(doc: unknown): Block[] {
  const out: Block[] = [];
  const walk = (n: PMNode, inList: 'li' | 'task' | null) => {
    const blockId = typeof n.attrs?.blockId === 'string' ? n.attrs.blockId : undefined;
    switch (n.type) {
      case 'doc':
      case 'bulletList':
      case 'orderedList':
        n.content?.forEach((c) => walk(c, n.type === 'doc' ? null : 'li'));
        return;
      case 'taskList':
        n.content?.forEach((c) => walk(c, 'task'));
        return;
      case 'listItem':
      case 'taskItem': {
        const [first, ...rest] = n.content ?? [];
        out.push({
          kind: n.type === 'taskItem' ? 'task' : 'li',
          text: inline(first),
          checked: n.type === 'taskItem' ? Boolean(n.attrs?.checked) : undefined,
          blockId: blockId ?? (typeof first?.attrs?.blockId === 'string' ? first.attrs.blockId : undefined),
        });
        rest.forEach((c) => walk(c, inList));
        return;
      }
      case 'heading': {
        const lv = Number(n.attrs?.level ?? 2);
        out.push({ kind: `h${Math.min(Math.max(lv, 1), 6)}` as Block['kind'], text: inline(n), blockId });
        return;
      }
      case 'codeBlock':
        out.push({ kind: 'code', text: inline(n), blockId });
        return;
      case 'blockquote':
        out.push({ kind: 'quote', text: (n.content ?? []).map(inline).join('\n'), blockId });
        return;
      case 'horizontalRule':
        out.push({ kind: 'hr', text: '', blockId });
        return;
      case 'table':
        out.push({
          kind: 'embed',
          text:
            '▤ ' +
            (n.content ?? []).map((row) => (row.content ?? []).map((cell) => inline({ type: 'x', content: cell.content })).join(' | ')).join(' / '),
          blockId,
        });
        return;
      case 'paragraph':
        out.push({ kind: inList ?? 'p', text: inline(n), blockId });
        return;
      default:
        if (n.content?.some((c) => c.type === 'text')) out.push({ kind: 'p', text: inline(n), blockId });
        else out.push({ kind: 'embed', text: `[${EMBED_LABEL[n.type] ?? n.type}]`, blockId });
    }
  };
  if (doc && typeof doc === 'object') walk(doc as PMNode, null);
  return out;
}

export function docText(doc: unknown): string {
  return toBlocks(doc)
    .map((b) => b.text)
    .join('\n');
}

export type Piece = { text: string; op: 'same' | 'ins' | 'del' };
export interface DiffBlock {
  kind: Block['kind'];
  checked?: boolean;
  /** whole-block insert/delete, or 'same' with inline pieces */
  op: 'same' | 'ins' | 'del' | 'mod';
  pieces: Piece[];
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
function tokens(s: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  return s.split(/(\s+)/).filter(Boolean);
}

export function diffText(a: string, b: string): Piece[] {
  const out: Piece[] = [];
  for (const part of diffArrays(tokens(a), tokens(b))) {
    const op = part.added ? 'ins' : part.removed ? 'del' : 'same';
    const text = part.value.join('');
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ text, op });
  }
  return out;
}

const key = (b: Block) => `${b.kind}\u0000${b.text}\u0000${b.checked ? 1 : 0}`;

/**
 * Diff of two documents from `older` to `newer`. Blocks are aligned first; an adjacent
 * removed/added run of the same length is shown as in-place word changes.
 */
export function diffDocs(older: unknown, newer: unknown): DiffBlock[] {
  const a = toBlocks(older);
  const b = toBlocks(newer);
  const parts = diffArrays(a.map(key), b.map(key));
  const out: DiffBlock[] = [];
  let ai = 0;
  let bi = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const n = p.count ?? p.value.length;
    if (!p.added && !p.removed) {
      for (let k = 0; k < n; k++) {
        const blk = b[bi + k]!;
        out.push({ kind: blk.kind, checked: blk.checked, op: 'same', pieces: [{ text: blk.text, op: 'same' }] });
      }
      ai += n;
      bi += n;
      continue;
    }
    const next = parts[i + 1];
    if (p.removed && next?.added) {
      const m = next.count ?? next.value.length;
      const pairs = Math.min(n, m);
      for (let k = 0; k < pairs; k++) {
        const o = a[ai + k]!;
        const nw = b[bi + k]!;
        out.push({ kind: nw.kind, checked: nw.checked, op: 'mod', pieces: diffText(o.text, nw.text) });
      }
      for (let k = pairs; k < n; k++) out.push(whole(a[ai + k]!, 'del'));
      for (let k = pairs; k < m; k++) out.push(whole(b[bi + k]!, 'ins'));
      ai += n;
      bi += m;
      i++;
      continue;
    }
    if (p.removed) {
      for (let k = 0; k < n; k++) out.push(whole(a[ai + k]!, 'del'));
      ai += n;
    } else {
      for (let k = 0; k < n; k++) out.push(whole(b[bi + k]!, 'ins'));
      bi += n;
    }
  }
  return out;
}

const whole = (blk: Block, op: 'ins' | 'del'): DiffBlock => ({
  kind: blk.kind,
  checked: blk.checked,
  op,
  pieces: [{ text: blk.text, op }],
});

export function diffStats(diff: DiffBlock[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const d of diff)
    for (const p of d.pieces) {
      if (p.op === 'ins') added += [...p.text].length;
      if (p.op === 'del') removed += [...p.text].length;
    }
  return { added, removed };
}

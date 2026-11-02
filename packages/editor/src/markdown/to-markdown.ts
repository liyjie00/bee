import type { JSONMark, JSONNode } from './types.js';

const MARK_DELIMS: Record<string, string> = { bold: '**', italic: '_', strike: '~~', code: '`' };

function escapeText(text: string): string {
  return text.replace(/([\\`*_~[\]#<>|])/g, '\\$1');
}

function markOpen(mark: JSONMark): string {
  if (mark.type === 'link') return '[';
  return MARK_DELIMS[mark.type] ?? '';
}

function markClose(mark: JSONMark): string {
  if (mark.type === 'link') return `](${String(mark.attrs?.href ?? '')})`;
  return MARK_DELIMS[mark.type] ?? '';
}

const sameMark = (a: JSONMark, b: JSONMark) =>
  a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});

function inline(nodes: JSONNode[] = []): string {
  let out = '';
  let open: JSONMark[] = [];
  const closeTo = (keep: number) => {
    while (open.length > keep) out += markClose(open.pop()!);
  };
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      closeTo(0);
      out += '\\\n';
      continue;
    }
    if (node.type === 'image') {
      closeTo(0);
      out += `![${String(node.attrs?.alt ?? '')}](${String(node.attrs?.src ?? '')})`;
      continue;
    }
    if (node.type !== 'text' || !node.text) continue;
    const marks = (node.marks ?? []).filter((m) => m.type === 'link' || m.type in MARK_DELIMS);
    // Keep the common prefix of already-open marks, close the rest.
    let keep = 0;
    while (keep < open.length && keep < marks.length && sameMark(open[keep]!, marks[keep]!)) keep++;
    closeTo(keep);
    for (const m of marks.slice(keep)) {
      out += markOpen(m);
      open.push(m);
    }
    const isCode = marks.some((m) => m.type === 'code');
    out += isCode ? node.text : escapeText(node.text);
  }
  closeTo(0);
  open = [];
  return out;
}

function indent(text: string, prefix: string, first = prefix): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? first + line : line ? prefix + line : line))
    .join('\n');
}

function tableToMarkdown(node: JSONNode): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((c) => (c.type === 'paragraph' ? inline(c.content) : block(c)))
        .join(' ')
        .replace(/\n/g, ' ')
        .replace(/\|/g, '\\|'),
    ),
  );
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  const line = (r: string[]) => `| ${pad(r).join(' | ')} |`;
  const [head, ...body] = rows;
  return [line(head!), `|${' --- |'.repeat(width)}`, ...body.map(line)].join('\n');
}

function listToMarkdown(node: JSONNode): string {
  const ordered = node.type === 'orderedList';
  let n = Number(node.attrs?.start ?? 1);
  return (node.content ?? [])
    .map((item) => {
      let marker = ordered ? `${n++}. ` : '- ';
      if (item.type === 'taskItem') marker += item.attrs?.checked ? '[x] ' : '[ ] ';
      const body = blocks(item.content, '\n');
      return indent(body, ' '.repeat(ordered ? marker.length - (item.type === 'taskItem' ? 4 : 0) : 2), marker);
    })
    .join('\n');
}

function block(node: JSONNode): string {
  switch (node.type) {
    case 'paragraph':
      return inline(node.content);
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${inline(node.content)}`;
    case 'blockquote':
      return indent(blocks(node.content), '> ', '> ').replace(/^$/gm, '>');
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listToMarkdown(node);
    case 'codeBlock': {
      const text = (node.content ?? []).map((t) => t.text ?? '').join('');
      const fence = text.includes('```') ? '````' : '```';
      return `${fence}${String(node.attrs?.language ?? '')}\n${text}\n${fence}`;
    }
    case 'horizontalRule':
      return '---';
    case 'image':
      return `![${String(node.attrs?.alt ?? '')}](${String(node.attrs?.src ?? '')})`;
    case 'table':
      return tableToMarkdown(node);
    case 'whiteboard':
      return `<!-- bee:whiteboard ${String(node.attrs?.documentId ?? '')}${node.attrs?.linked ? ' linked' : ''} -->`;
    default:
      return node.content ? blocks(node.content) : '';
  }
}

function blocks(nodes: JSONNode[] = [], sep = '\n\n'): string {
  // Empty paragraphs are spacing in the editor; Markdown has no equivalent.
  return nodes
    .map(block)
    .filter((md, i) => md !== '' || nodes[i]!.type !== 'paragraph')
    .join(sep);
}

/** Serializes Tiptap/ProseMirror JSON to GitHub-flavoured Markdown. */
export function jsonToMarkdown(doc: JSONNode): string {
  const md = blocks(doc.content);
  return md ? `${md}\n` : '';
}

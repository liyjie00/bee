import { Marked, type Token, type TokenizerExtension, type Tokens } from 'marked';
import { INLINE_DOLLAR_MATH } from '../schema/math.js';
import type { JSONMark, JSONNode } from './types.js';

interface MathToken {
  type: 'inlineMath' | 'blockMath';
  raw: string;
  latex: string;
}

/** `$$…$$` or `\[…\]` on lines of their own. */
const BLOCK_MATH = /^ {0,3}(?:\$\$([^]+?)\$\$|\\\[([^]+?)\\\]) *(?:\n+|$)/;
const INLINE_MATH = [/^\$\$((?:\\.|[^\\$])+?)\$\$/, INLINE_DOLLAR_MATH, /^\\\(((?:\\.|[^\\\n])+?)\\\)/];

const mathExtensions: TokenizerExtension[] = [
  {
    name: 'blockMath',
    level: 'block',
    start: (src) => /^ {0,3}(?:\$\$|\\\[)/m.exec(src)?.index,
    tokenizer(src) {
      const m = BLOCK_MATH.exec(src);
      if (!m) return undefined;
      const latex = (m[1] ?? m[2] ?? '').trim();
      return latex ? ({ type: 'blockMath', raw: m[0], latex } satisfies MathToken) : undefined;
    },
  },
  {
    name: 'inlineMath',
    level: 'inline',
    // Stop at every backslash too, so `\$` reaches marked's escape rule instead of opening math.
    start: (src) => /[$\\]/.exec(src)?.index,
    tokenizer(src) {
      for (const re of INLINE_MATH) {
        const m = re.exec(src);
        if (m?.[1]?.trim()) return { type: 'inlineMath', raw: m[0], latex: m[1].trim() } satisfies MathToken;
      }
      return undefined;
    },
  },
];

const marked = new Marked({ gfm: true, extensions: mathExtensions });

const WHITEBOARD_COMMENT = /^<!--\s*bee:whiteboard\s+([A-Za-z0-9_-]+)((?:\s+[a-z]+(?:=[-\w.,]+)?)*)\s*-->\s*$/;
const COLUMNS_MARK = /^<!--\s*bee:(columns|column|\/columns)\s*-->\s*$/;

/** Whiteboard attributes from the options after its id (see whiteboardOptions in to-markdown). */
function whiteboardAttrs(id: string, options: string): Record<string, unknown> {
  const attrs: Record<string, unknown> = { documentId: id };
  for (const opt of options.trim().split(/\s+/).filter(Boolean)) {
    const [k, v] = opt.split('=') as [string, string | undefined];
    if (k === 'linked') attrs.linked = true;
    else if ((k === 'width' || k === 'height') && Number(v) > 0) attrs[k] = Number(v);
    else if (k === 'align' && (v === 'left' || v === 'right' || v === 'center')) attrs.align = v;
    else if (k === 'view' && v) attrs.view = v;
  }
  return attrs;
}

/** `<!-- bee:sheet <id> name="…" -->`, followed by the sheet's values as a Markdown table (ignored on import). */
const SHEET_COMMENT = /^<!--\s*bee:sheet\s+([A-Za-z0-9_-]+)(?:\s[^]*?)?-->\s*$/;
const sheetMark = (token: Token) =>
  token.type === 'html' ? (SHEET_COMMENT.exec((token as Tokens.HTML).text.trim())?.[1] ?? null) : null;

const columnsMark = (token: Token) =>
  token.type === 'html' ? (COLUMNS_MARK.exec((token as Tokens.HTML).text.trim())?.[1] ?? null) : null;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function inline(tokens: Token[] = [], marks: JSONMark[] = []): JSONNode[] {
  const out: JSONNode[] = [];
  const text = (t: string, m = marks) => {
    if (!t) return;
    // Our tokenizer stops at every `$` and `\`, so plain text arrives in pieces: join them.
    const last = out[out.length - 1];
    if (last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(m)) last.text += t;
    else out.push(m.length ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
  };
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'escape': {
        const t = token as Tokens.Text;
        if (t.tokens?.length) out.push(...inline(t.tokens, marks));
        else text(decodeEntities(t.text));
        break;
      }
      case 'strong':
        out.push(...inline((token as Tokens.Strong).tokens, [...marks, { type: 'bold' }]));
        break;
      case 'em':
        out.push(...inline((token as Tokens.Em).tokens, [...marks, { type: 'italic' }]));
        break;
      case 'del':
        out.push(...inline((token as Tokens.Del).tokens, [...marks, { type: 'strike' }]));
        break;
      case 'codespan':
        text(decodeEntities((token as Tokens.Codespan).text), [...marks, { type: 'code' }]);
        break;
      case 'link': {
        const l = token as Tokens.Link;
        out.push(...inline(l.tokens, [...marks, { type: 'link', attrs: { href: l.href } }]));
        break;
      }
      case 'br':
        out.push({ type: 'hardBreak' });
        break;
      case 'image':
        // Inline images are hoisted to block level by the caller.
        out.push({ type: 'image', attrs: { src: (token as Tokens.Image).href, alt: (token as Tokens.Image).text || null } });
        break;
      case 'html':
        text((token as Tokens.HTML).text);
        break;
      case 'inlineMath':
        out.push({ type: 'inlineMath', attrs: { latex: (token as unknown as MathToken).latex } });
        break;
      default:
        if ('text' in token && typeof token.text === 'string') text(token.text);
    }
  }
  return out;
}

/** Paragraph content, splitting out images into their own block nodes (Image is a block node here). */
function paragraphs(tokens: Token[] | undefined): JSONNode[] {
  const nodes = inline(tokens);
  const out: JSONNode[] = [];
  let run: JSONNode[] = [];
  const flush = () => {
    if (run.length) out.push({ type: 'paragraph', content: run });
    run = [];
  };
  for (const n of nodes) {
    if (n.type === 'image') {
      flush();
      out.push(n);
    } else run.push(n);
  }
  flush();
  return out.length ? out : [{ type: 'paragraph' }];
}

function listItem(item: Tokens.ListItem, isTask: boolean): JSONNode {
  const content = blocks(item.tokens, true);
  return {
    type: isTask ? 'taskItem' : 'listItem',
    ...(isTask ? { attrs: { checked: !!item.checked } } : {}),
    content: content.length && content[0]!.type === 'paragraph' ? content : [{ type: 'paragraph' }, ...content],
  };
}

function block(token: Token, inList: boolean): JSONNode[] {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading;
      return [{ type: 'heading', attrs: { level: Math.min(t.depth, 6) }, content: inline(t.tokens) }];
    }
    case 'paragraph':
      return paragraphs((token as Tokens.Paragraph).tokens);
    case 'text': {
      // Tight list items carry bare text tokens.
      const t = token as Tokens.Text;
      return inList ? paragraphs(t.tokens ?? [{ type: 'text', raw: t.raw, text: t.text } as Token]) : paragraphs([t]);
    }
    case 'code': {
      const t = token as Tokens.Code;
      return [
        {
          type: 'codeBlock',
          attrs: { language: t.lang?.split(/\s/)[0] || null },
          content: t.text ? [{ type: 'text', text: t.text }] : undefined,
        },
      ];
    }
    case 'blockquote':
      return [{ type: 'blockquote', content: blocks((token as Tokens.Blockquote).tokens) }];
    case 'hr':
      return [{ type: 'horizontalRule' }];
    case 'list': {
      const t = token as Tokens.List;
      const isTask = t.items.some((i) => i.task);
      if (isTask) return [{ type: 'taskList', content: t.items.map((i) => listItem(i, true)) }];
      return [
        {
          type: t.ordered ? 'orderedList' : 'bulletList',
          ...(t.ordered && t.start !== '' && t.start !== 1 ? { attrs: { start: Number(t.start) } } : {}),
          content: t.items.map((i) => listItem(i, false)),
        },
      ];
    }
    case 'table': {
      const t = token as Tokens.Table;
      const cell = (c: Tokens.TableCell, header: boolean): JSONNode => ({
        type: header ? 'tableHeader' : 'tableCell',
        content: [{ type: 'paragraph', content: inline(c.tokens) }],
      });
      return [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: t.header.map((c) => cell(c, true)) },
            ...t.rows.map((r) => ({ type: 'tableRow', content: r.map((c) => cell(c, false)) })),
          ],
        },
      ];
    }
    case 'html': {
      const m = WHITEBOARD_COMMENT.exec((token as Tokens.HTML).text.trim());
      if (m) return [{ type: 'whiteboard', attrs: whiteboardAttrs(m[1]!, m[2] ?? '') }];
      return [];
    }
    case 'blockMath':
      return [{ type: 'blockMath', attrs: { latex: (token as unknown as MathToken).latex } }];
    case 'space':
      return [];
    default:
      return 'text' in token && typeof token.text === 'string' && token.text.trim()
        ? [{ type: 'paragraph', content: [{ type: 'text', text: token.text }] }]
        : [];
  }
}

function blocks(tokens: Token[] = [], inList = false): JSONNode[] {
  const out: JSONNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const sheetId = sheetMark(tokens[i]!);
    if (sheetId) {
      // The table after the marker is a read-only rendering of the sheet's values; the data stays in the doc.
      let j = i + 1;
      while (tokens[j]?.type === 'space') j++;
      if (tokens[j]?.type === 'table') i = j;
      out.push({ type: 'sheet', attrs: { sheetId } });
      continue;
    }
    if (columnsMark(tokens[i]!) !== 'columns') {
      out.push(...block(tokens[i]!, inList));
      continue;
    }
    // <!-- bee:columns --> … <!-- bee:column --> … <!-- bee:/columns -->
    const cols: Token[][] = [[]];
    for (i++; i < tokens.length; i++) {
      const mark = columnsMark(tokens[i]!);
      if (mark === '/columns') break;
      if (mark === 'column') cols.push([]);
      else cols[cols.length - 1]!.push(tokens[i]!);
    }
    const content = cols.slice(0, 4).map((c) => {
      const inner = blocks(c);
      return { type: 'column', content: inner.length ? inner : [{ type: 'paragraph' }] };
    });
    if (content.length >= 2) out.push({ type: 'columns', content });
    else out.push(...content[0]!.content);
  }
  return out;
}

/** Parses GitHub-flavoured Markdown into Tiptap JSON matching the Bee schema. */
export function markdownToJSON(markdown: string): JSONNode {
  const tokens = marked.lexer(markdown);
  const content = blocks(tokens);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

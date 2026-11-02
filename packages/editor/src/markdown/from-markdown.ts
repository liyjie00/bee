import { Lexer, type Token, type Tokens } from 'marked';
import type { JSONMark, JSONNode } from './types.js';

const WHITEBOARD_COMMENT = /^<!--\s*bee:whiteboard\s+([A-Za-z0-9_-]+)\s*-->\s*$/;

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
    out.push(m.length ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
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
      if (m) return [{ type: 'whiteboard', attrs: { documentId: m[1] } }];
      return [];
    }
    case 'space':
      return [];
    default:
      return 'text' in token && typeof token.text === 'string' && token.text.trim()
        ? [{ type: 'paragraph', content: [{ type: 'text', text: token.text }] }]
        : [];
  }
}

function blocks(tokens: Token[] = [], inList = false): JSONNode[] {
  return tokens.flatMap((t) => block(t, inList));
}

/** Parses GitHub-flavoured Markdown into Tiptap JSON matching the Bee schema. */
export function markdownToJSON(markdown: string): JSONNode {
  const tokens = new Lexer({ gfm: true }).lex(markdown);
  const content = blocks(tokens);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

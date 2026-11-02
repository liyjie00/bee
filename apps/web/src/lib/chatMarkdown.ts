import { Marked, type RendererThis, type Tokens } from 'marked';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const safeHref = (href: string) => /^(https?:|mailto:|\/(?!\/))/i.test(href.trim());

// Model output is untrusted (a document can carry prompt injections): no raw HTML, no
// images (they would load third-party URLs on render), links only to web pages and Bee.
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }: Tokens.HTML | Tokens.Tag) => esc(text),
    image: ({ text }: Tokens.Image) => esc(text),
    link(this: RendererThis, { href, tokens }: Tokens.Link): string {
      const inner: string = this.parser.parseInline(tokens);
      if (!safeHref(href)) return inner;
      const external = !href.startsWith('/') && !href.startsWith(location.origin);
      return `<a href="${esc(href)}"${external ? ' target="_blank" rel="noopener noreferrer nofollow"' : ''}>${inner}</a>`;
    },
  },
});

export const renderChatMarkdown = (text: string): string => md.parse(text, { async: false });

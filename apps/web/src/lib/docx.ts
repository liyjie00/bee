/* Word (.docx) export from the editor's JSON. Loaded on demand: the docx library is large. */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
  type ParagraphChild,
} from 'docx';

interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;
const MAX_IMAGE_WIDTH = 600;
const BULLET = 'bee-bullet';
const NUMBER = 'bee-number';
const CELL_FILL: Record<string, string> = {
  gray: 'EEF0EB',
  red: 'FBE1DF',
  orange: 'FDEBD3',
  yellow: 'FDF1D3',
  green: 'DCF3DD',
  blue: 'DCE8F8',
  purple: 'ECE3FB',
};

type Block = Paragraph | Table;

interface Ctx {
  /** list nesting depth, for numbering levels */
  depth: number;
  images: Map<string, { data: ArrayBuffer; type: 'png' | 'jpg' | 'gif' | 'bmp'; w: number; h: number } | null>;
  /** numbered lists restart per list */
  numberInstance: number;
}

function runs(nodes: Node[] | undefined, extra: Partial<IRunOptions> = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const n of nodes ?? []) {
    if (n.type === 'hardBreak') {
      out.push(new TextRun({ text: '', break: 1 }));
      continue;
    }
    if (n.type !== 'text' || !n.text) continue;
    const m = new Set((n.marks ?? []).map((x) => x.type));
    const opts: IRunOptions = {
      ...extra,
      text: n.text,
      bold: m.has('bold') || extra.bold,
      italics: m.has('italic'),
      underline: m.has('underline') ? {} : undefined,
      strike: m.has('strike'),
      ...(m.has('code') ? { font: 'Menlo', shading: { type: ShadingType.CLEAR, fill: 'EEF0EB', color: 'auto' } } : {}),
    };
    const href = n.marks?.find((x) => x.type === 'link')?.attrs?.href;
    if (typeof href === 'string' && href) {
      const link = new URL(href, location.href).href;
      out.push(new ExternalHyperlink({ link, children: [new TextRun({ ...opts, style: 'Hyperlink' })] }));
    } else out.push(new TextRun(opts));
  }
  return out;
}

function blocks(nodes: Node[] | undefined, ctx: Ctx): Block[] {
  return (nodes ?? []).flatMap((n) => block(n, ctx));
}

function block(n: Node, ctx: Ctx): Block[] {
  switch (n.type) {
    case 'paragraph':
      return [new Paragraph({ children: runs(n.content) })];
    case 'heading': {
      const level = Math.min(Math.max(Number(n.attrs?.level) || 1, 1), 6);
      return [new Paragraph({ heading: HEADINGS[level - 1], children: runs(n.content) })];
    }
    case 'blockquote':
      return quote(n, ctx);
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return list(n, ctx);
    case 'codeBlock': {
      const lines = (n.content ?? []).map((t) => t.text ?? '').join('').split('\n');
      return lines.map(
        (line) =>
          new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: 'F6F7F4', color: 'auto' },
            spacing: { after: 0 },
            children: [new TextRun({ text: line || ' ', font: 'Menlo', size: 19 })],
          }),
      );
    }
    case 'horizontalRule':
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CDD2C6', space: 1 } }, children: [] })];
    case 'image': {
      const src = String(n.attrs?.src ?? '');
      const img = ctx.images.get(src);
      if (!img) return [new Paragraph({ children: [new TextRun({ text: `[${String(n.attrs?.alt ?? 'image')}]`, italics: true })] })];
      const scale = Math.min(1, MAX_IMAGE_WIDTH / img.w);
      return [
        new Paragraph({
          children: [new ImageRun({ type: img.type, data: img.data, transformation: { width: Math.round(img.w * scale), height: Math.round(img.h * scale) } })],
        }),
      ];
    }
    case 'table':
      return [table(n, ctx), new Paragraph({ children: [] })];
    case 'columns':
      // Word has no side-by-side blocks here: columns become consecutive sections.
      return (n.content ?? []).flatMap((col) => blocks(col.content, ctx));
    case 'whiteboard':
      return [new Paragraph({ children: [new TextRun({ text: '[Whiteboard]', italics: true, color: '7B8375' })] })];
    default:
      return n.content ? blocks(n.content, ctx) : [];
  }
}

function quote(n: Node, ctx: Ctx): Block[] {
  return (n.content ?? []).flatMap((c) =>
    c.type === 'paragraph'
      ? [
          new Paragraph({
            indent: { left: 360 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'E8A317', space: 8 } },
            children: runs(c.content, { color: '4A5146' }),
          }),
        ]
      : block(c, ctx),
  );
}

function list(n: Node, ctx: Ctx): Block[] {
  const ordered = n.type === 'orderedList';
  const task = n.type === 'taskList';
  const instance = ordered ? ++ctx.numberInstance : 0;
  const level = Math.min(ctx.depth, 8);
  const out: Block[] = [];
  for (const item of n.content ?? []) {
    const [first, ...rest] = item.content ?? [];
    const prefix = task ? [new TextRun({ text: item.attrs?.checked ? '☑ ' : '☐ ' })] : [];
    out.push(
      new Paragraph({
        ...(task
          ? { indent: { left: 360 * (level + 1) } }
          : { numbering: { reference: ordered ? NUMBER : BULLET, level, ...(ordered ? { instance } : {}) } }),
        children: [...prefix, ...runs(first?.type === 'paragraph' ? first.content : [])],
      }),
    );
    if (first && first.type !== 'paragraph') out.push(...block(first, ctx));
    ctx.depth++;
    out.push(...blocks(rest, ctx));
    ctx.depth--;
  }
  return out;
}

function table(n: Node, ctx: Ctx): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: (n.content ?? []).map(
      (row) =>
        new TableRow({
          children: (row.content ?? []).map((cell) => {
            const header = cell.type === 'tableHeader';
            const fill = CELL_FILL[String(cell.attrs?.background ?? '')] ?? (header ? 'F6F7F4' : undefined);
            const align = cell.attrs?.align === 'center' ? AlignmentType.CENTER : cell.attrs?.align === 'right' ? AlignmentType.RIGHT : undefined;
            return new TableCell({
              columnSpan: Number(cell.attrs?.colspan) || 1,
              rowSpan: Number(cell.attrs?.rowspan) || 1,
              shading: fill ? { type: ShadingType.CLEAR, fill, color: 'auto' } : undefined,
              children: (cell.content ?? []).length
                ? (cell.content ?? []).flatMap((c) =>
                    c.type === 'paragraph'
                      ? [new Paragraph({ alignment: align, children: runs(c.content, header ? { bold: true } : {}) })]
                      : block(c, ctx),
                  )
                : [new Paragraph({ children: [] })],
            });
          }),
        }),
    ),
  });
}

function collectImages(n: Node, out: Set<string>) {
  if (n.type === 'image' && typeof n.attrs?.src === 'string') out.add(n.attrs.src);
  for (const c of n.content ?? []) collectImages(c, out);
}

async function loadImage(src: string): Promise<Ctx['images'] extends Map<string, infer V> ? V : never> {
  try {
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) return null;
    const blob = await res.blob();
    const mime = blob.type;
    const bitmap = await createImageBitmap(blob);
    const size = { w: bitmap.width, h: bitmap.height };
    if (mime === 'image/png' || mime === 'image/gif' || mime === 'image/bmp' || mime === 'image/jpeg')
      return { data: await blob.arrayBuffer(), type: mime === 'image/jpeg' ? 'jpg' : (mime.slice(6) as 'png' | 'gif' | 'bmp'), ...size };
    // Other formats (webp, svg): re-encode as PNG.
    const canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    return png ? { data: await png.arrayBuffer(), type: 'png', ...size } : null;
  } catch {
    return null;
  }
}

/** Builds a .docx from the editor's JSON, with the title as the first heading. */
export async function toDocx(title: string, doc: Node): Promise<Blob> {
  const srcs = new Set<string>();
  collectImages(doc, srcs);
  const images = new Map(await Promise.all([...srcs].map(async (s) => [s, await loadImage(s)] as const)));
  const ctx: Ctx = { depth: 0, images, numberInstance: 0 };
  const children: Block[] = [];
  if (title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }));
  children.push(...blocks(doc.content, ctx));
  const levels = (fmt: (typeof LevelFormat)[keyof typeof LevelFormat], text: (l: number) => string) =>
    Array.from({ length: 9 }, (_, level) => ({
      level,
      format: fmt,
      text: text(level),
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
    }));
  const file = new Document({
    creator: 'Bee',
    title,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: [
        { reference: BULLET, levels: levels(LevelFormat.BULLET, (l) => ['•', '◦', '▪'][l % 3]!) },
        { reference: NUMBER, levels: levels(LevelFormat.DECIMAL, (l) => `%${l + 1}.`) },
      ],
    },
    sections: [{ children }],
  });
  return Packer.toBlob(file);
}

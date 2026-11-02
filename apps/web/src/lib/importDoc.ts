/* Turns an imported file (Markdown, HTML, Word) into Markdown for a new Bee document. */
import { generateJSON } from '@tiptap/core';
import { schemaExtensions } from '@bee/editor';
import { jsonToMarkdown, type JSONNode } from '@bee/editor/markdown';

export const IMPORT_ACCEPT = '.md,.markdown,.txt,.html,.htm,.docx,text/markdown,text/plain,text/html,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface Imported {
  title: string;
  markdown: string;
  /** images to upload, by the placeholder URL used for them in `markdown` */
  images: Map<string, Blob>;
}

const IMG_PREFIX = 'bee-import-image:';

export function htmlToMarkdown(html: string): string {
  const json = generateJSON(html, schemaExtensions({ collaborative: false })) as JSONNode;
  return jsonToMarkdown(json);
}

/** The first H1 becomes the title (and is dropped from the body by the server). */
const titleOf = (markdown: string, fallback: string) => /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? fallback;

export async function importFile(file: File): Promise<Imported> {
  const base = file.name.replace(/\.(md|markdown|txt|html?|docx)$/i, '');
  const images = new Map<string, Blob>();
  let markdown: string;
  if (/\.docx$/i.test(file.name)) {
    const mammoth = await import('mammoth');
    let n = 0;
    const { value } = await mammoth.convertToHtml(
      { arrayBuffer: await file.arrayBuffer() },
      {
        // Word's Title style is the document's title.
        styleMap: ["p[style-name='Title'] => h1:fresh"],
        convertImage: mammoth.images.imgElement(async (img) => {
          const bytes = await img.readAsArrayBuffer();
          const src = `${IMG_PREFIX}${n++}`;
          images.set(src, new Blob([bytes], { type: img.contentType }));
          return { src };
        }),
      },
    );
    markdown = htmlToMarkdown(value);
  } else if (/\.html?$/i.test(file.name) || file.type === 'text/html') {
    const html = await file.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    markdown = htmlToMarkdown(doc.body.innerHTML);
    const t = doc.querySelector('title')?.textContent?.trim();
    if (t && !/^#\s/m.test(markdown)) markdown = `# ${t}\n\n${markdown}`;
  } else {
    markdown = await file.text();
  }
  return { title: titleOf(markdown, base), markdown, images };
}

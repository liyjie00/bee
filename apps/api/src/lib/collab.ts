import type { CommentAnchor, MarkdownEditBody } from '@bee/shared';
import type { Element } from './diagram.js';
import type { Config } from '../env.js';
import { HttpError } from './errors.js';

export interface CollabEditResult {
  markdown: string;
  kept: number;
  removed: number;
  inserted: number;
  occurrences?: number;
}

/** Client for the collab server's internal endpoints (it owns the live Yjs documents). */
export class CollabClient {
  constructor(private readonly config: Pick<Config, 'collabInternalUrl' | 'collabSecret'>) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('x-collab-secret', this.config.collabSecret);
    try {
      return await fetch(`${this.config.collabInternalUrl}/internal/documents/${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HttpError(
        503,
        'collab_unavailable',
        'The collaboration server is unavailable, try again',
      );
    }
  }

  /** Live Markdown when the document is open in an editor, otherwise the stored state. */
  async readMarkdown(documentId: string): Promise<string> {
    const res = await this.request(`${documentId}/markdown`);
    if (!res.ok) throw new HttpError(502, 'collab_failed', 'Could not read the document');
    return ((await res.json()) as { markdown: string }).markdown;
  }

  async editMarkdown(
    documentId: string,
    edit: MarkdownEditBody,
    authorId: string,
  ): Promise<CollabEditResult> {
    const res = await this.request(`${documentId}/markdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...edit, authorId }),
    });
    const body = (await res.json().catch(() => null)) as
      (CollabEditResult & { error?: { code: string; message: string } }) | null;
    if (!res.ok || !body) {
      const e = body?.error;
      if (e && res.status < 500) throw new HttpError(res.status, e.code, e.message);
      throw new HttpError(502, 'collab_failed', 'The edit could not be applied');
    }
    return body;
  }

  /** Comment anchor for the `occurrence`-th match of `quote` (409 when it does not occur). */
  async anchorFor(documentId: string, quote: string, occurrence = 1): Promise<CommentAnchor> {
    const res = await this.request(`${documentId}/anchor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quote, occurrence }),
    });
    const body = (await res.json().catch(() => null)) as {
      anchor?: CommentAnchor;
      error?: { code: string; message: string };
    } | null;
    if (res.ok && body?.anchor) return body.anchor;
    if (res.status === 409 && body?.error)
      throw new HttpError(409, 'quote_not_found', body.error.message);
    throw new HttpError(502, 'collab_failed', 'Could not anchor the comment');
  }

  /** All Excalidraw elements of a whiteboard (live when open), including deleted ones. */
  async whiteboardElements(documentId: string): Promise<Element[]> {
    const res = await this.request(`${documentId}/whiteboard`);
    if (!res.ok) throw new HttpError(502, 'collab_failed', 'Could not read the whiteboard');
    return ((await res.json()) as { elements: Element[] }).elements;
  }

  /** Upserts whiteboard elements as a live edit. */
  async putWhiteboardElements(documentId: string, elements: Element[], authorId: string) {
    const res = await this.request(`${documentId}/whiteboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ elements, authorId }),
    });
    if (!res.ok) throw new HttpError(502, 'collab_failed', 'Could not update the whiteboard');
  }

  /** Appends Tiptap JSON blocks to a rich-text document (e.g. a whiteboard embed). */
  async appendBlocks(documentId: string, blocks: unknown[], authorId: string) {
    const res = await this.request(`${documentId}/markdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'append_blocks', blocks, authorId }),
    });
    if (!res.ok) throw new HttpError(502, 'collab_failed', 'Could not update the document');
  }
}

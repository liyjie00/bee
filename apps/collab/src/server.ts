import { Server, type Extension } from '@hocuspocus/server';
import * as Y from 'yjs';
import { applyMarkdown, yDocToMarkdown } from '@bee/editor/markdown';
import { ApiClient, ApiError, type Role } from './api-client.js';
import type { CollabConfig } from './config.js';
import { replaceDocContent } from './restore.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export interface ConnectionContext {
  userId: string | null;
  role: Role;
}

interface VersionState {
  dirty: boolean;
  authors: Set<string>;
  /** Editors since the last successful store. */
  storeAuthors: Set<string>;
  lastSnapshotAt: number;
}

const DOCUMENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const RESTORE_PATH = /^\/internal\/documents\/([A-Za-z0-9_-]{1,64})\/restore$/;
const MARKDOWN_PATH = /^\/internal\/documents\/([A-Za-z0-9_-]{1,64})\/markdown$/;
const ANCHOR_PATH = /^\/internal\/documents\/([A-Za-z0-9_-]{1,64})\/anchor$/;
const MAX_INTERNAL_BODY = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_INTERNAL_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function secretMatches(header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body = '') {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(body);
}

function sendJSON(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Body of POST /internal/documents/:id/markdown. */
export interface MarkdownEdit {
  mode: 'replace' | 'append' | 'str_replace';
  /** replace / append */
  markdown?: string;
  /** str_replace: exact text of the current Markdown to find, and its replacement */
  find?: string;
  replace?: string;
  /** str_replace: replace every occurrence instead of requiring exactly one */
  replaceAll?: boolean;
  /** user the edit is attributed to (lastEditedBy, activity, version authors) */
  authorId?: string;
}

class EditError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Plain text of a Y.XmlText (embeds count as one character, like Yjs indices). */
const textOf = (t: Y.XmlText) =>
  (t.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === 'string' ? d.insert : '\ufffc')).join('');

/**
 * Comment anchor for the `occurrence`-th (1-based) match of `quote` inside one text run, in the same
 * shape the editor creates for a selection: `{ blockId, from, to, quote }` with Y.RelativePosition JSON.
 */
export interface QuoteAnchor {
  blockId: string;
  from: unknown;
  to: unknown;
  quote: string;
}

export function anchorForQuote(doc: Y.Doc, quote: string, occurrence = 1): QuoteAnchor | null {
  if (!quote) return null;
  let seen = 0;
  const walk = (node: Y.XmlFragment | Y.XmlElement, blockId: string): QuoteAnchor | null => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) {
        const text = textOf(child);
        for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) {
          if (++seen === occurrence)
            return {
              blockId,
              from: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(child, i, -1)),
              to: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(child, i + quote.length, -1)),
              quote: quote.slice(0, 500),
            };
        }
      } else if (child instanceof Y.XmlElement) {
        const id = child.getAttribute('blockId');
        const hit = walk(child, typeof id === 'string' && id ? id : blockId);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(doc.getXmlFragment(RICH_TEXT_FIELD), '');
}

/** Applies a Markdown edit to the live document. Throws EditError for edits that cannot apply. */
export function editDocument(doc: Y.Doc, edit: MarkdownEdit) {
  if (doc.share.has('elements')) throw new EditError('not_a_doc', 'Only rich-text documents can be edited as Markdown');
  if (edit.mode === 'str_replace') {
    const find = edit.find ?? '';
    if (!find) throw new EditError('validation', '`find` must not be empty');
    const current = yDocToMarkdown(doc, RICH_TEXT_FIELD);
    const count = current.split(find).length - 1;
    if (count === 0) throw new EditError('not_found', 'The text to find does not occur in the document Markdown');
    if (count > 1 && !edit.replaceAll)
      throw new EditError('ambiguous', `The text to find occurs ${count} times; add more context or set replaceAll`);
    const next = current.split(find).join(edit.replace ?? '');
    return { ...applyMarkdown(doc, next, 'replace', RICH_TEXT_FIELD), occurrences: count };
  }
  if (typeof edit.markdown !== 'string') throw new EditError('validation', '`markdown` is required');
  return applyMarkdown(doc, edit.markdown, edit.mode, RICH_TEXT_FIELD);
}
const WRITE_ROLES: ReadonlySet<Role> = new Set(['owner', 'editor']);

/** Rich-text documents keep their content in this fragment (Tiptap Collaboration default). */
export const RICH_TEXT_FIELD = 'default';

function hasRichText(doc: Y.Doc): boolean {
  // Whiteboards only use a Y.Map, so the fragment never appears in their share.
  return doc.share.has(RICH_TEXT_FIELD) && doc.getXmlFragment(RICH_TEXT_FIELD).length > 0;
}

/**
 * Builds the Hocuspocus server. Collab only syncs and persists: auth, storage and versions all go
 * through the api's internal HTTP endpoints, and storage is the standard Yjs update encoding.
 */
export function createCollabServer(config: CollabConfig, api = new ApiClient(config.apiUrl, config.collabSecret)) {
  const versions = new Map<string, VersionState>();

  const versionState = (name: string): VersionState => {
    let state = versions.get(name);
    if (!state) {
      state = { dirty: false, authors: new Set(), storeAuthors: new Set(), lastSnapshotAt: Date.now() };
      versions.set(name, state);
    }
    return state;
  };

  async function snapshot(name: string, doc: Y.Doc, force: boolean) {
    const state = versions.get(name);
    if (!state?.dirty) return;
    if (!force && Date.now() - state.lastSnapshotAt < config.snapshotIntervalMs) return;
    const authors = [...state.authors];
    state.dirty = false;
    state.authors = new Set();
    state.lastSnapshotAt = Date.now();
    try {
      await api.createVersion(name, Y.encodeStateAsUpdate(doc), authors);
    } catch (err) {
      // Keep the changes pending so the next store retries the snapshot.
      state.dirty = true;
      for (const a of authors) state.authors.add(a);
      console.error(`[collab] snapshot failed for ${name}:`, err);
    }
  }

  /** The live document when it is open, otherwise a copy built from the stored state. */
  async function readDoc(
    instance: Server<ConnectionContext>['hocuspocus'],
    name: string,
  ): Promise<{ doc: Y.Doc; live: boolean }> {
    const loaded = instance.documents.get(name);
    if (loaded) return { doc: loaded, live: true };
    const doc = new Y.Doc();
    const state = await api.loadState(name);
    if (state) Y.applyUpdate(doc, state);
    return { doc, live: false };
  }

  const bee: Extension<ConnectionContext> = {
    extensionName: 'bee',

    async onRequest({ request, response, instance }) {
      const path = (request.url ?? '').split('?')[0] ?? '';
      if (path === '/health' || path === '/collab/health') {
        send(response, 200, 'ok');
        // Rejecting with nothing stops the default Hocuspocus response.
        return Promise.reject();
      }
      // Internal endpoints are only reachable inside the deployment network (the proxy only
      // forwards /collab*), and additionally require the shared secret.
      if (path.startsWith('/internal/')) {
        const restore = RESTORE_PATH.exec(path);
        const markdown = MARKDOWN_PATH.exec(path);
        const anchor = ANCHOR_PATH.exec(path);
        if (!secretMatches(request.headers['x-collab-secret'], config.collabSecret)) send(response, 401, 'unauthorized');
        else if (restore && request.method === 'POST') {
          try {
            const snapshot = new Y.Doc();
            Y.applyUpdate(snapshot, new Uint8Array(await readBody(request)));
            const connection = await instance.openDirectConnection(restore[1]!, { userId: null, role: 'owner' });
            await connection.transact((doc) => replaceDocContent(doc, snapshot));
            // Persists immediately and unloads if nobody else has the document open.
            await connection.disconnect();
            send(response, 204);
          } catch (err) {
            console.error('[collab] restore failed:', err);
            send(response, 500, 'restore failed');
          }
        } else if (markdown && request.method === 'GET') {
          try {
            const { doc, live } = await readDoc(instance, markdown[1]!);
            sendJSON(response, 200, { markdown: yDocToMarkdown(doc, RICH_TEXT_FIELD), live });
          } catch (err) {
            console.error('[collab] markdown read failed:', err);
            send(response, err instanceof ApiError && err.status === 404 ? 404 : 500, 'read failed');
          }
        } else if (anchor && request.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(request)).toString('utf8')) as { quote?: string; occurrence?: number };
            const { doc } = await readDoc(instance, anchor[1]!);
            const result = anchorForQuote(doc, String(body.quote ?? ''), Math.max(1, Number(body.occurrence) || 1));
            if (result) sendJSON(response, 200, { anchor: result });
            else sendJSON(response, 409, { error: { code: 'not_found', message: 'The quoted text does not occur in the document (it must lie within one paragraph or list item)' } });
          } catch (err) {
            console.error('[collab] anchor failed:', err);
            send(response, 500, 'anchor failed');
          }
        } else if (markdown && request.method === 'POST') {
          const name = markdown[1]!;
          let edit: MarkdownEdit;
          try {
            edit = JSON.parse((await readBody(request)).toString('utf8')) as MarkdownEdit;
          } catch {
            sendJSON(response, 400, { error: { code: 'validation', message: 'Invalid JSON body' } });
            return Promise.reject();
          }
          let connection: Awaited<ReturnType<typeof instance.openDirectConnection>> | undefined;
          try {
            connection = await instance.openDirectConnection(name, { userId: edit.authorId ?? null, role: 'owner' });
            let result: ReturnType<typeof editDocument> | undefined;
            await connection.transact((doc) => {
              result = editDocument(doc, edit);
            });
            // Direct connections skip onChange, so record the author for the store and the next snapshot.
            const state = versionState(name);
            state.dirty = true;
            if (edit.authorId) {
              state.authors.add(edit.authorId);
              state.storeAuthors.add(edit.authorId);
            }
            const doc = connection.document!;
            const md = yDocToMarkdown(doc, RICH_TEXT_FIELD);
            await connection.disconnect();
            connection = undefined;
            sendJSON(response, 200, { ...result, markdown: md });
          } catch (err) {
            await connection?.disconnect().catch(() => {});
            if (err instanceof EditError) sendJSON(response, err.code === 'not_found' || err.code === 'ambiguous' ? 409 : 400, { error: { code: err.code, message: err.message } });
            else {
              console.error('[collab] markdown edit failed:', err);
              sendJSON(response, 500, { error: { code: 'internal', message: 'Edit failed' } });
            }
          }
        } else send(response, 404, 'not found');
        return Promise.reject();
      }
    },

    async onAuthenticate({ documentName, requestHeaders, requestParameters, token, connectionConfig }) {
      if (!DOCUMENT_NAME.test(documentName)) throw new Error('invalid document');
      const shareToken = token || requestParameters.get('share') || undefined;
      try {
        const result = await api.authenticate({
          documentId: documentName,
          cookie: requestHeaders.get('cookie') ?? undefined,
          shareToken,
        });
        // Commenters and viewers never write to the Yjs doc; comment anchors live in the api.
        connectionConfig.readOnly = !WRITE_ROLES.has(result.role);
        return { userId: result.userId, role: result.role } satisfies ConnectionContext;
      } catch (err) {
        if (err instanceof ApiError) throw new Error(err.status === 404 ? 'not found' : 'permission denied', { cause: err });
        throw err;
      }
    },

    async onLoadDocument({ documentName, document }) {
      const state = await api.loadState(documentName);
      if (state) Y.applyUpdate(document, state);
      versionState(documentName);
      return document;
    },

    async onChange({ documentName, context, connection }) {
      if (!connection) return;
      const state = versionState(documentName);
      state.dirty = true;
      if (context?.userId) {
        state.authors.add(context.userId);
        state.storeAuthors.add(context.userId);
      }
    },

    async onStoreDocument({ documentName, document, clientsCount }) {
      const state = versionState(documentName);
      const authors = [...state.storeAuthors];
      state.storeAuthors = new Set();
      try {
        await api.storeState(documentName, Y.encodeStateAsUpdate(document), authors);
      } catch (err) {
        for (const a of authors) state.storeAuthors.add(a);
        throw err;
      }
      if (hasRichText(document)) {
        try {
          await api.storeMarkdown(documentName, yDocToMarkdown(document, RICH_TEXT_FIELD));
        } catch (err) {
          console.error(`[collab] markdown cache failed for ${documentName}:`, err);
        }
      }
      await snapshot(documentName, document, clientsCount === 0);
    },

    async beforeUnloadDocument({ documentName, document }) {
      await snapshot(documentName, document, true);
    },

    async afterUnloadDocument({ documentName }) {
      versions.delete(documentName);
    },
  };

  return new Server<ConnectionContext>({
    port: config.port,
    quiet: true,
    debounce: config.storeDebounceMs,
    maxDebounce: config.storeMaxDebounceMs,
    extensions: [bee],
  });
}

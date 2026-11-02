import { Server, type Extension } from '@hocuspocus/server';
import * as Y from 'yjs';
import { yDocToMarkdown } from '@bee/editor/markdown';
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
        const match = RESTORE_PATH.exec(path);
        if (!secretMatches(request.headers['x-collab-secret'], config.collabSecret)) send(response, 401, 'unauthorized');
        else if (!match || request.method !== 'POST') send(response, 404, 'not found');
        else {
          try {
            const snapshot = new Y.Doc();
            Y.applyUpdate(snapshot, new Uint8Array(await readBody(request)));
            const connection = await instance.openDirectConnection(match[1]!, { userId: null, role: 'owner' });
            await connection.transact((doc) => replaceDocContent(doc, snapshot));
            // Persists immediately and unloads if nobody else has the document open.
            await connection.disconnect();
            send(response, 204);
          } catch (err) {
            console.error('[collab] restore failed:', err);
            send(response, 500, 'restore failed');
          }
        }
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

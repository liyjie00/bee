import { Server, type Extension } from '@hocuspocus/server';
import * as Y from 'yjs';
import { yDocToMarkdown } from '@bee/editor/markdown';
import { ApiClient, ApiError, type Role } from './api-client.js';
import type { CollabConfig } from './config.js';

export interface ConnectionContext {
  userId: string | null;
  role: Role;
}

interface VersionState {
  dirty: boolean;
  authors: Set<string>;
  lastSnapshotAt: number;
}

const DOCUMENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
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
      state = { dirty: false, authors: new Set(), lastSnapshotAt: Date.now() };
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

    async onRequest({ request, response }) {
      const path = (request.url ?? '').split('?')[0];
      if (path === '/health' || path === '/collab/health') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
        // Rejecting with nothing stops the default Hocuspocus response.
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
        if (err instanceof ApiError) throw new Error(err.status === 404 ? 'not found' : 'permission denied');
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
      if (context?.userId) state.authors.add(context.userId);
    },

    async onStoreDocument({ documentName, document, clientsCount }) {
      await api.storeState(documentName, Y.encodeStateAsUpdate(document));
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

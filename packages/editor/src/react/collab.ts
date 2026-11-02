import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket, WebSocketStatus } from '@hocuspocus/provider';

export type CollabStatus = 'connecting' | 'connected' | 'synced' | 'disconnected' | 'denied';

export interface BeeUser {
  /** null for anonymous visitors of a public link. */
  id: string | null;
  name: string;
  color: string;
}

export interface CollabConnection {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
}

/** Resolves to the stored Yjs update of a document (null when it has none yet). */
export type LoadSnapshot = () => Promise<Uint8Array | null>;

/**
 * One WebSocket per collab URL, shared by every open document (Hocuspocus multiplexes documents
 * over a socket). The handshake through the tunnel costs several hundred milliseconds, so opening a
 * document on an already-open socket only pays for auth + sync.
 */
const sockets = new Map<string, HocuspocusProviderWebsocket>();
/** Sockets replaced by resetCollabSockets(), closed once their last document detaches. */
const retired = new Set<HocuspocusProviderWebsocket>();

function collabSocket(url: string): HocuspocusProviderWebsocket {
  let socket = sockets.get(url);
  if (!socket) {
    socket = new HocuspocusProviderWebsocket({ url });
    sockets.set(url, socket);
  }
  return socket;
}

/** Opens the shared socket ahead of time, e.g. as soon as the app knows the user is signed in. */
export function preconnectCollab(url: string): void {
  collabSocket(url);
}

/**
 * The socket authenticates with the cookies of its handshake, so call this when the signed-in user
 * changes. Documents already open keep their socket until they close.
 */
export function resetCollabSockets(): void {
  for (const socket of sockets.values()) {
    if (socket.configuration.providerMap.size === 0) socket.destroy();
    else retired.add(socket);
  }
  sockets.clear();
}

/**
 * Opens one Yjs document on the collab server for the lifetime of the component.
 * Auth rides on the session cookie; public links pass the share token as the provider token.
 * `loadSnapshot` seeds the document from storage over HTTP so content can render before the sync.
 */
export function useCollabConnection(
  documentId: string,
  collabUrl: string,
  shareToken: string | undefined,
  /** `ydoc` tells which connection the event belongs to (events can arrive before its render). */
  onStatus?: (status: CollabStatus, ydoc: Y.Doc) => void,
  loadSnapshot?: LoadSnapshot,
  onSnapshot?: (ydoc: Y.Doc) => void,
): CollabConnection | null {
  const [conn, setConn] = useState<CollabConnection | null>(null);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const socket = collabSocket(collabUrl);
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: documentId,
      document: ydoc,
      // The server falls back to the cookie when the token is empty.
      token: shareToken ?? '',
      onStatus: ({ status }) => onStatus?.(status as CollabStatus, ydoc),
      onSynced: () => onStatus?.('synced', ydoc),
      onAuthenticationFailed: () => onStatus?.('denied', ydoc),
    });
    provider.attach();
    // A provider on an already-open socket gets no status event, so report it here.
    if (socket.status === WebSocketStatus.Connected) onStatus?.('connected', ydoc);
    let live = true;
    loadSnapshot?.().then(
      (state) => {
        if (!live || !state) return;
        // Origin = provider: the provider skips its own updates, so the snapshot isn't echoed
        // back to the server. Stored state is never ahead of the server's, so merging is safe.
        Y.applyUpdate(ydoc, state, provider);
        onSnapshot?.(ydoc);
      },
      () => {},
    );
    setConn({ ydoc, provider });
    return () => {
      live = false;
      provider.destroy();
      ydoc.destroy();
      if (retired.has(socket) && socket.configuration.providerMap.size === 0) {
        retired.delete(socket);
        socket.destroy();
      }
      setConn(null);
    };
    // Callbacks are intentionally not dependencies: reconnecting on every render would be wrong.
  }, [documentId, collabUrl, shareToken]);

  return conn;
}

/** Collaborators currently present on a provider, de-duplicated by user id. */
export function presentUsers(provider: HocuspocusProvider): BeeUser[] {
  const seen = new Map<string, BeeUser>();
  provider.awareness?.getStates().forEach((state, clientId) => {
    const user = state.user as BeeUser | undefined;
    if (!user) return;
    seen.set(user.id ?? `anon-${clientId}`, user);
  });
  return [...seen.values()];
}

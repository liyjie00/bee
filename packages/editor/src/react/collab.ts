import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

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

/**
 * Opens one Yjs document on the collab server for the lifetime of the component.
 * Auth rides on the session cookie; public links pass the share token as the provider token.
 */
export function useCollabConnection(
  documentId: string,
  collabUrl: string,
  shareToken: string | undefined,
  onStatus?: (status: CollabStatus) => void,
): CollabConnection | null {
  const [conn, setConn] = useState<CollabConnection | null>(null);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: collabUrl,
      name: documentId,
      document: ydoc,
      // The server falls back to the cookie when the token is empty.
      token: shareToken ?? '',
      onStatus: ({ status }) => onStatus?.(status as CollabStatus),
      onSynced: () => onStatus?.('synced'),
      onAuthenticationFailed: () => onStatus?.('denied'),
    });
    setConn({ ydoc, provider });
    return () => {
      provider.destroy();
      ydoc.destroy();
      setConn(null);
    };
    // onStatus is intentionally not a dependency: reconnecting on every render would be wrong.
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

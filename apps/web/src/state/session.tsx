import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api/http';
import { applyDocPrefs } from '../lib/docPrefs';
import { preconnectCollab, resetCollabSockets } from '@bee/editor';
import { collabUrl } from '../lib/collab';
import type { DocumentDTO, FolderDTO, Session, TreeDTO, WorkspaceDTO } from '../api/types';

interface SessionCtx {
  session: Session | null;
  loading: boolean;
  setSession(s: Session | null): void;
  workspace: WorkspaceDTO | null;
}
const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api
      .me()
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    // Signed-out visitors (share links) keep whatever this browser last used.
    if (session) applyDocPrefs(session.user.prefs);
  }, [session]);
  const userId = session?.user.id;
  useEffect(() => {
    if (loading) return;
    // The collab socket authenticates with its handshake's cookie: a new user needs a new socket.
    // Opening it now means the first document opened skips the slow WebSocket handshake.
    resetCollabSockets();
    if (userId) preconnectCollab(collabUrl());
  }, [userId, loading]);
  const value = useMemo(
    () => ({ session, loading, setSession, workspace: session?.workspaces[0] ?? null }),
    [session, loading],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('SessionProvider missing');
  return c;
}

interface TreeCtx {
  tree: TreeDTO;
  reload(): Promise<void>;
  folder(id: string | null | undefined): FolderDTO | undefined;
  doc(id: string | null | undefined): DocumentDTO | undefined;
  /** root → folder, inclusive */
  path(folderId: string | null | undefined): FolderDTO[];
  /** optimistic local patch until the next reload */
  patchDoc(id: string, patch: Partial<DocumentDTO>): void;
}
const TreeContext = createContext<TreeCtx | null>(null);
const EMPTY: TreeDTO = { folders: [], documents: [] };

export function TreeProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const [tree, setTree] = useState<TreeDTO>(EMPTY);
  const reload = useCallback(async () => {
    setTree(await api.tree(workspaceId));
  }, [workspaceId]);
  useEffect(() => {
    reload().catch(() => {});
  }, [reload]);
  const value = useMemo<TreeCtx>(() => {
    const fmap = new Map(tree.folders.map((f) => [f.id, f]));
    return {
      tree,
      reload,
      folder: (id) => (id ? fmap.get(id) : undefined),
      doc: (id) => (id ? tree.documents.find((d) => d.id === id) : undefined),
      path(id) {
        const out: FolderDTO[] = [];
        for (let f = id ? fmap.get(id) : undefined; f && out.length < 50; f = f.parentId ? fmap.get(f.parentId) : undefined)
          out.unshift(f);
        return out;
      },
      patchDoc: (id, patch) =>
        setTree((t) => ({ ...t, documents: t.documents.map((d) => (d.id === id ? { ...d, ...patch } : d)) })),
    };
  }, [tree, reload]);
  return <TreeContext.Provider value={value}>{children}</TreeContext.Provider>;
}

export function useTree(): TreeCtx {
  const c = useContext(TreeContext);
  if (!c) throw new Error('TreeProvider missing');
  return c;
}

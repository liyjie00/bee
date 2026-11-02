import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api/http';
import type { DocumentDTO } from '../api/types';

/** Sidebar lists that change outside the folder tree: starred and recent docs, unread notifications. */
interface ListsCtx {
  starred: DocumentDTO[];
  recent: DocumentDTO[];
  unread: number;
  isStarred(id: string): boolean;
  setStar(doc: DocumentDTO, on: boolean): Promise<void>;
  setUnread(n: number): void;
  refreshUnread(): void;
}
const Ctx = createContext<ListsCtx | null>(null);
const POLL_MS = 30_000;
export const RECENT_MAX = 8;

export function ListsProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const loc = useLocation();
  const [starred, setStarred] = useState<DocumentDTO[]>([]);
  const [recent, setRecent] = useState<DocumentDTO[]>([]);
  const [unread, setUnread] = useState(0);
  const refreshUnread = useCallback(() => {
    api.unreadCount().then(setUnread, () => {});
  }, []);

  useEffect(() => {
    api.starred(workspaceId).then(setStarred, () => {});
  }, [workspaceId]);
  // Opening a document makes it the most recent one.
  const docId = /^\/d\/([^/]+)/.exec(loc.pathname)?.[1];
  useEffect(() => {
    const t = setTimeout(() => api.recent(workspaceId).then((d) => setRecent(d.slice(0, RECENT_MAX)), () => {}), docId ? 800 : 0);
    return () => clearTimeout(t);
  }, [workspaceId, docId]);
  useEffect(() => {
    refreshUnread();
    const timer = setInterval(() => document.visibilityState === 'visible' && refreshUnread(), POLL_MS);
    const vis = () => document.visibilityState === 'visible' && refreshUnread();
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [refreshUnread]);

  const value = useMemo<ListsCtx>(
    () => ({
      starred,
      recent,
      unread,
      isStarred: (id) => starred.some((d) => d.id === id),
      async setStar(doc, on) {
        setStarred((s) => (on ? [doc, ...s.filter((d) => d.id !== doc.id)] : s.filter((d) => d.id !== doc.id)));
        try {
          await api.setStar(doc.id, on);
        } catch (e) {
          api.starred(workspaceId).then(setStarred, () => {});
          throw e;
        }
      },
      setUnread,
      refreshUnread,
    }),
    [starred, recent, unread, workspaceId, refreshUnread],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** null outside the signed-in shell (share pages). */
export function useLists(): ListsCtx | null {
  return useContext(Ctx);
}

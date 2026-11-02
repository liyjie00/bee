import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession, TreeProvider } from '../state/session';
import { Sidebar } from './Sidebar';
import { SearchDialog } from './SearchDialog';
import { useT } from '../i18n';

const Ctx = createContext<{ openSidebar(): void }>({ openSidebar() {} });
export const useShell = () => useContext(Ctx);

/** Signed-in workspace chrome: folder tree on the left, page content on the right. */
export function Shell() {
  const { session, loading, workspace } = useSession();
  const loc = useLocation();
  const [sideOpen, setSideOpen] = useState(false);
  const [search, setSearch] = useState(false);
  const t = useT();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch(true);
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  if (loading) return <div className="empty">{t('app.loading')}</div>;
  if (!session || !workspace)
    return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search + loc.hash)}`} replace />;
  return (
    <TreeProvider workspaceId={workspace.id}>
      <Ctx.Provider value={{ openSidebar: () => setSideOpen(true) }}>
        <div className="app">
          <Sidebar open={sideOpen} onClose={() => setSideOpen(false)} onSearch={() => setSearch(true)} />
          {sideOpen && <div style={{ position: 'fixed', inset: 0, zIndex: 34 }} onClick={() => setSideOpen(false)} />}
          <Outlet />
        </div>
        {search && <SearchDialog workspaceId={workspace.id} onClose={() => setSearch(false)} />}
      </Ctx.Provider>
    </TreeProvider>
  );
}

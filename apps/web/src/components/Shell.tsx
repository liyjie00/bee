import { createContext, useContext, useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession, TreeProvider } from '../state/session';
import { Sidebar } from './Sidebar';
import { ListsProvider } from '../state/lists';
import { SearchDialog } from './SearchDialog';
import { useI18n } from '../i18n';
import { api } from '../api/http';
import { PHONE_QUERY, useKeyboardInset, useMediaQuery } from '../lib/media';

/** openSidebar is null outside the signed-in shell (share pages have no sidebar). */
const Ctx = createContext<{ openSidebar: (() => void) | null }>({ openSidebar: null });
export const useShell = () => useContext(Ctx);

/** Signed-in workspace chrome: folder tree on the left, page content on the right. */
export function Shell() {
  const { session, loading, workspace, setSession } = useSession();
  const loc = useLocation();
  const [sideOpen, setSideOpen] = useState(false);
  const [search, setSearch] = useState(false);
  const { t, lang } = useI18n();
  // Browser notifications are written in the language the user last used Bee in.
  useEffect(() => {
    if (session && session.user.prefs.lang !== lang) api.updateMe({ prefs: { lang } }).then(setSession, () => {});
  }, [lang, session?.user.id]);
  // Phones: full-screen panels (comments, Ask AI) end above the on-screen keyboard.
  const keyboard = useKeyboardInset(useMediaQuery(PHONE_QUERY));
  useEffect(() => {
    document.documentElement.style.setProperty('--kb', `${keyboard}px`);
  }, [keyboard]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch(true);
      }
    };
    // capture phase so embedded editors (Excalidraw) cannot swallow the shortcut
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, []);
  if (loading) return <div className="empty">{t('app.loading')}</div>;
  if (!session || !workspace)
    return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search + loc.hash)}`} replace />;
  return (
    <TreeProvider workspaceId={workspace.id}>
      <ListsProvider workspaceId={workspace.id}>
      <Ctx.Provider value={{ openSidebar: () => setSideOpen(true) }}>
        <div className="app">
          <Sidebar open={sideOpen} onClose={() => setSideOpen(false)} onSearch={() => setSearch(true)} />
          {sideOpen && <div className="drawer-scrim" onClick={() => setSideOpen(false)} />}
          <Outlet />
        </div>
        {search && <SearchDialog workspaceId={workspace.id} onClose={() => setSearch(false)} />}
      </Ctx.Provider>
      </ListsProvider>
    </TreeProvider>
  );
}

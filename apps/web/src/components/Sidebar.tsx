import { useState, type DragEvent } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/http';
import type { DocumentDTO, DocumentType, FolderDTO } from '../api/types';
import { errMsg, useToast } from '../state/toast';
import { useSession, useTree } from '../state/session';
import { Icon, docIcon } from './Icon';
import { BeeLogo } from './Logo';
import { Avatar, useMenu, type MenuItem } from './Menu';
import { useT } from '../i18n';
import { prefetchProps } from '../lib/doc-cache';
import { useLists } from '../state/lists';
import { useCreate } from './NewMenu';
import { BugReportDialog } from './BugReportDialog';
import { SpaceSwitcher } from './Spaces';
import { MoveToSpaceDialog } from './MoveToSpaceDialog';
import { FolderAccessDialog } from './FolderAccessDialog';
import { SidebarResizer } from './SidebarResizer';

const EXPANDED_KEY = 'bee-tree-open';
const COLLAPSED_KEY = 'bee-side-collapsed';
function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
function loadOpen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

type DragItem = { kind: 'folder' | 'doc'; id: string };

export function Sidebar({ open, onClose, onSearch }: { open: boolean; onClose(): void; onSearch(): void }) {
  const { session, workspace, setSession, setWorkspace } = useSession();
  const { tree, reload } = useTree();
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const menu = useMenu();
  const [bugOpen, setBugOpen] = useState(false);
  const [moving, setMoving] = useState<{ kind: 'doc' | 'folder'; id: string; name: string; folderId: string | null } | null>(null);
  const [accessOf, setAccessOf] = useState<FolderDTO | null>(null);
  const t = useT();
  const [expanded, setExpanded] = useState(loadOpen);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const lists = useLists();
  const rootCreate = useCreate(null, onClose);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggleSection = (k: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...n]));
      } catch {
        /* ignore */
      }
      return n;
    });
  const star = (d: DocumentDTO, on: boolean) => lists?.setStar(d, on).catch((e) => toast(errMsg(e)));

  const toggle = (id: string, force?: boolean) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (force ?? !n.has(id)) n.add(id);
      else n.delete(id);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...n]));
      } catch {
        /* ignore */
      }
      return n;
    });

  const wsId = workspace?.id ?? '';
  const team = workspace?.kind === 'team';
  const otherSpaces = (session?.workspaces.length ?? 0) > 1;
  const sortFn = (a: { sort: number; name?: string; title?: string }, b: { sort: number; name?: string; title?: string }) =>
    a.sort - b.sort || (a.name ?? a.title ?? '').localeCompare(b.name ?? b.title ?? '');
  const childFolders = (pid: string | null) => tree.folders.filter((f) => f.parentId === pid).sort(sortFn);
  const childDocs = (fid: string | null) => tree.documents.filter((d) => d.folderId === fid && !d.deletedAt).sort(sortFn);

  async function newFolder(parentId: string | null) {
    try {
      const f = await api.createFolder({ workspaceId: wsId, parentId, name: t('tree.newFolderName') });
      if (parentId) toggle(parentId, true);
      await reload();
      setRenaming(f.id);
    } catch (e) {
      toast(errMsg(e));
    }
  }
  async function newDoc(folderId: string | null, type: DocumentType) {
    try {
      const d = await api.createDocument({ workspaceId: wsId, folderId, type, title: type === 'whiteboard' ? t('tree.newBoardTitle') : '' });
      if (folderId) toggle(folderId, true);
      await reload();
      nav(`/d/${d.id}`);
      onClose();
    } catch (e) {
      toast(errMsg(e));
    }
  }
  async function rename(item: DragItem, name: string) {
    setRenaming(null);
    name = name.trim();
    if (!name) return;
    try {
      if (item.kind === 'folder') await api.updateFolder(item.id, { name });
      else await api.updateDocument(item.id, { title: name });
      await reload();
    } catch (e) {
      toast(errMsg(e));
    }
  }
  async function remove(item: DragItem) {
    try {
      if (item.kind === 'folder') await api.deleteFolder(item.id);
      else await api.deleteDocument(item.id);
      await reload();
      toast(t('common.movedToTrash'));
      if (loc.pathname.includes(item.id)) nav('/');
    } catch (e) {
      toast(errMsg(e));
    }
  }
  async function move(item: DragItem, folderId: string | null) {
    if (item.kind === 'folder' && item.id === folderId) return;
    try {
      if (item.kind === 'folder') await api.updateFolder(item.id, { parentId: folderId });
      else await api.updateDocument(item.id, { folderId });
      if (folderId) toggle(folderId, true);
      await reload();
    } catch (e) {
      toast(errMsg(e));
    }
  }

  const onDragStart = (e: DragEvent, item: DragItem) => {
    e.dataTransfer.setData('application/x-bee', JSON.stringify(item));
    e.dataTransfer.effectAllowed = 'move';
  };
  const dropProps = (folderId: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('application/x-bee')) return;
      e.preventDefault();
      // A folder row sits inside the root drop zone; without this the root would claim the drop too.
      e.stopPropagation();
      setDropTarget(folderId ?? 'root');
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      try {
        void move(JSON.parse(e.dataTransfer.getData('application/x-bee')) as DragItem, folderId);
      } catch {
        /* not ours */
      }
    },
  });

  /** "Move to" entries, so items can be moved without drag and drop (touch screens). */
  const moveItems = (item: DragItem, parentId: string | null): MenuItem[] => {
    const blocked = new Set<string>();
    if (item.kind === 'folder') {
      const walk = (id: string) => {
        blocked.add(id);
        childFolders(id).forEach((c) => walk(c.id));
      };
      walk(item.id);
    }
    const targets = tree.folders
      .filter((f) => !blocked.has(f.id) && f.id !== parentId)
      .sort(sortFn)
      .map((f): MenuItem => ({ label: t('tree.moveInto', { name: f.name }), icon: 'folder', onSelect: () => move(item, f.id) }));
    if (parentId) targets.unshift({ label: t('tree.moveToTop'), icon: 'arrow', onSelect: () => move(item, null) });
    return targets;
  };

  const folderMenu = (f: FolderDTO): (MenuItem | '-')[] => [
    { label: t('tree.newDoc'), icon: 'doc', onSelect: () => newDoc(f.id, 'doc') },
    { label: t('tree.newBoard'), icon: 'board', onSelect: () => newDoc(f.id, 'whiteboard') },
    { label: t('tree.newSubfolder'), icon: 'folder', onSelect: () => newFolder(f.id) },
    '-',
    { label: t('tree.rename'), icon: 'pen', onSelect: () => setRenaming(f.id) },
    ...(team ? [{ label: t('restrict.menu'), icon: 'lock' as const, onSelect: () => setAccessOf(f) }] : []),
    ...moveItems({ kind: 'folder', id: f.id }, f.parentId),
    ...(otherSpaces && f.role === 'owner'
      ? [{ label: t('move.menu'), icon: 'arrow' as const, onSelect: () => setMoving({ kind: 'folder', id: f.id, name: f.name, folderId: f.parentId }) }]
      : []),
    { label: t('tree.delete'), icon: 'trash', danger: true, onSelect: () => remove({ kind: 'folder', id: f.id }) },
  ];
  const starItem = (d: DocumentDTO): MenuItem =>
    lists?.isStarred(d.id)
      ? { label: t('star.remove'), icon: 'star', onSelect: () => star(d, false) }
      : { label: t('star.add'), icon: 'star', onSelect: () => star(d, true) };
  const docMenu = (d: DocumentDTO): (MenuItem | '-')[] => [
    starItem(d),
    { label: t('tree.rename'), icon: 'pen', onSelect: () => setRenaming(d.id) },
    ...moveItems({ kind: 'doc', id: d.id }, d.folderId),
    ...(otherSpaces && d.role === 'owner'
      ? [{ label: t('move.menu'), icon: 'arrow' as const, onSelect: () => setMoving({ kind: 'doc', id: d.id, name: d.title, folderId: d.folderId }) }]
      : []),
    { label: t('tree.delete'), icon: 'trash', danger: true, onSelect: () => remove({ kind: 'doc', id: d.id }) },
  ];

  const renameInput = (item: DragItem, value: string) => (
    <input
      className="rename"
      autoFocus
      defaultValue={value}
      aria-label={t('tree.name')}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => rename(item, e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setRenaming(null);
      }}
    />
  );

  const renderFolder = (f: FolderDTO, depth: number) => {
    const isOpen = expanded.has(f.id);
    const active = loc.pathname === `/f/${f.id}`;
    return (
      <div key={f.id}>
        <div className="row" {...dropProps(f.id)}>
          {renaming === f.id ? (
            <div style={{ paddingLeft: `${(8 + depth * 18) / 16}rem` }}>{renameInput({ kind: 'folder', id: f.id }, f.name)}</div>
          ) : (
            <button
              className={(active ? 'on ' : '') + (dropTarget === f.id ? 'drop' : '')}
              style={{ paddingLeft: `${(8 + depth * 18) / 16}rem` }}
              draggable
              onDragStart={(e) => onDragStart(e, { kind: 'folder', id: f.id })}
              onClick={() => {
                toggle(f.id, true);
                nav(`/f/${f.id}`);
                onClose();
              }}
              onContextMenu={(e) => menu.open(e, folderMenu(f))}
              onDoubleClick={() => setRenaming(f.id)}
            >
              <span
                role="button"
                aria-label={isOpen ? t('tree.collapse') : t('tree.expand')}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(f.id);
                }}
                style={{ display: 'inline-grid' }}
              >
                <Icon name={isOpen ? 'down' : 'chev'} className="chev" />
              </span>
              <Icon name="folder" />
              <span className="nm">{f.name}</span>
              {(team ? f.restricted : f.role !== 'owner') && (
                <Icon name="lock" className="lock" style={team ? { color: 'var(--fg-2)' } : undefined} />
              )}
            </button>
          )}
          <button className="more" aria-label={t('common.moreFor', { name: f.name })} onClick={(e) => menu.open(e, folderMenu(f))} style={{ width: 'auto' }}>
            <Icon name="more" size={14} />
          </button>
        </div>
        {isOpen && (
          <>
            {childFolders(f.id).map((c) => renderFolder(c, depth + 1))}
            {childDocs(f.id).map((d) => renderDoc(d, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const renderDoc = (d: DocumentDTO, depth: number) => (
    <div className="row" key={d.id}>
      {renaming === d.id ? (
        <div style={{ paddingLeft: `${(8 + depth * 18 + 20) / 16}rem` }}>{renameInput({ kind: 'doc', id: d.id }, d.title)}</div>
      ) : (
        <NavLink
          to={`/d/${d.id}`}
          {...prefetchProps(d.id)}
          className={({ isActive }) => (isActive || loc.pathname.startsWith(`/d/${d.id}/`) ? 'on' : '')}
          style={{ paddingLeft: `${(8 + depth * 18 + 20) / 16}rem` }}
          draggable
          onDragStart={(e) => onDragStart(e, { kind: 'doc', id: d.id })}
          onClick={onClose}
          onContextMenu={(e) => menu.open(e, docMenu(d))}
        >
          <Icon name={docIcon(d.type)} className={d.type === 'whiteboard' ? 't-board' : undefined} />
          <span className="nm">{d.title || t('common.untitled')}</span>
          {d.type === 'whiteboard' && <span className="kind-tag">{t('kind.whiteboard')}</span>}
        </NavLink>
      )}
      <button className="more" aria-label={t('common.moreFor', { name: d.title || t('common.untitled') })} onClick={(e) => menu.open(e, docMenu(d))} style={{ width: 'auto' }}>
        <Icon name="more" size={14} />
      </button>
    </div>
  );

  const navItem = (to: string, icon: 'home' | 'folder' | 'clock' | 'star' | 'trash' | 'globe' | 'bell' | 'board', label: string, count?: number, total?: number) => (
    <NavLink to={to} end className={({ isActive }) => (isActive ? 'on' : '')} onClick={onClose}>
      <Icon name={icon} className={icon === 'board' ? 't-board' : undefined} />
      {label}
      {!!count && <span className="count">{count > 99 ? '99+' : count}</span>}
      {!!total && <span className="total">{total}</span>}
    </NavLink>
  );
  /** A short list of docs (Starred, Recent) under a collapsible heading. */
  const quickList = (key: string, label: string, docs: DocumentDTO[], empty: string, more?: string) => {
    const open = !collapsed.has(key);
    return (
      <>
        <div className="sec">
          <button className="sec-toggle" aria-expanded={open} onClick={() => toggleSection(key)}>
            <Icon name={open ? 'down' : 'chev'} size={11} />
            {label}
          </button>
          {more && (
            <NavLink to={more} className="sec-more" onClick={onClose}>
              {t('nav.all')}
            </NavLink>
          )}
        </div>
        {open && (
          <div className="tree quick">
            {docs.map((d) => (
              <div className="row" key={d.id}>
                <NavLink
                  to={`/d/${d.id}`}
                  {...prefetchProps(d.id)}
                  className={({ isActive }) => (isActive ? 'on' : '')}
                  style={{ paddingLeft: '0.5rem' }}
                  onClick={onClose}
                  onContextMenu={(e) => menu.open(e, [starItem(d)])}
                >
                  {key === 'starred' ? <Icon name="star" className="star-on" /> : <Icon name={docIcon(d.type)} className={d.type === 'whiteboard' ? 't-board' : undefined} />}
                  <span className="nm">{d.title || t('common.untitled')}</span>
                </NavLink>
                <button className="more" aria-label={t('common.moreFor', { name: d.title || t('common.untitled') })} onClick={(e) => menu.open(e, [starItem(d)])} style={{ width: 'auto' }}>
                  <Icon name="more" size={14} />
                </button>
              </div>
            ))}
            {docs.length === 0 && <p className="quick-empty">{empty}</p>}
          </div>
        )}
      </>
    );
  };

  return (
    <aside className={'side' + (open ? ' open' : '')} aria-label={t('nav.sidebar')}>
      <SidebarResizer />
      <div className="brand">
        <BeeLogo height={22} />
      </div>
      <SpaceSwitcher onNavigate={onClose} />
      <button className="search" onClick={onSearch}>
        <Icon name="search" />
        {t('nav.search')}
        <kbd className="hide-phone">⌘K</kbd>
      </button>
      <div className="side-create">
        <button title={t('tree.newDoc')} onClick={() => rootCreate.create('doc')}>
          <Icon name="plus" />
          <span>{t('nav.createDoc')}</span>
        </button>
        <button title={t('tree.newBoard')} onClick={() => rootCreate.create('whiteboard')}>
          <Icon name="plus" />
          <span>{t('nav.createBoard')}</span>
        </button>
        <button
          className="more"
          aria-haspopup="menu"
          title={t('nav.moreCreate')}
          aria-label={t('nav.moreCreate')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            menu.open({ clientX: r.left, clientY: r.bottom + 4, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() }, rootCreate.items({ folder: () => newFolder(null), basics: false }));
          }}
        >
          <Icon name="more" />
        </button>
      </div>
      <nav className="nav">
        {navItem('/', 'home', t('nav.home'))}
        {navItem('/files', 'folder', t('nav.files'))}
        {navItem('/notifications', 'bell', t('nav.notifications'), lists?.unread)}
        {navItem('/shared', 'globe', t('nav.shared'))}
        {navItem('/boards', 'board', t('nav.boards'), undefined, tree.documents.filter((d) => d.type === 'whiteboard' && !d.deletedAt).length)}
      </nav>
      <div className="side-scroll">
      {quickList('starred', t('nav.starred'), lists?.starred ?? [], t('nav.starredEmpty'))}
      {quickList('recent', t('nav.recentSection'), lists?.recent ?? [], t('nav.recentEmpty'), '/recent')}
      <div className="sec">
        {t('nav.folders')}
        <button
          className="sec-new"
          aria-haspopup="menu"
          title={t('nav.newMenu')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            menu.open({ clientX: r.left, clientY: r.bottom + 4, preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation() }, rootCreate.items({ folder: () => newFolder(null) }));
          }}
        >
          <Icon name="plus" />
          {t('new.button')}
        </button>
      </div>
      <div className={'tree' + (dropTarget === 'root' ? ' drop' : '')} {...dropProps(null)}>
        {childFolders(null).map((f) => renderFolder(f, 0))}
        {childDocs(null).map((d) => renderDoc(d, 0))}
        {tree.folders.length === 0 && tree.documents.length === 0 && (
          <p style={{ color: 'var(--fg-3)', fontSize: '0.7813rem', padding: '0.375rem 0.5rem' }}>{t('nav.emptyTree')}</p>
        )}
      </div>
      </div>
      <nav className="nav" style={{ paddingBottom: '0.375rem' }}>
        {navItem('/trash', 'trash', t('nav.trash'))}
        <button onClick={() => setBugOpen(true)}>
          <Icon name="bug" />
          {t('bug.nav')}
        </button>
      </nav>
      {session && (
        <div className="me">
          <Avatar name={session.user.name} color={session.user.color} url={session.user.avatarUrl} />
          <div className="meta" style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: 'var(--fg)', fontSize: '0.8125rem' }}>{session.user.name}</div>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={session.user.email}>{session.user.email}</div>
          </div>
          <button className="ico" title={t('nav.settings')} aria-label={t('nav.settings')} onClick={() => nav('/settings')}>
            <Icon name="gear" />
          </button>
          <button
            className="ico"
            title={t('nav.signOut')}
            aria-label={t('nav.signOut')}
            onClick={async () => {
              await api.logout().catch(() => {});
              setSession(null);
              nav('/login');
            }}
          >
            <Icon name="x" />
          </button>
        </div>
      )}
      {menu.node}
      {rootCreate.dialog}
      {bugOpen && <BugReportDialog onClose={() => setBugOpen(false)} />}
      {moving && workspace && (
        <MoveToSpaceDialog
          item={{ ...moving, workspaceId: workspace.id }}
          onClose={() => setMoving(null)}
          onMoved={(to) => {
            const open = loc.pathname.includes(moving.id);
            setMoving(null);
            toast(t('move.done'));
            // what is open follows into its new space
            if (open && to.workspaceId !== workspace.id) setWorkspace(to.workspaceId);
            void reload();
            lists?.refreshUnread();
          }}
        />
      )}
      {accessOf && workspace && (
        <FolderAccessDialog folder={accessOf} team={workspace} onClose={() => setAccessOf(null)} onChanged={() => void reload()} />
      )}
    </aside>
  );
}

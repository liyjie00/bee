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
  const { session, workspace, setSession } = useSession();
  const { tree, reload } = useTree();
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const menu = useMenu();
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
    ...moveItems({ kind: 'folder', id: f.id }, f.parentId),
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
            <div style={{ paddingLeft: 8 + depth * 18 }}>{renameInput({ kind: 'folder', id: f.id }, f.name)}</div>
          ) : (
            <button
              className={(active ? 'on ' : '') + (dropTarget === f.id ? 'drop' : '')}
              style={{ paddingLeft: 8 + depth * 18 }}
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
              {f.role !== 'owner' && <Icon name="lock" className="lock" />}
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
        <div style={{ paddingLeft: 8 + depth * 18 + 20 }}>{renameInput({ kind: 'doc', id: d.id }, d.title)}</div>
      ) : (
        <NavLink
          to={`/d/${d.id}`}
          {...prefetchProps(d.id)}
          className={({ isActive }) => (isActive || loc.pathname.startsWith(`/d/${d.id}/`) ? 'on' : '')}
          style={{ paddingLeft: 8 + depth * 18 + 20 }}
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

  const navItem = (to: string, icon: 'home' | 'clock' | 'star' | 'trash' | 'globe' | 'bell' | 'board', label: string, count?: number, total?: number) => (
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
                  style={{ paddingLeft: 8 }}
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
      <div className="brand">
        <BeeLogo height={22} />
        <small>{workspace?.name}</small>
      </div>
      <button className="search" onClick={onSearch}>
        <Icon name="search" />
        {t('nav.search')}
        <kbd className="hide-phone">⌘K</kbd>
      </button>
      <div className="side-create">
        <button onClick={() => rootCreate.create('doc')}>
          <Icon name="doc" className="t-doc" />
          {t('tree.newDoc')}
        </button>
        <button onClick={() => rootCreate.create('whiteboard')}>
          <Icon name="board" className="t-board" />
          {t('tree.newBoard')}
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
          <p style={{ color: 'var(--fg-3)', fontSize: 12.5, padding: '6px 8px' }}>{t('nav.emptyTree')}</p>
        )}
      </div>
      </div>
      <nav className="nav" style={{ paddingBottom: 6 }}>
        {navItem('/trash', 'trash', t('nav.trash'))}
      </nav>
      {session && (
        <div className="me">
          <Avatar name={session.user.name} color={session.user.color} />
          <div className="meta" style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: 'var(--fg)', fontSize: 13 }}>{session.user.name}</div>
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
    </aside>
  );
}

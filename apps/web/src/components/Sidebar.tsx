import { useState, type DragEvent } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/http';
import type { DocumentDTO, DocumentType, FolderDTO } from '../api/types';
import { errMsg, useToast } from '../state/toast';
import { useSession, useTree } from '../state/session';
import { BeeLogo, Icon, docIcon } from './Icon';
import { Avatar, useMenu, type MenuItem } from './Menu';
import { useT } from '../i18n';

const EXPANDED_KEY = 'bee-tree-open';
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
      setDropTarget(folderId ?? 'root');
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDropTarget(null);
      try {
        void move(JSON.parse(e.dataTransfer.getData('application/x-bee')) as DragItem, folderId);
      } catch {
        /* not ours */
      }
    },
  });

  const folderMenu = (f: FolderDTO): (MenuItem | '-')[] => [
    { label: t('tree.newDoc'), icon: 'doc', onSelect: () => newDoc(f.id, 'doc') },
    { label: t('tree.newBoard'), icon: 'board', onSelect: () => newDoc(f.id, 'whiteboard') },
    { label: t('tree.newSubfolder'), icon: 'folder', onSelect: () => newFolder(f.id) },
    '-',
    { label: t('tree.rename'), icon: 'pen', onSelect: () => setRenaming(f.id) },
    { label: t('tree.moveToTop'), icon: 'arrow', onSelect: () => move({ kind: 'folder', id: f.id }, null) },
    { label: t('tree.delete'), icon: 'trash', danger: true, onSelect: () => remove({ kind: 'folder', id: f.id }) },
  ];
  const docMenu = (d: DocumentDTO): (MenuItem | '-')[] => [
    { label: t('tree.rename'), icon: 'pen', onSelect: () => setRenaming(d.id) },
    { label: t('tree.moveToTop'), icon: 'arrow', onSelect: () => move({ kind: 'doc', id: d.id }, null) },
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
          className={({ isActive }) => (isActive || loc.pathname.startsWith(`/d/${d.id}/`) ? 'on' : '')}
          style={{ paddingLeft: 8 + depth * 18 + 20 }}
          draggable
          onDragStart={(e) => onDragStart(e, { kind: 'doc', id: d.id })}
          onClick={onClose}
          onContextMenu={(e) => menu.open(e, docMenu(d))}
        >
          <Icon name={docIcon(d.type)} />
          <span className="nm">{d.title || t('common.untitled')}</span>
        </NavLink>
      )}
      <button className="more" aria-label={t('common.moreFor', { name: d.title || t('common.untitled') })} onClick={(e) => menu.open(e, docMenu(d))} style={{ width: 'auto' }}>
        <Icon name="more" size={14} />
      </button>
    </div>
  );

  const navItem = (to: string, icon: 'home' | 'clock' | 'star' | 'trash' | 'globe', label: string) => (
    <NavLink to={to} end className={({ isActive }) => (isActive ? 'on' : '')} onClick={onClose}>
      <Icon name={icon} />
      {label}
    </NavLink>
  );

  return (
    <aside className={'side' + (open ? ' open' : '')} aria-label={t('nav.sidebar')}>
      <div className="brand">
        <BeeLogo />
        <b>bee</b>
        <small>{workspace?.name}</small>
      </div>
      <button className="search" onClick={onSearch}>
        <Icon name="search" />
        {t('nav.search')}
        <kbd>⌘K</kbd>
      </button>
      <nav className="nav">
        {navItem('/', 'home', t('nav.home'))}
        {navItem('/recent', 'clock', t('nav.recent'))}
        {navItem('/shared', 'globe', t('nav.shared'))}
      </nav>
      <div className="sec">
        {t('nav.folders')}
        <span style={{ display: 'flex', gap: 2 }}>
          <button aria-label={t('nav.newDoc')} title={t('nav.newDoc')} onClick={() => newDoc(null, 'doc')}>
            <Icon name="doc" />
          </button>
          <button aria-label={t('nav.newFolder')} title={t('nav.newFolder')} onClick={() => newFolder(null)}>
            <Icon name="plus" />
          </button>
        </span>
      </div>
      <div className={'tree' + (dropTarget === 'root' ? ' drop' : '')} {...dropProps(null)}>
        {childFolders(null).map((f) => renderFolder(f, 0))}
        {childDocs(null).map((d) => renderDoc(d, 0))}
        {tree.folders.length === 0 && tree.documents.length === 0 && (
          <p style={{ color: 'var(--fg-3)', fontSize: 12.5, padding: '6px 8px' }}>{t('nav.emptyTree')}</p>
        )}
      </div>
      <nav className="nav" style={{ paddingBottom: 6 }}>
        {navItem('/trash', 'trash', t('nav.trash'))}
      </nav>
      {session && (
        <div className="me">
          <Avatar name={session.user.name} color={session.user.color} />
          <div className="meta" style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: 'var(--fg)', fontSize: 13 }}>{session.user.name}</div>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{session.user.email}</div>
          </div>
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
    </aside>
  );
}

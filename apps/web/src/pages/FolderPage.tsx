import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/http';
import type { DocumentDTO, FolderDTO } from '../api/types';
import { Icon, docIcon } from '../components/Icon';
import { useMenu } from '../components/Menu';
import { NewMenu, useCreate } from '../components/NewMenu';
import { TopBar } from '../components/TopBar';
import { useSession, useTree } from '../state/session';
import { errMsg, useToast } from '../state/toast';
import { useAgo, useT, type MessageKey } from '../i18n';
import { prefetchProps } from '../lib/doc-cache';

type Kind = 'all' | 'doc' | 'whiteboard';
type Item = { kind: 'folder'; f: FolderDTO } | { kind: 'doc'; d: DocumentDTO };

const VIEW_KEY = 'bee-folder-view';
const KIND_KEY: Record<string, MessageKey> = { doc: 'kind.doc', whiteboard: 'kind.whiteboard', sheet: 'kind.sheet' };

export function Thumb({ d }: { d: DocumentDTO }) {
  const t = useT();
  if (d.type === 'whiteboard')
    return (
      <div className="thumb" style={{ backgroundImage: 'radial-gradient(var(--line-strong) 1px,transparent 1.2px)', backgroundSize: '0.75rem 0.75rem' }}>
        <span className="kind">{t('kind.whiteboard')}</span>
        <svg viewBox="0 0 200 80" width="100%" height="88" aria-hidden="true">
          <rect className="sh" x="4" y="24" width="56" height="30" rx="5" />
          <path className="sh sh-y" d="M100 14l30 25-30 25-30-25z" />
          <rect className="sh" x="140" y="24" width="56" height="30" rx="5" />
          <path className="sh-e" d="M60 39h10M130 39h10" />
        </svg>
      </div>
    );
  // deterministic skeleton lines so each card looks a little different
  const seed = [...d.id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const w = (i: number) => 40 + ((seed * (i + 3)) % 55);
  return (
    <div className="thumb">
      <span className="kind">{t(KIND_KEY[d.type] ?? 'kind.doc')}</span>
      <div className="ln" style={{ width: `${w(0)}%`, height: 9, background: 'var(--fg-3)' }} />
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="ln" style={{ width: `${w(i)}%` }} />
      ))}
    </div>
  );
}

/** Folder contents (or the workspace root, recent, shared-with-me, trash). */
export function FolderPage({ mode = 'folder' }: { mode?: 'folder' | 'root' | 'recent' | 'shared' | 'trash' | 'boards' }) {
  const { folderId = null } = useParams();
  const { workspace } = useSession();
  const tree = useTree();
  const nav = useNavigate();
  const toast = useToast();
  const menu = useMenu();
  const t = useT();
  const ago = useAgo();
  const [kind, setKind] = useState<Kind>('all');
  const [view, setView] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const [extra, setExtra] = useState<{ documents: DocumentDTO[]; folders: FolderDTO[] } | null>(null);
  const ws = workspace?.id ?? '';
  const boardCreate = useCreate(null);

  useEffect(() => {
    setExtra(null);
    if (mode === 'recent') api.recent(ws).then((documents) => setExtra({ documents, folders: [] }), () => setExtra({ documents: [], folders: [] }));
    if (mode === 'shared') api.sharedWithMe().then((documents) => setExtra({ documents, folders: [] }), () => setExtra({ documents: [], folders: [] }));
    if (mode === 'trash') api.trash(ws).then(setExtra, () => setExtra({ documents: [], folders: [] }));
  }, [mode, ws, tree.tree]);

  const folder = tree.folder(folderId);
  if (mode === 'folder' && !folder && tree.tree.folders.length > 0)
    return (
      <main className="main">
        <TopBar crumbs={[{ label: t('folder.title') }]} />
        <div className="empty">
          <h2>{t('folder.notFound')}</h2>
        </div>
      </main>
    );

  const title =
    mode === 'root' ? t('nav.files') : mode === 'recent' ? t('nav.recent') : mode === 'shared' ? t('nav.shared') : mode === 'boards' ? t('nav.boards') : mode === 'trash' ? t('nav.trash') : (folder?.name ?? '');
  const items: Item[] = [];
  if (mode === 'folder' || mode === 'root') {
    const fid = mode === 'root' ? null : folderId;
    tree.tree.folders.filter((f) => f.parentId === fid).forEach((f) => items.push({ kind: 'folder', f }));
    tree.tree.documents
      .filter((d) => d.folderId === fid && !d.deletedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .forEach((d) => items.push({ kind: 'doc', d }));
  } else if (mode === 'boards') {
    // Every whiteboard in the workspace, wherever it is filed.
    tree.tree.documents
      .filter((d) => d.type === 'whiteboard' && !d.deletedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .forEach((d) => items.push({ kind: 'doc', d }));
  } else if (extra) {
    extra.folders.forEach((f) => items.push({ kind: 'folder', f }));
    extra.documents.forEach((d) => items.push({ kind: 'doc', d }));
  }
  const shown = items.filter((it) => kind === 'all' || (it.kind === 'doc' && it.d.type === kind));
  const docs = shown.filter((it): it is Extract<Item, { kind: 'doc' }> => it.kind === 'doc');
  const sub =
    mode === 'trash'
      ? t('folder.trashSummary')
      : mode === 'boards'
      ? t('boards.summary', { n: items.length })
      : t('folder.summary', { docs: items.filter((i) => i.kind === 'doc').length, folders: items.filter((i) => i.kind === 'folder').length });

  const open = (it: Item) => {
    if (mode === 'trash') return void restore(it);
    nav(it.kind === 'folder' ? `/f/${it.f.id}` : `/d/${it.d.id}`);
  };
  async function restore(it: Item) {
    try {
      if (it.kind === 'doc') await api.restoreDocument(it.d.id);
      else await api.restoreFolder(it.f.id);
      await tree.reload();
      toast(t('common.restored'));
    } catch (e) {
      toast(errMsg(e));
    }
  }
  async function trashItem(it: Item) {
    try {
      if (it.kind === 'doc') await api.deleteDocument(it.d.id);
      else await api.deleteFolder(it.f.id);
      await tree.reload();
      toast(t('common.movedToTrash'));
    } catch (e) {
      toast(errMsg(e));
    }
  }
  const rowMenu = (e: React.MouseEvent, it: Item) =>
    menu.open(
      e,
      mode === 'trash'
        ? [{ label: t('tree.restore'), icon: 'restore', onSelect: () => restore(it) }]
        : [
            { label: t('tree.open'), icon: it.kind === 'folder' ? 'folder' : 'doc', onSelect: () => open(it) },
            ...(it.kind === 'doc'
              ? [{ label: t('common.copyLink'), icon: 'link' as const, onSelect: () => void navigator.clipboard?.writeText(`${location.origin}/d/${it.d.id}`).then(() => toast(t('common.linkCopied'))) }]
              : []),
            '-' as const,
            { label: t('tree.delete'), icon: 'trash', danger: true, onSelect: () => trashItem(it) },
          ],
    );

  const crumbs = mode === 'folder' ? tree.path(folderId).map((f) => ({ label: f.name, to: `/f/${f.id}` })) : [{ label: title }];
  const setV = (v: 'grid' | 'list') => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  return (
    <main className="main">
      <TopBar crumbs={crumbs} />
      <section className="view">
        <div className="folder">
          <div className="fhead">
            <div>
              <h1>{title}</h1>
              <p>{sub}</p>
            </div>
            <div className="spacer" />
            {(mode === 'folder' || mode === 'root') && <NewMenu folderId={mode === 'root' ? null : folderId} />}
            {mode === 'boards' && (
              <button className="btn primary" onClick={() => boardCreate.create('whiteboard')}>
                <Icon name="plus" />
                {t('tree.newBoard')}
              </button>
            )}
          </div>
          <div className="fbar">
            {mode !== 'boards' && (
            <div className="seg" role="group" aria-label={t('folder.filter')}>
              {(['all', 'doc', 'whiteboard'] as Kind[]).map((k) => (
                <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                  {k === 'all' ? t('kind.all') : t(KIND_KEY[k]!)}
                </button>
              ))}
            </div>
            )}
            <div className="spacer" />
            <span style={{ fontSize: '0.7812rem', color: 'var(--fg-3)' }}>{t('folder.sorted')}</span>
            <div className="seg" role="group" aria-label={t('folder.view')}>
              <button className={view === 'grid' ? 'on' : ''} aria-label={t('folder.grid')} onClick={() => setV('grid')}>
                <Icon name="grid" />
              </button>
              <button className={view === 'list' ? 'on' : ''} aria-label={t('folder.list')} onClick={() => setV('list')}>
                <Icon name="list" />
              </button>
            </div>
          </div>

          {mode !== 'folder' && mode !== 'root' && !extra ? (
            <div className="empty">{t('app.loading')}</div>
          ) : shown.length === 0 ? (
            <div className="empty">
              <h2>{mode === 'trash' ? t('folder.emptyTrash') : mode === 'boards' ? t('boards.empty') : t('folder.empty')}</h2>
              {(mode === 'folder' || mode === 'root') && <p style={{ margin: 0 }}>{t('folder.emptyHint')}</p>}
              {mode === 'boards' && <p style={{ margin: 0 }}>{t('boards.emptyHint')}</p>}
            </div>
          ) : view === 'grid' ? (
            <>
              {shown.some((i) => i.kind === 'folder') && (
                <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(12.5rem,1fr))', marginBottom: '0.875rem' }}>
                  {shown
                    .filter((i): i is Extract<Item, { kind: 'folder' }> => i.kind === 'folder')
                    .map((it) => (
                      <button key={it.f.id} className="card" onClick={() => open(it)} onContextMenu={(e) => rowMenu(e, it)}>
                        <div className="cb" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
                          <Icon name="folder" />
                          <b style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.f.name}</b>
                          {mode === 'trash' && <span>{t('folder.rightClickRestore')}</span>}
                        </div>
                      </button>
                    ))}
                </div>
              )}
              <div className="cards">
                {docs.map((it) => (
                  <button key={it.d.id} className="card" {...(mode === 'trash' ? {} : prefetchProps(it.d.id))} onClick={() => open(it)} onContextMenu={(e) => rowMenu(e, it)}>
                    <Thumb d={it.d} />
                    <div className="cb">
                      <b>
                        <Icon name={docIcon(it.d.type)} />
                        {it.d.title || t('common.untitled')}
                      </b>
                      <span>
                        {mode === 'trash' && it.d.deletedAt
                          ? t('folder.deletedAgo', { time: ago(it.d.deletedAt) })
                          : t('folder.editedBy', { name: it.d.lastEditedBy?.name ?? it.d.owner.name, time: ago(it.d.updatedAt) })}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="table-wrap">
              <table className="list">
                <thead>
                  <tr>
                    <th>{t('folder.col.name')}</th>
                    <th>{t('folder.col.owner')}</th>
                    <th>{t('folder.col.access')}</th>
                    <th>{mode === 'trash' ? t('folder.col.deleted') : t('folder.col.edited')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((it) => (
                    <tr key={it.kind === 'folder' ? it.f.id : it.d.id} {...(it.kind === 'doc' && mode !== 'trash' ? prefetchProps(it.d.id) : {})} onClick={() => open(it)} onContextMenu={(e) => rowMenu(e, it)}>
                      <td>
                        <span className="nm">
                          <Icon name={it.kind === 'folder' ? 'folder' : docIcon(it.d.type)} />
                          {it.kind === 'folder' ? it.f.name : it.d.title || t('common.untitled')}
                        </span>
                      </td>
                      <td>{it.kind === 'doc' ? it.d.owner.name : ''}</td>
                      <td>
                        <span className="pill">{t(`role.${it.kind === 'folder' ? it.f.role : it.d.role}`)}</span>
                      </td>
                      <td>
                        {it.kind === 'folder'
                          ? ago(it.f.updatedAt)
                          : mode === 'trash' && it.d.deletedAt
                            ? ago(it.d.deletedAt)
                            : ago(it.d.updatedAt)}
                      </td>
                      <td>
                        <button className="ico" aria-label={t('common.more')} onClick={(e) => rowMenu(e, it)}>
                          <Icon name="more" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
      {menu.node}
    </main>
  );
}

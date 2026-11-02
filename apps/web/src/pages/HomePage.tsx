import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/http';
import type { DocumentDTO, NotificationDTO } from '../api/types';
import { Icon, docIcon } from '../components/Icon';
import { Avatar, ContextMenu } from '../components/Menu';
import { useCreate } from '../components/NewMenu';
import { TopBar } from '../components/TopBar';
import { useAgo, useT, type MessageKey } from '../i18n';
import { prefetchProps } from '../lib/doc-cache';
import { useLists } from '../state/lists';
import { useSession, useTree } from '../state/session';
import { Thumb } from './FolderPage';
import { notificationPath, RequestActions, VERB } from './NotificationsPage';

const CONTINUE_MAX = 4;
const TODO_MAX = 5;
const SHARED_MAX = 5;

function greeting(hour: number): MessageKey {
  return hour < 5 ? 'home.evening' : hour < 12 ? 'home.morning' : hour < 18 ? 'home.afternoon' : 'home.evening';
}

/** Signed-in landing: quick create, documents to pick up again, things waiting on you. */
export function HomePage() {
  const { session } = useSession();
  const tree = useTree();
  const lists = useLists();
  const nav = useNavigate();
  const t = useT();
  const ago = useAgo();
  const { create, items, dialog, openTemplates } = useCreate(null);
  const [importAt, setImportAt] = useState<{ x: number; y: number } | null>(null);
  const [todo, setTodo] = useState<NotificationDTO[] | null>(null);
  const [shared, setShared] = useState<DocumentDTO[] | null>(null);

  useEffect(() => {
    api.notifications({ unread: true }).then((r) => setTodo(r.notifications.slice(0, TODO_MAX)), () => setTodo([]));
    api.sharedWithMe().then((d) => setShared(d.slice(0, SHARED_MAX)), () => setShared([]));
  }, []);

  const recent = (lists?.recent ?? []).slice(0, CONTINUE_MAX);
  const starred = lists?.starred ?? [];
  const unread = lists?.unread ?? 0;
  const folderName = (d: DocumentDTO) => tree.folder(d.folderId)?.name ?? '';
  const all = items();
  const importItems = all.slice(all.indexOf('-') + 1);

  const openNotif = (n: NotificationDTO) => {
    if (!n.read) api.markRead([n.id]).then((u) => lists?.setUnread(u), () => {});
    setTodo((cur) => cur?.map((x) => (x.id === n.id ? { ...x, read: true } : x)) ?? null);
    const p = notificationPath(n);
    if (p && n.kind !== 'access_request') nav(p);
  };

  return (
    <main className="main">
      <TopBar crumbs={[{ label: t('nav.home') }]} />
      <section className="view">
        <div className="home">
          <div className="home-hi">
            <h1>{t(greeting(new Date().getHours()), { name: session?.user.name ?? '' })}</h1>
            <p>{unread ? t('home.pending', { n: unread }) : t('home.allClear')}</p>
          </div>

          <div className="home-quick">
            <button className="qc primary" onClick={() => create('doc')}>
              <span className="qi"><Icon name="plus" /></span>
              <span>
                {t('home.newDoc')}
                <small>{t('home.newDocHint')}</small>
              </span>
            </button>
            <button className="qc" onClick={openTemplates}>
              <span className="qi"><Icon name="note" /></span>
              <span>
                {t('home.template')}
                <small>{t('home.templateHint')}</small>
              </span>
            </button>
            <button className="qc primary" onClick={() => create('whiteboard')}>
              <span className="qi"><Icon name="board" /></span>
              <span>
                {t('home.board')}
                <small>{t('home.boardHint')}</small>
              </span>
            </button>
            <button
              className="qc"
              aria-haspopup="menu"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setImportAt({ x: r.left, y: r.bottom + 6 });
              }}
            >
              <span className="qi"><Icon name="upload" /></span>
              <span>
                {t('home.import')}
                <small>.md / .docx / .html</small>
              </span>
            </button>
          </div>

          <section className="home-sec">
            <div className="home-h">
              <h2>{t('home.continue')}</h2>
              <Link to="/recent">{t('home.allRecent')}</Link>
            </div>
            {recent.length ? (
              <div className="cards home-cards">
                {recent.map((d) => (
                  <Link key={d.id} className="card" to={`/d/${d.id}`} {...prefetchProps(d.id)}>
                    <Thumb d={d} />
                    <div className="cb">
                      <b>
                        <Icon name={docIcon(d.type)} />
                        {d.title || t('common.untitled')}
                      </b>
                      <span>{t('folder.editedBy', { name: d.lastEditedBy?.name ?? d.owner.name, time: ago(d.updatedAt) })}</span>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="home-empty">{t('home.noRecent')}</p>
            )}
          </section>

          <div className="home-cols">
            <section className="home-sec home-todo">
              <div className="home-h">
                <h2>{t('home.todo')}</h2>
                {!!unread && <span className="home-count">{unread > 99 ? '99+' : unread}</span>}
                <Link to="/notifications">{t('home.allNotif')}</Link>
              </div>
              {!todo ? (
                <p className="home-empty">{t('app.loading')}</p>
              ) : todo.length === 0 ? (
                <p className="home-empty">{t('home.noTodo')}</p>
              ) : (
                todo.map((n) => (
                  <div
                    key={n.id}
                    className={'home-row notif' + (n.read ? '' : ' unread')}
                    role="button"
                    tabIndex={0}
                    onClick={() => openNotif(n)}
                    onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && openNotif(n)}
                  >
                    <Avatar name={n.actor?.name ?? '?'} color={n.actor?.color} />
                    <div className="notif-body">
                      <div>
                        <b>{n.actor?.name ?? t('activity.someone')}</b> {t(VERB[n.kind])}{' '}
                        <b>{n.document ? n.document.title || t('common.untitled') : (n.folder?.name ?? '')}</b>
                      </div>
                      {n.kind !== 'share' && n.detail && <div className="notif-quote">{n.detail}</div>}
                      <time dateTime={n.createdAt}>{ago(n.createdAt)}</time>
                      {n.kind === 'access_request' && n.request && (
                        <RequestActions n={n} onDone={(r) => setTodo((cur) => cur?.map((x) => (x.id === n.id ? { ...x, read: true, request: r } : x)) ?? null)} />
                      )}
                    </div>
                  </div>
                ))
              )}
            </section>

            <section className="home-sec home-star">
              <div className="home-h">
                <h2>{t('home.starred')}</h2>
              </div>
              {starred.map((d) => (
                <Link key={d.id} className="home-row" to={`/d/${d.id}`} {...prefetchProps(d.id)}>
                  <Icon name="star" className="star-on" />
                  <span className="nm">{d.title || t('common.untitled')}</span>
                  <span className="meta">{folderName(d)}</span>
                </Link>
              ))}
              {!starred.length && <p className="home-empty">{t('home.starHint')}</p>}
            </section>
          </div>

          <section className="home-sec">
            <div className="home-h">
              <h2>{t('home.shared')}</h2>
              <Link to="/shared">{t('home.all')}</Link>
            </div>
            {!shared ? (
              <p className="home-empty">{t('app.loading')}</p>
            ) : shared.length === 0 ? (
              <p className="home-empty">{t('home.noShared')}</p>
            ) : (
              shared.map((d) => (
                <Link key={d.id} className="home-row" to={`/d/${d.id}`} {...prefetchProps(d.id)}>
                  <Icon name={docIcon(d.type)} />
                  <span className="nm">{d.title || t('common.untitled')}</span>
                  <span className="meta hide-phone">{d.owner.name}</span>
                  <span className="pill">{t(`role.${d.role}`)}</span>
                </Link>
              ))
            )}
          </section>
        </div>
      </section>
      {importAt && <ContextMenu {...importAt} onClose={() => setImportAt(null)} items={importItems} />}
      {dialog}
    </main>
  );
}

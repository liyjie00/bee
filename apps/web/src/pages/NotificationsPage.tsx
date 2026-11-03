import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/http';
import type { GrantableRole, NotificationDTO } from '../api/types';
import { TopBar } from '../components/TopBar';
import { Avatar } from '../components/Menu';
import { useAgo, useT, type MessageKey } from '../i18n';
import { useLists } from '../state/lists';
import { errMsg, useToast } from '../state/toast';
import { SpaceTile, useSpaceName } from '../components/Spaces';

/** The actor's avatar with a small badge of the space it happened in. */
export function NotifAvatar({ n }: { n: NotificationDTO }) {
  return (
    <span className="notif-av">
      <Avatar name={n.actor?.name ?? '?'} color={n.actor?.color} url={n.actor?.avatarUrl} />
      {n.workspace && <SpaceTile space={n.workspace} size="sm" />}
    </span>
  );
}

/** What a notification is about: the document or folder, or the team for invitations. */
export function notifTarget(n: NotificationDTO, untitled: string): string {
  if (n.kind === 'team_invite') return n.workspace?.name ?? '';
  return n.document ? n.document.title || untitled : (n.folder?.name ?? '');
}

const ROLES: GrantableRole[] = ['viewer', 'commenter', 'editor'];
export const VERB: Record<NotificationDTO['kind'], MessageKey> = {
  mention: 'notif.mention',
  reply: 'notif.reply',
  share: 'notif.share',
  access_request: 'notif.request',
  team_invite: 'notif.teamInvite',
};

/** Where a notification leads: the comment thread, the shared doc or folder. */
export function notificationPath(n: NotificationDTO): string | null {
  if (n.kind === 'team_invite') return '/invites';
  if (n.document) return `/d/${n.document.id}${n.threadId ? `?comment=${n.threadId}` : ''}`;
  if (n.folder) return `/f/${n.folder.id}`;
  return null;
}

export function NotificationsPage() {
  const t = useT();
  const ago = useAgo();
  const nav = useNavigate();
  const toast = useToast();
  const lists = useLists();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [items, setItems] = useState<NotificationDTO[] | null>(null);
  const [more, setMore] = useState(false);
  const spaceName = useSpaceName();

  const load = async (before?: string) => {
    const r = await api.notifications({ unread: unreadOnly, before });
    setItems((cur) => (before ? [...(cur ?? []), ...r.notifications] : r.notifications));
    setMore(r.notifications.length >= 50);
    lists?.setUnread(r.unread);
  };
  useEffect(() => {
    setItems(null);
    load().catch((e) => {
      setItems([]);
      toast(errMsg(e));
    });
  }, [unreadOnly]);

  const markRead = async (ids: string[] | 'all') => {
    setItems((cur) => cur?.map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, read: true } : n)) ?? null);
    try {
      lists?.setUnread(await api.markRead(ids));
    } catch (e) {
      toast(errMsg(e));
    }
  };
  const open = (n: NotificationDTO) => {
    if (!n.read) void markRead([n.id]);
    const p = notificationPath(n);
    if (p && n.kind !== 'access_request') nav(p);
  };

  return (
    <main className="main">
      <TopBar crumbs={[{ label: t('nav.notifications') }]} />
      <section className="view">
        <div className="folder notif-page">
          <div className="fhead">
            <div>
              <h1>{t('nav.notifications')}</h1>
            </div>
            <div className="spacer" />
          </div>
          <div className="fbar">
            <div className="seg" role="group" aria-label={t('notif.filter')}>
              <button className={unreadOnly ? '' : 'on'} onClick={() => setUnreadOnly(false)}>
                {t('notif.all')}
              </button>
              <button className={unreadOnly ? 'on' : ''} onClick={() => setUnreadOnly(true)}>
                {t('notif.unread')}
              </button>
            </div>
            <div className="spacer" />
            <button className="btn" disabled={!lists?.unread} onClick={() => markRead('all')}>
              {t('notif.readAll')}
            </button>
          </div>
          {!items ? (
            <div className="empty">{t('app.loading')}</div>
          ) : items.length === 0 ? (
            <div className="empty">
              <h2>{unreadOnly ? t('notif.noneUnread') : t('notif.none')}</h2>
              <p style={{ margin: 0 }}>{t('notif.hint')}</p>
            </div>
          ) : (
            <div className="notif-list">
              {items.map((n) => (
                <div
                  key={n.id}
                  className={'notif' + (n.read ? '' : ' unread')}
                  role="button"
                  tabIndex={0}
                  onClick={() => open(n)}
                  onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && open(n)}
                >
                  <NotifAvatar n={n} />
                  <div className="notif-body">
                    <div>
                      <b>{n.actor?.name ?? t('activity.someone')}</b> {t(VERB[n.kind])}{' '}
                      <b>{notifTarget(n, t('common.untitled'))}</b>
                      {n.kind === 'share' && n.detail && <span className="notif-role">{t(`role.${n.detail}` as MessageKey)}</span>}
                      {n.kind === 'team_invite' && n.detail && <span className="notif-role">{t(`team.role.${n.detail}` as MessageKey)}</span>}
                      {n.kind === 'access_request' && n.request && (
                        <span className="notif-role">{t(`role.${n.request.role}` as MessageKey)}</span>
                      )}
                    </div>
                    {n.kind !== 'share' && n.kind !== 'team_invite' && n.detail && <div className="notif-quote">{n.detail}</div>}
                    <time dateTime={n.createdAt}>
                      {n.request ? n.request.user.email + ' · ' : ''}
                      {n.workspace && n.kind !== 'team_invite' ? spaceName(n.workspace) + ' · ' : ''}
                      {ago(n.createdAt)}
                    </time>
                    {n.kind === 'access_request' && n.request && (
                      <RequestActions
                        n={n}
                        onDone={(r) => setItems((cur) => cur?.map((x) => (x.id === n.id ? { ...x, read: true, request: r } : x)) ?? null)}
                      />
                    )}
                  </div>
                  {!n.read && <span className="notif-dot" aria-label={t('notif.unread')} />}
                </div>
              ))}
              {more && (
                <button className="btn notif-more" onClick={() => load(items[items.length - 1]!.createdAt).catch((e) => toast(errMsg(e)))}>
                  {t('notif.more')}
                </button>
              )}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

export function RequestActions({ n, onDone }: { n: NotificationDTO; onDone(r: NonNullable<NotificationDTO['request']>): void }) {
  const t = useT();
  const toast = useToast();
  const lists = useLists();
  const r = n.request!;
  const [role, setRole] = useState<GrantableRole>(r.role);
  const [busy, setBusy] = useState(false);
  const act = async (action: { action: 'grant'; role: GrantableRole } | { action: 'decline' }) => {
    setBusy(true);
    try {
      onDone(await api.handleAccessRequest(r.id, action));
      lists?.refreshUnread();
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  if (r.status === 'granted')
    return <div className="notif-done ok">{t('notif.granted', { name: r.user.name, role: t(`role.${r.grantedRole ?? r.role}` as MessageKey) })}</div>;
  if (r.status === 'declined') return <div className="notif-done">{t('notif.declined')}</div>;
  return (
    <div className="notif-actions" onClick={(e) => e.stopPropagation()}>
      <select aria-label={t('notif.grantRole')} value={role} onChange={(e) => setRole(e.target.value as GrantableRole)}>
        {ROLES.map((x) => (
          <option key={x} value={x}>
            {t(`role.${x}` as MessageKey)}
          </option>
        ))}
      </select>
      <button className="btn primary" disabled={busy} onClick={() => act({ action: 'grant', role })}>
        {t('notif.grant')}
      </button>
      <button className="btn" disabled={busy} onClick={() => act({ action: 'decline' })}>
        {t('notif.decline')}
      </button>
    </div>
  );
}

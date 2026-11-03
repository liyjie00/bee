import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, HttpError } from '../api/http';
import { teams, type MyInvite } from '../api/teams';
import type { InvitePreviewDTO } from '../api/types';
import { BeeLogo } from '../components/Logo';
import { Icon } from '../components/Icon';
import { Avatar } from '../components/Menu';
import { SpaceTile } from '../components/Spaces';
import { TopBar } from '../components/TopBar';
import { useSession } from '../state/session';
import { errMsg, useToast } from '../state/toast';
import { useAgo, useT } from '../i18n';

/** /invite/:token: who invites you where, and a button to join (sign in or sign up first). */
export function InvitePage() {
  const t = useT();
  const nav = useNavigate();
  const { token = '' } = useParams();
  const { session, loading, refresh, setWorkspace, setSession } = useSession();
  const [invite, setInvite] = useState<InvitePreviewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (loading) return;
    teams.preview(token).then(setInvite, (e) => setError(e instanceof HttpError && e.status === 404 ? t('invite.invalid') : errMsg(e)));
  }, [token, loading, session?.user.id]);

  const next = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;
  const open = (id: string) => {
    setWorkspace(id);
    nav('/', { replace: true });
  };
  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const w = await teams.accept(token);
      await refresh();
      open(w.id);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }
  async function switchAccount() {
    await api.logout().catch(() => {});
    setSession(null);
    nav(next);
  }
  const wrongEmail = !!(session && invite?.email && invite.email.toLowerCase() !== session.user.email.toLowerCase());

  return (
    <div className="auth">
      <div className="auth-card invite-card">
        <BeeLogo height={22} />
        {!invite ? (
          error ? (
            <>
              <h1 className="welcome-title">{t('invite.invalidTitle')}</h1>
              <p className="muted">{error}</p>
              <Link className="btn" to="/">
                {t('invite.home')}
              </Link>
            </>
          ) : (
            <p className="muted">{t('app.loading')}</p>
          )
        ) : (
          <>
            <SpaceTile space={{ ...invite.workspace, kind: 'team' }} size="xl" />
            <div>
              <div className="muted">{t('invite.by', { name: invite.invitedBy?.name ?? t('activity.someone') })}</div>
              <h1 className="welcome-title">{invite.workspace.name}</h1>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              {t('invite.summary', { n: invite.workspace.memberCount, role: t(`team.role.${invite.role}`) })}
            </p>
            {error && <div className="err" role="alert">{error}</div>}
            {invite.member ? (
              <button className="btn primary" onClick={() => open(invite.workspace.id)}>
                {t('invite.open')}
              </button>
            ) : session ? (
              <>
                <button className="btn primary honey" disabled={busy || wrongEmail} onClick={accept}>
                  {t('invite.joinAs', { email: session.user.email })}
                </button>
                {wrongEmail && <p className="muted small">{t('invite.wrongEmail', { email: invite.email! })}</p>}
                <button className="btn" onClick={switchAccount}>
                  {t('invite.switch')}
                </button>
              </>
            ) : (
              <>
                <Link className="btn primary honey" to={next}>
                  {t('invite.signIn')}
                </Link>
                <p className="muted small">{t('invite.noAccount')}</p>
              </>
            )}
            <p className="muted small">{invite.email ? t('invite.valid') : t('invite.linkNote')}</p>
          </>
        )}
      </div>
    </div>
  );
}

/** /invites: email invitations waiting for the signed-in user, from the inbox. */
export function InvitesPage() {
  const t = useT();
  const ago = useAgo();
  const nav = useNavigate();
  const toast = useToast();
  const { refresh, setWorkspace } = useSession();
  const [list, setList] = useState<MyInvite[] | null>(null);
  const load = () => teams.mine().then(setList, (e) => (setList([]), toast(errMsg(e))));
  useEffect(() => {
    void load();
  }, []);
  async function answer(i: MyInvite, action: 'accept' | 'decline') {
    try {
      await teams.answer(i.id, action);
      if (action === 'accept') {
        await refresh();
        setWorkspace(i.workspace.id);
        nav('/');
      } else void load();
    } catch (e) {
      toast(errMsg(e));
    }
  }
  return (
    <main className="main">
      <TopBar crumbs={[{ label: t('invites.title') }]} />
      <section className="view">
        <div className="folder notif-page">
          <div className="fhead">
            <h1>{t('invites.title')}</h1>
          </div>
          {!list ? (
            <div className="empty">{t('app.loading')}</div>
          ) : list.length === 0 ? (
            <div className="empty">
              <h2>{t('invites.none')}</h2>
            </div>
          ) : (
            <div className="notif-list">
              {list.map((i) => (
                <div className="notif" key={i.id}>
                  <SpaceTile space={{ ...i.workspace, kind: 'team' }} />
                  <div className="notif-body">
                    <div>
                      <b>{i.invitedBy?.name ?? t('activity.someone')}</b> {t('notif.teamInvite')} <b>{i.workspace.name}</b>
                      <span className="notif-role">{t(`team.role.${i.role}`)}</span>
                    </div>
                    <time dateTime={i.createdAt}>{ago(i.createdAt)}</time>
                    <div className="notif-actions">
                      <button className="btn primary" onClick={() => answer(i, 'accept')}>
                        <Icon name="check" />
                        {t('invites.accept')}
                      </button>
                      <button className="btn" onClick={() => answer(i, 'decline')}>
                        {t('invites.decline')}
                      </button>
                    </div>
                  </div>
                  {i.invitedBy && <Avatar name={i.invitedBy.name} color={i.invitedBy.color} url={i.invitedBy.avatarUrl} sm />}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

import { useEffect, useState, type ComponentType, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/http';
import { DOC_FONTS, DOC_FONT_SIZES, USER_COLORS, type UserPrefs } from '@bee/shared';
import type { ApiTokenDTO, ConnectedAppDTO } from '../api/types';
import { Icon, type IconName } from '../components/Icon';
import { Avatar } from '../components/Menu';
import { TopBar } from '../components/TopBar';
import { applyDocPrefs } from '../lib/docPrefs';
import { useSession } from '../state/session';
import { copyText, errMsg, useToast } from '../state/toast';
import { useAgo, useI18n, useT, type MessageKey } from '../i18n';
import { PHONE_QUERY, useMediaQuery } from '../lib/media';
import { NOTIFICATION_KINDS, type NotificationKind } from '@bee/shared';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../lib/push';

function CopyField({ value }: { value: string }) {
  const t = useT();
  const toast = useToast();
  return (
    <div className="copy-field">
      <code>{value}</code>
      <button
        className="btn"
        onClick={async () =>
          toast((await copyText(value)) ? t('settings.copied') : t('common.copyFailed'))
        }
      >
        <Icon name="copy" />
        {t('settings.copy')}
      </button>
    </div>
  );
}

/** Document font size and font style, saved on the account. */
function ReadingSection() {
  const t = useT();
  const toast = useToast();
  const { session, setSession } = useSession();
  const prefs = session?.user.prefs ?? {};
  const size = prefs.docFontSize ?? 'medium';
  const font = prefs.docFont ?? 'sans';

  async function save(patch: UserPrefs) {
    applyDocPrefs({ ...prefs, ...patch });
    try {
      setSession(await api.updateMe({ prefs: patch }));
    } catch (e) {
      applyDocPrefs(prefs);
      toast(errMsg(e));
    }
  }

  return (
    <section>
      <h2>{t('settings.readingTitle')}</h2>
      <p className="lead">{t('settings.readingLead')}</p>
      <div className="pref-row">
        <span className="lbl">{t('settings.fontSize')}</span>
        <div className="seg" role="group" aria-label={t('settings.fontSize')}>
          {DOC_FONT_SIZES.map((s) => (
            <button
              key={s}
              className={s === size ? 'on' : ''}
              aria-pressed={s === size}
              onClick={() => save({ docFontSize: s })}
            >
              {t(`settings.fontSize.${s}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="pref-row">
        <span className="lbl">{t('settings.font')}</span>
        <div className="seg" role="group" aria-label={t('settings.font')}>
          {DOC_FONTS.map((f) => (
            <button
              key={f}
              className={f === font ? 'on' : ''}
              aria-pressed={f === font}
              onClick={() => save({ docFont: f })}
            >
              {t(`settings.font.${f}`)}
            </button>
          ))}
        </div>
      </div>
      <p className="bee-prose pref-preview">{t('settings.preview')}</p>
    </section>
  );
}

const KIND_LABEL: Record<NotificationKind, MessageKey> = {
  mention: 'settings.notif.mention',
  reply: 'settings.notif.reply',
  share: 'settings.notif.share',
  access_request: 'settings.notif.request',
};

/** Browser (Web Push) notifications for this browser, email (coming soon), and which events notify. */
function NotificationsSection() {
  const t = useT();
  const toast = useToast();
  const { session, setSession } = useSession();
  const prefs = session?.user.prefs ?? {};
  const muted = new Set(prefs.mutedNotifications ?? []);
  const [server, setServer] = useState<{
    email: boolean;
    push: boolean;
    vapidPublicKey: string | null;
  } | null>(null);
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = pushSupported();
  const denied = supported && Notification.permission === 'denied';

  useEffect(() => {
    api
      .delivery()
      .then(setServer, () => setServer({ email: false, push: false, vapidPublicKey: null }));
    currentSubscription().then(
      (s) => setOn(!!s),
      () => setOn(false),
    );
  }, []);

  const toggleKind = async (k: NotificationKind) => {
    const next = new Set(muted);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    try {
      setSession(await api.updateMe({ prefs: { mutedNotifications: [...next] } }));
    } catch (e) {
      toast(errMsg(e));
    }
  };
  const emailOn = prefs.emailNotifications !== false;
  const toggleEmail = async () => {
    try {
      setSession(await api.updateMe({ prefs: { emailNotifications: !emailOn } }));
    } catch (e) {
      toast(errMsg(e));
    }
  };
  const enable = async () => {
    if (!server?.vapidPublicKey) return;
    setBusy(true);
    try {
      if (await enablePush(server.vapidPublicKey)) setOn(true);
      else toast(t('settings.notif.denied'));
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    await disablePush().catch(() => {});
    setOn(false);
    setBusy(false);
  };

  const pushHint = !supported
    ? t('settings.notif.unsupported')
    : !server?.push
      ? t('settings.notif.serverOff')
      : denied
        ? t('settings.notif.blocked')
        : on
          ? t('settings.notif.onHint')
          : t('settings.notif.offHint');
  return (
    <section>
      <h2>{t('settings.notif.title')}</h2>
      <p className="lead">{t('settings.notif.lead')}</p>
      <div className="notif-pref">
        <div>
          <b>{t('settings.notif.browser')}</b>
          <small>{pushHint}</small>
        </div>
        {supported && server?.push && !denied && on === false && (
          <button className="btn primary" disabled={busy} onClick={enable}>
            {t('settings.notif.enable')}
          </button>
        )}
        {on && (
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              className="btn"
              disabled={busy}
              onClick={() => api.testPush().catch((e) => toast(errMsg(e)))}
            >
              {t('settings.notif.test')}
            </button>
            <button className="btn" disabled={busy} onClick={disable}>
              {t('settings.notif.disable')}
            </button>
          </div>
        )}
      </div>
      <div className={'notif-pref' + (server?.email ? '' : ' is-soon')}>
        <div>
          <b>
            {t('settings.notif.email')}
            {server && !server.email && <span className="soon">{t('settings.notif.soon')}</span>}
          </b>
          <small>{t('settings.notif.emailHint', { email: session?.user.email ?? '' })}</small>
        </div>
        <button
          className="switch"
          role="switch"
          aria-checked={!!server?.email && emailOn}
          aria-label={t('settings.notif.email')}
          disabled={!server?.email}
          onClick={toggleEmail}
        />
      </div>
      <div className="notif-kinds">
        <span className="lbl">{t('settings.notif.kinds')}</span>
        {NOTIFICATION_KINDS.map((k) => (
          <label key={k}>
            <input type="checkbox" checked={!muted.has(k)} onChange={() => toggleKind(k)} />
            {t(KIND_LABEL[k])}
          </label>
        ))}
      </div>
    </section>
  );
}

/** Center-crops an image to a 256px square, so avatars stay small whatever gets picked. */
async function squareImage(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  canvas
    .getContext('2d')!
    .drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
  bmp.close();
  return new Promise((done, fail) =>
    // browsers that cannot encode WebP hand back a PNG, which the server accepts too
    canvas.toBlob(
      (b) => (b ? done(b) : fail(new Error('Could not read the image'))),
      'image/webp',
      0.9,
    ),
  );
}

/** Photo, name, avatar color, language and sign out. */
function ProfileSection() {
  const { t, lang, setLang } = useI18n();
  const toast = useToast();
  const nav = useNavigate();
  const { session, setSession } = useSession();
  const user = session?.user;
  const [name, setName] = useState(user?.name ?? '');
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  async function update(patch: { name?: string; color?: string }) {
    setBusy(true);
    try {
      setSession(await api.updateMe(patch));
      if (patch.name) toast(t('settings.saved'));
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  async function uploadPhoto(file: File) {
    setBusy(true);
    try {
      setSession(await api.uploadAvatar(await squareImage(file)));
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  async function removePhoto() {
    setBusy(true);
    try {
      setSession(await api.removeAvatar());
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  const saveName = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && name.trim() !== user.name) update({ name: name.trim() });
  };

  return (
    <section>
      <h2>{t('settings.profileTitle')}</h2>
      <p className="lead">{t('settings.profileLead')}</p>
      <div className="notif-pref avatar-row">
        <Avatar name={name.trim() || user.name} color={user.color} url={user.avatarUrl} />
        <div>
          <b>{t('settings.photo')}</b>
          <small>{t('settings.photoHint')}</small>
        </div>
        <div className="avatar-actions">
          <label className={'btn' + (busy ? ' disabled' : '')}>
            {t('settings.photoUpload')}
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) uploadPhoto(f);
              }}
            />
          </label>
          {user.avatarUrl && (
            <button className="btn" disabled={busy} onClick={removePhoto}>
              {t('settings.photoRemove')}
            </button>
          )}
        </div>
      </div>
      <div className="notif-pref">
        <div>
          <b>{t('settings.color')}</b>
          <small>{t('settings.colorHint')}</small>
        </div>
        <div className="swatches" role="group" aria-label={t('settings.color')}>
          {USER_COLORS.map((c) => (
            <button
              key={c}
              className={c.toLowerCase() === user.color?.toLowerCase() ? 'on' : ''}
              style={{ background: c }}
              aria-label={c}
              aria-pressed={c.toLowerCase() === user.color?.toLowerCase()}
              disabled={busy}
              onClick={() => update({ color: c })}
            />
          ))}
        </div>
      </div>
      <form className="notif-pref" onSubmit={saveName}>
        <div>
          <b>{t('settings.name')}</b>
          <small>{t('settings.nameHint')}</small>
        </div>
        <input
          className="field-in name-in"
          aria-label={t('settings.name')}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="btn"
          type="submit"
          disabled={busy || !name.trim() || name.trim() === user.name}
        >
          {t('settings.save')}
        </button>
      </form>
      <div className="notif-pref">
        <div>
          <b>{t('settings.email')}</b>
          <small>{t('settings.emailHint')}</small>
        </div>
        <span style={{ color: 'var(--fg-2)' }}>{user.email}</span>
      </div>
      <div className="notif-pref">
        <div>
          <b>{t('settings.lang')}</b>
          <small>{t('settings.langHint')}</small>
        </div>
        <div className="seg" role="group" aria-label={t('settings.lang')}>
          {(['zh-CN', 'en'] as const).map((l) => (
            <button
              key={l}
              className={l === lang ? 'on' : ''}
              aria-pressed={l === lang}
              onClick={() => setLang(l)}
            >
              {l === 'zh-CN' ? '中文' : 'English'}
            </button>
          ))}
        </div>
      </div>
      <button
        className="btn danger signout"
        onClick={async () => {
          await api.logout().catch(() => {});
          setSession(null);
          nav('/login');
        }}
      >
        {t('nav.signOut')}
      </button>
    </section>
  );
}

/** Connecting AI agents over MCP: the server URL, OAuth-connected apps and personal API tokens. */
function AgentsSection() {
  const t = useT();
  const ago = useAgo();
  const toast = useToast();
  const [tokens, setTokens] = useState<ApiTokenDTO[] | null>(null);
  const [apps, setApps] = useState<ConnectedAppDTO[] | null>(null);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mcpUrl = `${window.location.origin}/mcp`;

  const load = () => {
    api.tokens().then(setTokens, (e) => toast(errMsg(e)));
    api.connectedApps().then(setApps, (e) => toast(errMsg(e)));
  };
  useEffect(load, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await api.createToken(name.trim());
      setSecret(r.secret);
      setName('');
      load();
    } catch (err) {
      toast(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  const used = (iso: string | null) =>
    iso ? t('settings.lastUsed', { when: ago(iso) }) : t('settings.neverUsed');

  return (
    <>
      <section>
        <h2>{t('settings.claudeTitle')}</h2>
        <p className="lead">{t('settings.claudeLead')}</p>
        <label className="lbl">{t('settings.mcpUrl')}</label>
        <CopyField value={mcpUrl} />
        <p className="lead" style={{ marginTop: '0.875rem' }}>
          {t('settings.claudeCode')}
        </p>
        <CopyField
          value={`claude mcp add --transport http bee ${mcpUrl} --header "Authorization: Bearer <token>"`}
        />
      </section>

      <section>
        <h3>{t('settings.appsTitle')}</h3>
        <p className="lead">{t('settings.appsLead')}</p>
        {apps && apps.length === 0 && <p className="lead">{t('settings.appsEmpty')}</p>}
        <ul className="rows">
          {apps?.map((a) => (
            <li key={a.id}>
              <div>
                <b>{a.name}</b>
                <span>
                  {t('settings.connected', { when: ago(a.createdAt) })} · {used(a.lastUsedAt)}
                </span>
              </div>
              <button
                className="btn"
                onClick={async () => {
                  await api.revokeApp(a.id).then(
                    () => toast(t('settings.revoked')),
                    (e) => toast(errMsg(e)),
                  );
                  load();
                }}
              >
                {t('settings.revoke')}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>{t('settings.tokensTitle')}</h3>
        <p className="lead">{t('settings.tokensLead')}</p>
        <form className="token-form" onSubmit={create}>
          <input
            className="field-in"
            aria-label={t('settings.tokenName')}
            placeholder={t('settings.tokenNamePlaceholder')}
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn primary" type="submit" disabled={busy || !name.trim()}>
            {t('settings.createToken')}
          </button>
        </form>
        {secret && (
          <div className="secret" role="status">
            <p>{t('settings.tokenCreated')}</p>
            <CopyField value={secret} />
          </div>
        )}
        {tokens && tokens.length === 0 && <p className="lead">{t('settings.tokensEmpty')}</p>}
        <ul className="rows">
          {tokens?.map((k) => (
            <li key={k.id}>
              <div>
                <b>{k.name}</b>
                <span>
                  <code>{k.prefix}…</code> · {t('settings.created', { when: ago(k.createdAt) })} ·{' '}
                  {used(k.lastUsedAt)}
                </span>
              </div>
              <button
                className="btn"
                onClick={async () => {
                  await api.deleteToken(k.id).then(
                    () => toast(t('settings.revoked')),
                    (e) => toast(errMsg(e)),
                  );
                  load();
                }}
              >
                {t('settings.revoke')}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

type SectionId = 'profile' | 'reading' | 'notifications' | 'agents';
const SECTIONS: { id: SectionId; icon: IconName; title: MessageKey; group?: MessageKey }[] = [
  { id: 'profile', icon: 'user', title: 'settings.profileTitle', group: 'settings.group.account' },
  { id: 'reading', icon: 'text', title: 'settings.readingTitle', group: 'settings.group.prefs' },
  { id: 'notifications', icon: 'bell', title: 'settings.notif.title' },
  {
    id: 'agents',
    icon: 'plug',
    title: 'settings.claudeTitle',
    group: 'settings.group.integrations',
  },
];
const SECTION_VIEW: Record<SectionId, ComponentType> = {
  profile: ProfileSection,
  reading: ReadingSection,
  notifications: NotificationsSection,
  agents: AgentsSection,
};

/**
 * Account settings at /settings/:section. Desktop: a section nav beside one section at a time.
 * Phone: /settings is the list of sections, each opening its own page.
 */
export function SettingsPage() {
  const t = useT();
  const phone = useMediaQuery(PHONE_QUERY);
  const { session } = useSession();
  const { section } = useParams();
  const current = SECTIONS.find((s) => s.id === section);
  if (section && !current) return <Navigate to="/settings" replace />;
  if (!current && !phone) return <Navigate to="/settings/profile" replace />;
  const View = current && SECTION_VIEW[current.id];

  return (
    <main className="main">
      <TopBar
        crumbs={
          current
            ? [{ label: t('settings.title'), to: '/settings' }, { label: t(current.title) }]
            : [{ label: t('settings.title') }]
        }
      />
      {/* .view is the scroll container; the page itself never scrolls */}
      <div className="view">
        <div className="page settings">
          {phone && current ? (
            <Link className="settings-back" to="/settings">
              <Icon name="chev" size={14} />
              {t('settings.back')}
            </Link>
          ) : (
            <h1>{t('settings.title')}</h1>
          )}
          <div className="settings-cols">
            {!(phone && current) && (
              <nav className="settings-nav" aria-label={t('settings.sections')}>
                {phone && session && (
                  <Link to="/settings/profile" className="settings-me">
                    <Avatar
                      name={session.user.name}
                      color={session.user.color}
                      url={session.user.avatarUrl}
                    />
                    <span>
                      <b>{session.user.name}</b>
                      <small>{session.user.email}</small>
                    </span>
                    <Icon name="chev" size={14} />
                  </Link>
                )}
                {SECTIONS.filter((s) => !(phone && s.id === 'profile')).map((s) => (
                  <div key={s.id} className="settings-nav-item">
                    {s.group && <div className="grp">{t(s.group)}</div>}
                    <Link
                      to={`/settings/${s.id}`}
                      className={s.id === current?.id ? 'on' : ''}
                      aria-current={s.id === current?.id ? 'page' : undefined}
                    >
                      <Icon name={s.icon} />
                      <span>{t(s.title)}</span>
                      {phone && <Icon name="chev" size={14} />}
                    </Link>
                  </div>
                ))}
              </nav>
            )}
            {View && (
              <div className="settings-pane" key={current.id}>
                <View />
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

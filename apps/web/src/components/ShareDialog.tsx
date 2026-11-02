import { useEffect, useState } from 'react';
import { api } from '../api/http';
import type { DocumentDTO, GrantableRole, LinkRole, SharingDTO, ShareLinkDTO } from '../api/types';
import { copyText, errMsg, useToast } from '../state/toast';
import { useSession, useTree } from '../state/session';
import { Icon } from './Icon';
import { Avatar } from './Menu';
import { useT } from '../i18n';

export type Access = 'private' | 'link' | 'public';


export function accessOf(s: SharingDTO | null): Access {
  const l = s?.links[0];
  return !l ? 'private' : l.public ? 'public' : 'link';
}

function RoleSelect({ value, onChange, label }: { value: GrantableRole; onChange(r: GrantableRole): void; label: string }) {
  const t = useT();
  return (
    <select className="role" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as GrantableRole)} style={{ border: 0, background: 'transparent' }}>
      {(['editor', 'commenter', 'viewer'] as const).map((r) => (
        <option key={r} value={r}>
          {t(`role.${r}`)}
        </option>
      ))}
    </select>
  );
}

/**
 * Share dialog: invite members by email with a role, and choose general access:
 * invited only / anyone signed in with the link / published (anonymous read).
 */
export function ShareDialog({ doc, onClose, onChange }: { doc: DocumentDTO; onClose(): void; onChange(a: Access): void }) {
  const { session } = useSession();
  const tree = useTree();
  const toast = useToast();
  const t = useT();
  const [sharing, setSharing] = useState<SharingDTO | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<GrantableRole>('editor');
  const [linkRole, setLinkRole] = useState<LinkRole>('viewer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api.sharing(doc.id).then((s) => {
      setSharing(s);
      if (s.links[0]) setLinkRole(s.links[0].role);
      onChange(accessOf(s));
    }, (e) => setError(errMsg(e)));
  useEffect(() => {
    void load();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [doc.id]);

  const access = accessOf(sharing);
  const link: ShareLinkDTO | undefined = sharing?.links[0];

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  const invite = () => {
    const list = email.split(/[\s,，;；]+/).filter(Boolean);
    if (!list.length) return;
    void run(async () => {
      for (const e of list) await api.addGrant(doc.id, e, role);
      setEmail('');
      toast(t('share.invited', { n: list.length }));
    });
  };
  const setAccess = (a: Access) =>
    run(async () => {
      for (const l of sharing?.links ?? []) await api.deleteLink(l.id);
      if (a !== 'private') await api.createLink(doc.id, a === 'public' ? 'viewer' : linkRole, a === 'public');
    });
  // Guest comments raise a public link to commenter; turning them off returns it to read-only.
  const setGuestComments = (on: boolean) =>
    link && run(() => api.updateLink(link.id, { role: on ? 'commenter' : 'viewer', guestComments: on }));
  const changeLinkRole = (r: LinkRole) => {
    setLinkRole(r);
    if (link) void run(() => api.updateLink(link.id, { role: r }));
  };

  const url = link ? link.url : `${location.origin}/d/${doc.id}`;
  const folder = (id: string | null) => tree.folder(id)?.name;

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="shareTitle">
        <div className="mh">
          <h3 id="shareTitle">{t('share.title', { title: doc.title || t('common.untitled') })}</h3>
          <button className="ico" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="mb">
          {doc.role === 'owner' && (
            <div className="invite">
              <div className="field">
                <input
                  placeholder={t('share.invitePlaceholder')}
                  value={email}
                  aria-label={t('share.inviteEmail')}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && invite()}
                  autoFocus
                />
              </div>
              <RoleSelect value={role} onChange={setRole} label={t('share.inviteRole')} />
              <button className="btn primary" disabled={busy || !email.trim()} onClick={invite}>
                {t('share.invite')}
              </button>
            </div>
          )}
          {error && <div className="err" role="alert">{error}</div>}
          <div className="mlabel">{t('share.members')}</div>
          <div className="people">
            <div className="person">
              <Avatar name={doc.owner.name} color={doc.owner.color} />
              <div className="nm">
                {doc.owner.name}
                {doc.owner.id === session?.user.id ? t('share.you') : ''}
                <small>{doc.owner.id === session?.user.id ? session.user.email : ''}</small>
              </div>
              <span className="role" style={{ color: 'var(--fg-3)' }}>
                {t('role.owner')}
              </span>
            </div>
            {sharing?.grants.map((g) => (
              <div className="person" key={g.id}>
                {g.principalType === 'workspace' ? (
                  <span className="av" style={{ background: 'var(--fg-3)' }}>
                    <Icon name="globe" size={13} />
                  </span>
                ) : (
                  <Avatar name={g.user?.name ?? '?'} color={g.user?.color} />
                )}
                <div className="nm">
                  {g.principalType === 'workspace' ? t('share.workspace') : g.user?.name}
                  <small>{g.inherited ? t('share.fromFolder', { name: folder(g.sourceFolderId) ?? t('share.parentFolder') }) : g.user?.email}</small>
                </div>
                {g.inherited || doc.role !== 'owner' ? (
                  <span className="role" style={{ color: 'var(--fg-3)' }}>
                    {t(`role.${g.role}`)}
                  </span>
                ) : (
                  <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
                    <RoleSelect value={g.role} onChange={(r) => run(() => api.updateGrant(g.id, r))} label={t('share.roleOf', { name: g.user?.name ?? '' })} />
                    <button className="ico" aria-label={t('share.remove', { name: g.user?.name ?? '' })} onClick={() => run(() => api.removeGrant(g.id))}>
                      <Icon name="x" />
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="mlabel">{t('share.general')}</div>
          <div className="access" role="radiogroup" aria-label={t('share.general')}>
            {(
              [
                ['private', t('share.private'), t('share.privateHint')],
                ['link', t('share.link'), t('share.linkHint')],
                ['public', t('share.public'), t('share.publicHint')],
              ] as const
            ).map(([k, t, d]) => (
              <button
                key={k}
                role="radio"
                aria-checked={access === k}
                className={'opt' + (access === k ? ' on' : '')}
                disabled={busy || doc.role !== 'owner'}
                onClick={() => access !== k && setAccess(k)}
              >
                <span className="rd" />
                <span>
                  <b>{t}</b>
                  <small>{d}</small>
                </span>
              </button>
            ))}
          </div>
          {access === 'public' && (
            <label className="toggle" style={{ alignItems: 'flex-start', cursor: doc.role === 'owner' ? 'pointer' : undefined }}>
              <input
                type="checkbox"
                style={{ marginTop: '0.1875rem' }}
                checked={!!link?.guestComments}
                disabled={busy || doc.role !== 'owner'}
                onChange={(e) => setGuestComments(e.target.checked)}
              />
              <span>
                <b style={{ fontWeight: 500, display: 'block', color: 'var(--fg)' }}>{t('share.guestComments')}</b>
                <small style={{ color: 'var(--fg-3)', fontSize: '0.75rem' }}>{t('share.guestCommentsHint')}</small>
              </span>
            </label>
          )}
          {access === 'link' && (
            <div className="toggle">
              {t('share.link')}
              <RoleSelect value={linkRole as GrantableRole} onChange={changeLinkRole} label={t('share.linkRole')} />
            </div>
          )}
          <div className="linkrow">
            <code>{url.replace(/^https?:\/\//, '')}</code>
            <button
              className="btn"
              onClick={async () => toast((await copyText(url)) ? t('common.linkCopied') : t('common.copyFailed'))}
            >
              <Icon name="copy" />
              {t('common.copyLink')}
            </button>
          </div>
        </div>
        <div className="mf">
          <span style={{ fontSize: '0.75rem', color: 'var(--fg-3)' }}>{t('share.footer')}</span>
          <button className="btn" onClick={onClose}>
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  );
}

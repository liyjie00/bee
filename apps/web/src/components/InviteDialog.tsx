import { useEffect, useState } from 'react';
import { INVITE_ROLES, type InviteRole } from '@bee/shared';
import { teams, type SentInvite } from '../api/teams';
import type { TeamInviteDTO, TeamLinkDTO, WorkspaceDTO } from '../api/types';
import { copyText, errMsg, useToast } from '../state/toast';
import { useAgo, useT } from '../i18n';
import { Icon } from './Icon';
import { SpaceTile } from './Spaces';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const splitEmails = (s: string) =>
  s
    .split(/[\s,，;；]+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => EMAIL.test(x));

/** Email addresses as removable chips; Enter, comma or space turns the typed text into chips. */
export function EmailChips({
  emails,
  setEmails,
  draft,
  setDraft,
  autoFocus,
}: {
  emails: string[];
  setEmails(e: string[]): void;
  draft: string;
  setDraft(s: string): void;
  autoFocus?: boolean;
}) {
  const t = useT();
  const commit = (text = draft) => {
    const add = splitEmails(text).filter((e) => !emails.includes(e));
    if (add.length) setEmails([...emails, ...add]);
    // keep what is not an address yet, so a typo can be fixed
    setDraft(add.length ? '' : text.replace(/[\s,，;；]+$/, ''));
  };
  return (
    <div className="email-chips">
      {emails.map((e) => (
        <span className="chip" key={e}>
          {e}
          <button aria-label={t('team.invite.removeEmail', { email: e })} onClick={() => setEmails(emails.filter((x) => x !== e))}>
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}
      <input
        autoFocus={autoFocus}
        value={draft}
        aria-label={t('team.invite.emails')}
        placeholder={emails.length ? '' : t('team.invite.emailsPlaceholder')}
        onChange={(e) => (/[\s,，;；]$/.test(e.target.value) ? commit(e.target.value) : setDraft(e.target.value))}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Backspace' && !draft && emails.length) setEmails(emails.slice(0, -1));
        }}
      />
    </div>
  );
}

/** Invitation links that could not be emailed (email is off), to copy and send by hand. */
export function UnsentLinks({ invites }: { invites: SentInvite[] }) {
  const t = useT();
  const toast = useToast();
  return (
    <div className="unsent">
      <p>{t('team.invite.unsent')}</p>
      {invites.map((i) => (
        <div className="linkrow" key={i.email}>
          <span className="who">{i.email}</span>
          <code>{i.url.replace(/^https?:\/\//, '')}</code>
          <button className="btn" onClick={async () => toast((await copyText(i.url)) ? t('common.linkCopied') : t('common.copyFailed'))}>
            <Icon name="copy" />
            {t('common.copyLink')}
          </button>
        </div>
      ))}
    </div>
  );
}

export function InviteRoleSelect({ value, onChange, label }: { value: InviteRole; onChange(r: InviteRole): void; label: string }) {
  const t = useT();
  return (
    <select className="role" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as InviteRole)}>
      {INVITE_ROLES.map((r) => (
        <option key={r} value={r}>
          {t(`team.role.${r}`)}
        </option>
      ))}
    </select>
  );
}

/** Invite by email, the team's join link, and invitations still waiting for an answer. */
export function InviteDialog({ team, onClose }: { team: WorkspaceDTO; onClose(): void }) {
  const t = useT();
  const ago = useAgo();
  const toast = useToast();
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [role, setRole] = useState<InviteRole>('editor');
  const [pending, setPending] = useState<TeamInviteDTO[]>([]);
  const [link, setLink] = useState<TeamLinkDTO | null>(null);
  const [unsent, setUnsent] = useState<SentInvite[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = team.role === 'owner';

  const load = () =>
    teams.invites(team.id).then((r) => {
      setPending(r.invites);
      setLink(r.link);
    }, (e) => setError(errMsg(e)));
  useEffect(() => {
    void load();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [team.id]);

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
  const send = () => {
    const list = [...emails, ...splitEmails(draft)];
    if (!list.length) return;
    void run(async () => {
      const sent = await teams.invite(team.id, list, role);
      setEmails([]);
      setDraft('');
      setUnsent(sent.filter((s) => !s.emailed));
      toast(t('team.invite.sent', { n: sent.length }));
    });
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal invite-modal" role="dialog" aria-modal="true" aria-labelledby="inviteTitle">
        <div className="mh">
          <SpaceTile space={team} size="sm" />
          <h3 id="inviteTitle" style={{ marginLeft: '0.5rem' }}>
            {t('team.invite.title', { name: team.name })}
          </h3>
          <button className="ico" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="mb">
          <div>
            <div className="mlabel with-icon">
              <Icon name="mail" size={14} />
              {t('team.invite.byEmail')}
            </div>
            <div className="invite" style={{ marginTop: '0.75rem' }}>
              <EmailChips emails={emails} setEmails={setEmails} draft={draft} setDraft={setDraft} autoFocus />
              <InviteRoleSelect value={role} onChange={setRole} label={t('team.invite.role')} />
              <button className="btn primary" disabled={busy || (!emails.length && !splitEmails(draft).length)} onClick={send}>
                {t('team.invite.send')}
              </button>
            </div>
          </div>
          {unsent.length > 0 && <UnsentLinks invites={unsent} />}
          {error && <div className="err" role="alert">{error}</div>}

          {link && (
            <div className="join-link">
              <div className="toggle">
                <Icon name="link" />
                <b>{t('team.link.title')}</b>
                <span style={{ marginLeft: 'auto' }}>{link.url ? t('team.link.on') : t('team.link.off')}</span>
                {owner && (
                  <button
                    className={'sw' + (link.url ? ' on' : '')}
                    role="switch"
                    aria-checked={!!link.url}
                    aria-label={t('team.link.title')}
                    disabled={busy}
                    onClick={() => run(() => teams.setLink(team.id, { enabled: !link.url }))}
                  />
                )}
              </div>
              {link.url && (
                <>
                  <div className="linkrow">
                    <code>{link.url.replace(/^https?:\/\//, '')}</code>
                    <button className="btn" onClick={async () => toast((await copyText(link.url!)) ? t('common.linkCopied') : t('common.copyFailed'))}>
                      <Icon name="copy" />
                      {t('common.copyLink')}
                    </button>
                  </div>
                  <div className="toggle small">
                    {t('team.link.joinAs')}
                    {owner ? (
                      <InviteRoleSelect value={link.role} onChange={(r) => run(() => teams.setLink(team.id, { role: r }))} label={t('team.link.role')} />
                    ) : (
                      <b>{t(`team.role.${link.role}`)}</b>
                    )}
                    {owner && (
                      <button className="link-danger" disabled={busy} onClick={() => run(() => teams.resetLink(team.id))}>
                        {t('team.link.reset')}
                      </button>
                    )}
                  </div>
                </>
              )}
              {!link.url && !owner && <small className="muted">{t('team.link.offHint')}</small>}
            </div>
          )}

          {pending.length > 0 && (
            <div>
              <div className="mlabel">{t('team.invite.pending', { n: pending.length })}</div>
              <div className="pending">
                {pending.map((p) => (
                  <div className="person" key={p.id}>
                    <span className="av" style={{ background: 'var(--sunk)', color: 'var(--fg-3)' }}>
                      <Icon name="mail" size={13} />
                    </span>
                    <div className="nm">
                      {p.email}
                      <small>
                        {t(`team.role.${p.role}`)} · {t('team.invite.sentAgo', { ago: ago(p.createdAt) })}
                      </small>
                    </div>
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: '0.25rem' }}>
                      <button
                        className="btn sm"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            const r = await teams.resend(team.id, p.id);
                            if (r && !r.emailed) setUnsent([r]);
                            else toast(t('team.invite.resent'));
                          })
                        }
                      >
                        {t('team.invite.resend')}
                      </button>
                      <button className="btn sm danger" disabled={busy} onClick={() => run(() => teams.revoke(team.id, p.id))}>
                        {t('team.invite.revoke')}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

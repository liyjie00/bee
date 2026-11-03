import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TEAM_COLORS } from '@bee/shared';
import { teams, type SentInvite } from '../api/teams';
import { useSession } from '../state/session';
import { errMsg } from '../state/toast';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { EmailChips, splitEmails, UnsentLinks } from './InviteDialog';

/** New team: name, tile color and (optionally) people to invite as editors. */
export function CreateTeamDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  const nav = useNavigate();
  const { refresh, setWorkspace } = useSession();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(TEAM_COLORS[0]);
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsent, setUnsent] = useState<SentInvite[] | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await teams.create({ name: name.trim(), color, emails: [...emails, ...splitEmails(draft)] });
      await refresh();
      setWorkspace(r.workspace.id);
      nav('/');
      const notSent = r.invites.filter((i) => !i.emailed);
      if (notSent.length) setUnsent(notSent);
      else onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="newTeamTitle">
        <div className="mh">
          <h3 id="newTeamTitle">{t('team.create.title')}</h3>
          <button className="ico" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {unsent ? (
          <div className="mb">
            <UnsentLinks invites={unsent} />
          </div>
        ) : (
          <div className="mb">
            <p className="team-lead">{t('team.create.lead')}</p>
            <div className="team-name-row">
              <span className="space-tile lg" style={{ background: color }} aria-hidden="true">
                {[...name.trim()][0]?.toUpperCase() ?? 'T'}
              </span>
              <label className="team-field">
                <span>{t('team.create.name')}</span>
                <input
                  autoFocus
                  value={name}
                  maxLength={100}
                  placeholder={t('team.create.namePlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && create()}
                />
              </label>
            </div>
            <div className="team-field">
              <span>{t('team.create.color')}</span>
              <div className="swatches" role="radiogroup" aria-label={t('team.create.color')}>
                {TEAM_COLORS.map((c) => (
                  <button
                    key={c}
                    role="radio"
                    aria-checked={c === color}
                    aria-label={c}
                    className={'swatch' + (c === color ? ' on' : '')}
                    style={{ background: c }}
                    onClick={() => setColor(c)}
                  />
                ))}
              </div>
            </div>
            <div className="team-field">
              <span>
                {t('team.create.invite')} <em>{t('team.create.optional')}</em>
              </span>
              <EmailChips emails={emails} setEmails={setEmails} draft={draft} setDraft={setDraft} />
              <small>{t('team.create.inviteHint')}</small>
            </div>
            {error && <div className="err" role="alert">{error}</div>}
          </div>
        )}
        <div className="mf">
          <span />
          {unsent ? (
            <button className="btn primary" onClick={onClose}>
              {t('common.done')}
            </button>
          ) : (
            <span style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button className="btn primary" disabled={busy || !name.trim()} onClick={create}>
                {emails.length || draft.trim() ? t('team.create.submitInvite') : t('team.create.submit')}
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

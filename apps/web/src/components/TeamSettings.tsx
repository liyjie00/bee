import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TEAM_COLORS, WORKSPACE_ROLES, type WorkspaceRole } from '@bee/shared';
import { teams } from '../api/teams';
import type { TeamInviteDTO, WorkspaceDTO, WorkspaceMemberDTO } from '../api/types';
import { useSession } from '../state/session';
import { errMsg, useToast } from '../state/toast';
import { useAgo, useI18n, useT } from '../i18n';
import { Icon } from './Icon';
import { Avatar } from './Menu';
import { InviteDialog } from './InviteDialog';
import { ROLE_LABEL, SpaceTile } from './Spaces';

/** Settings › a team: its name and color, members and their roles, leaving or deleting it. */
export function TeamSettings({ team }: { team: WorkspaceDTO }) {
  const t = useT();
  const ago = useAgo();
  const { lang } = useI18n();
  const toast = useToast();
  const nav = useNavigate();
  const { session, refresh, setWorkspace, personal } = useSession();
  const [members, setMembers] = useState<WorkspaceMemberDTO[] | null>(null);
  const [pending, setPending] = useState<TeamInviteDTO[]>([]);
  const [inviting, setInviting] = useState(false);
  const [name, setName] = useState(team.name);
  const [filter, setFilter] = useState<WorkspaceRole | 'all'>('all');
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const owner = team.role === 'owner';
  const me = session?.user.id;

  const load = () =>
    Promise.all([teams.members(team.id), teams.invites(team.id)]).then(
      ([m, i]) => {
        setMembers(m);
        setPending(i.invites);
      },
      (e) => toast(errMsg(e)),
    );
  useEffect(() => {
    setName(team.name);
    void load();
  }, [team.id]);

  /** `away`: the change takes the user out of the team (leave, delete), so go elsewhere after. */
  async function run(fn: () => Promise<unknown>, away?: () => void) {
    try {
      await fn();
      if (away) {
        away();
        await refresh();
        return;
      }
      await Promise.all([load(), refresh()]);
    } catch (e) {
      toast(errMsg(e));
    }
  }
  const leaveTo = () => {
    if (personal) setWorkspace(personal.id);
    nav('/');
  };
  const date = (iso: string) => new Date(iso).toLocaleDateString(lang, { month: 'short', day: 'numeric' });
  const shown = (members ?? []).filter(
    (m) =>
      (filter === 'all' || m.role === filter) &&
      (!q.trim() || (m.user.name + ' ' + m.user.email).toLowerCase().includes(q.trim().toLowerCase())),
  );
  const count = (r: WorkspaceRole) => members?.filter((m) => m.role === r).length ?? 0;

  return (
    <>
      <section>
        <div className="team-head">
          <SpaceTile space={{ ...team, name }} size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{team.name}</h2>
            <p className="lead" style={{ margin: 0 }}>
              {t('team.settings.lead', { n: members?.length ?? team.memberCount, role: t(ROLE_LABEL[team.role]) })}
            </p>
          </div>
          {team.role !== 'viewer' && (
            <button className="btn primary" onClick={() => setInviting(true)}>
              <Icon name="plus" />
              {t('team.settings.invite')}
            </button>
          )}
        </div>
        {owner && (
          <div className="team-general">
            <label className="team-field">
              <span>{t('team.create.name')}</span>
              <input
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && name.trim() !== team.name && run(() => teams.update(team.id, { name: name.trim() }))}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
            </label>
            <div className="team-field">
              <span>{t('team.create.color')}</span>
              <div className="swatches" role="radiogroup" aria-label={t('team.create.color')}>
                {TEAM_COLORS.map((c) => (
                  <button
                    key={c}
                    role="radio"
                    aria-checked={c === team.color}
                    aria-label={c}
                    className={'swatch' + (c === team.color ? ' on' : '')}
                    style={{ background: c }}
                    onClick={() => run(() => teams.update(team.id, { color: c }))}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2>{t('team.settings.members')}</h2>
        <div className="member-tools">
          <label className="member-search">
            <Icon name="search" />
            <input value={q} placeholder={t('team.settings.search')} aria-label={t('team.settings.search')} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="seg" role="group" aria-label={t('team.settings.filter')}>
            <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
              {t('team.settings.all', { n: members?.length ?? 0 })}
            </button>
            {(['owner', 'editor', 'viewer'] as const).map((r) => (
              <button key={r} className={filter === r ? 'on' : ''} onClick={() => setFilter(r)}>
                {t(ROLE_LABEL[r])} {count(r)}
              </button>
            ))}
          </div>
        </div>
        <ul className="rows members">
          {shown.map((m) => (
            <li key={m.user.id}>
              <Avatar name={m.user.name} color={m.user.color} url={m.user.avatarUrl} />
              <div className="who">
                <b>
                  {m.user.name}
                  {m.user.id === me && <span className="you">{t('team.settings.you')}</span>}
                </b>
                <small>{m.user.email}</small>
              </div>
              <span className="since">{t('team.settings.joined', { date: date(m.joinedAt) })}</span>
              {owner ? (
                <select
                  className="role-select"
                  aria-label={t('team.settings.roleOf', { name: m.user.name })}
                  value={m.role}
                  onChange={(e) => run(() => teams.setRole(team.id, m.user.id, e.target.value as WorkspaceRole))}
                >
                  {[...WORKSPACE_ROLES].reverse().map((r) => (
                    <option key={r} value={r}>
                      {t(ROLE_LABEL[r])}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="role-text">{t(ROLE_LABEL[m.role])}</span>
              )}
              {owner && m.user.id !== me ? (
                <button
                  className="ico"
                  aria-label={t('team.settings.remove', { name: m.user.name })}
                  title={t('team.settings.remove', { name: m.user.name })}
                  onClick={() => window.confirm(t('team.settings.removeConfirm', { name: m.user.name })) && run(() => teams.removeMember(team.id, m.user.id))}
                >
                  <Icon name="x" />
                </button>
              ) : (
                <span className="ico-pad" />
              )}
            </li>
          ))}
          {filter === 'all' &&
            !q.trim() &&
            pending.map((p) => (
              <li key={p.id} className="pending-row">
                <span className="av" style={{ background: 'var(--sunk)', color: 'var(--fg-3)' }}>
                  <Icon name="mail" size={13} />
                </span>
                <div className="who">
                  <b>{p.email}</b>
                  <small>{t('team.settings.pendingInvite')}</small>
                </div>
                <span className="since">{t('team.invite.sentAgo', { ago: ago(p.createdAt) })}</span>
                <span className="role-text">{t(`team.role.${p.role}`)}</span>
                {team.role !== 'viewer' ? (
                  <button className="ico" aria-label={t('team.invite.revoke')} title={t('team.invite.revoke')} onClick={() => run(() => teams.revoke(team.id, p.id))}>
                    <Icon name="x" />
                  </button>
                ) : (
                  <span className="ico-pad" />
                )}
              </li>
            ))}
        </ul>
        <p className="lead" style={{ marginTop: '0.75rem' }}>
          {t('team.settings.rolesHint')}
        </p>
      </section>

      <section className="danger-zone">
        <div className="danger-row">
          <div>
            <b>{t('team.settings.leave')}</b>
            <small>{t('team.settings.leaveHint')}</small>
          </div>
          <button
            className="btn danger"
            onClick={() =>
              me &&
              window.confirm(t('team.settings.leaveConfirm', { name: team.name })) &&
              run(() => teams.removeMember(team.id, me), leaveTo)
            }
          >
            {t('team.settings.leaveBtn', { name: team.name })}
          </button>
        </div>
        {owner && (
          <div className="danger-row">
            <div>
              <b>{t('team.settings.delete')}</b>
              <small>{t('team.settings.deleteHint')}</small>
              {confirm !== null && (
                <input
                  autoFocus
                  className="confirm-input"
                  value={confirm}
                  placeholder={team.name}
                  aria-label={t('team.settings.deleteType', { name: team.name })}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              )}
            </div>
            {confirm === null ? (
              <button className="btn danger" onClick={() => setConfirm('')}>
                {t('team.settings.deleteBtn')}
              </button>
            ) : (
              <button
                className="btn danger"
                disabled={confirm.trim() !== team.name.trim()}
                onClick={() => run(() => teams.remove(team.id, confirm), leaveTo)}
              >
                {t('team.settings.deleteConfirm')}
              </button>
            )}
          </div>
        )}
      </section>
      {inviting && (
        <InviteDialog
          team={team}
          onClose={() => {
            setInviting(false);
            void load();
          }}
        />
      )}
    </>
  );
}

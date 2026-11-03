import { useEffect, useState } from 'react';
import type { GrantableRole } from '@bee/shared';
import { api } from '../api/http';
import { teams } from '../api/teams';
import type { FolderDTO, SharingDTO, WorkspaceDTO, WorkspaceMemberDTO } from '../api/types';
import { useSession } from '../state/session';
import { errMsg } from '../state/toast';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { Avatar } from './Menu';

const ROLES: GrantableRole[] = ['editor', 'commenter', 'viewer'];

/**
 * Who sees a team folder: the whole team (by team role), or only the people added here
 * (restricted). Restricting is for the folder's owner, since it can lock team owners out too.
 */
export function FolderAccessDialog({
  folder,
  team,
  onClose,
  onChanged,
}: {
  folder: FolderDTO;
  team: WorkspaceDTO;
  onClose(): void;
  onChanged(): void;
}) {
  const t = useT();
  const { session } = useSession();
  const [restricted, setRestricted] = useState(folder.restricted);
  const [sharing, setSharing] = useState<SharingDTO | null>(null);
  const [members, setMembers] = useState<WorkspaceMemberDTO[]>([]);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<GrantableRole>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOwner = folder.ownerId === session?.user.id;
  const canManage = folder.role === 'owner';

  const load = () => teams.folderSharing(folder.id).then(setSharing, (e) => setError(errMsg(e)));
  useEffect(() => {
    void load();
    teams.members(team.id).then(setMembers, () => {});
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [folder.id]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  const people = (sharing?.grants ?? []).filter((g) => g.principalType === 'user' && g.user);
  const owner = members.find((m) => m.user.id === folder.ownerId)?.user;
  const addable = members.filter((m) => m.user.id !== folder.ownerId && !people.some((g) => g.user?.id === m.user.id));

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="faTitle">
        <div className="mh">
          <h3 id="faTitle">{t('restrict.title', { name: folder.name })}</h3>
          <button className="ico" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="mb">
          <div className="access" role="radiogroup" aria-label={t('restrict.title', { name: folder.name })}>
            <button
              role="radio"
              aria-checked={!restricted}
              className={'opt' + (!restricted ? ' on' : '')}
              disabled={busy || !canManage}
              onClick={() => restricted && run(async () => (await teams.setRestricted(folder.id, false), setRestricted(false)))}
            >
              <span className="rd" />
              <span>
                <b>{t('restrict.team', { name: team.name })}</b>
                <small>{t('restrict.teamHint')}</small>
              </span>
            </button>
            <button
              role="radio"
              aria-checked={restricted}
              className={'opt' + (restricted ? ' on' : '')}
              disabled={busy || !isOwner}
              onClick={() => !restricted && run(async () => (await teams.setRestricted(folder.id, true), setRestricted(true)))}
            >
              <span className="rd" />
              <span>
                <b className="with-icon">
                  <Icon name="lock" size={13} />
                  {t('restrict.only')}
                </b>
                <small>{t('restrict.onlyHint')}</small>
              </span>
            </button>
          </div>
          {!isOwner && !restricted && <small className="muted">{t('restrict.ownerOnly')}</small>}
          {restricted && (
            <>
              {canManage && addable.length > 0 && (
                <div className="invite">
                  <select className="field-select" aria-label={t('restrict.add')} value={pick} onChange={(e) => setPick(e.target.value)}>
                    <option value="">{t('restrict.add')}</option>
                    {addable.map((m) => (
                      <option key={m.user.id} value={m.user.email}>
                        {m.user.name} · {m.user.email}
                      </option>
                    ))}
                  </select>
                  <select className="role" aria-label={t('share.inviteRole')} value={role} onChange={(e) => setRole(e.target.value as GrantableRole)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`role.${r}`)}
                      </option>
                    ))}
                  </select>
                  <button className="btn primary" disabled={busy || !pick} onClick={() => run(async () => (await teams.addFolderGrant(folder.id, pick, role), setPick('')))}>
                    {t('restrict.addBtn')}
                  </button>
                </div>
              )}
              <div className="people">
                {owner && (
                  <div className="person">
                    <Avatar name={owner.name} color={owner.color} url={owner.avatarUrl} />
                    <div className="nm">
                      {owner.name}
                      {owner.id === session?.user.id ? t('share.you') : ''}
                      <small>{t('restrict.creator')}</small>
                    </div>
                    <span className="role" style={{ color: 'var(--fg-3)' }}>
                      {t('role.owner')}
                    </span>
                  </div>
                )}
                {people.map((g) => (
                  <div className="person" key={g.id}>
                    <Avatar name={g.user!.name} color={g.user!.color} url={g.user!.avatarUrl} />
                    <div className="nm">
                      {g.user!.name}
                      <small>{g.user!.email}</small>
                    </div>
                    {canManage && !g.inherited ? (
                      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
                        <select className="role" aria-label={t('share.roleOf', { name: g.user!.name })} value={g.role} onChange={(e) => run(() => api.updateGrant(g.id, e.target.value as GrantableRole))}>
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {t(`role.${r}`)}
                            </option>
                          ))}
                        </select>
                        <button className="ico" aria-label={t('share.remove', { name: g.user!.name })} onClick={() => run(() => api.removeGrant(g.id))}>
                          <Icon name="x" />
                        </button>
                      </span>
                    ) : (
                      <span className="role" style={{ color: 'var(--fg-3)' }}>
                        {t(`role.${g.role}`)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div className="move-note">
                <Icon name="lock" />
                <span>{t('restrict.note')}</span>
              </div>
            </>
          )}
          {error && <div className="err" role="alert">{error}</div>}
        </div>
        <div className="mf">
          <span />
          <button className="btn" onClick={onClose}>
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  );
}

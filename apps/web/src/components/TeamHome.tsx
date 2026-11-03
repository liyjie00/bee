import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { teams } from '../api/teams';
import type { WorkspaceDTO, WorkspaceMemberDTO } from '../api/types';
import { useTree } from '../state/session';
import { useAgo, useT } from '../i18n';
import { prefetchProps } from '../lib/doc-cache';
import { Icon, docIcon } from './Icon';
import { Avatar } from './Menu';
import { InviteDialog } from './InviteDialog';
import { SpaceTile } from './Spaces';

const AVATARS = 4;
const UPDATES = 6;

/** Top of a team's home: who is in it, its folders and what changed lately. */
export function TeamHome({ team }: { team: WorkspaceDTO }) {
  const t = useT();
  const ago = useAgo();
  const nav = useNavigate();
  const { tree } = useTree();
  const [members, setMembers] = useState<WorkspaceMemberDTO[]>([]);
  const [inviting, setInviting] = useState(false);
  useEffect(() => {
    teams.members(team.id).then(setMembers, () => setMembers([]));
  }, [team.id, team.memberCount]);

  const top = tree.folders.filter((f) => !f.parentId).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const inFolder = (id: string) => {
    const ids = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of tree.folders)
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
          ids.add(f.id);
          grew = true;
        }
    }
    return tree.documents.filter((d) => d.folderId && ids.has(d.folderId) && !d.deletedAt).length;
  };
  const updates = [...tree.documents]
    .filter((d) => !d.deletedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, UPDATES);
  const folderName = (id: string | null) => tree.folders.find((f) => f.id === id)?.name ?? '';

  return (
    <>
      <div className="team-hero">
        <SpaceTile space={team} size="xl" />
        <div className="who">
          <h1>{team.name}</h1>
          <p>{t('teamHome.lead')}</p>
        </div>
        <div className="stack" aria-label={t('teamHome.members', { n: team.memberCount })}>
          {members.slice(0, AVATARS).map((m) => (
            <Avatar key={m.user.id} name={m.user.name} color={m.user.color} url={m.user.avatarUrl} />
          ))}
          {members.length > AVATARS && <span className="av more">+{members.length - AVATARS}</span>}
        </div>
        <button className="btn" onClick={() => nav(`/settings/team-${team.id}`)}>
          <Icon name="gear" />
          {t('teamHome.settings')}
        </button>
        {team.role !== 'viewer' && (
          <button className="btn primary" onClick={() => setInviting(true)}>
            <Icon name="plus" />
            {t('teamHome.invite')}
          </button>
        )}
      </div>

      {top.length > 0 && (
        <section className="home-sec">
          <div className="home-h">
            <h2>{t('teamHome.folders')}</h2>
            <Link to="/files">{t('home.all')}</Link>
          </div>
          <div className="team-folders">
            {top.map((f) => (
              <Link key={f.id} to={`/f/${f.id}`} className={'team-folder' + (f.restricted ? ' restricted' : '')}>
                <b>
                  <Icon name="folder" />
                  <span className="nm">{f.name}</span>
                  {f.restricted && <Icon name="lock" size={13} />}
                </b>
                <small>
                  {f.restricted ? t('teamHome.restricted') + ' · ' : ''}
                  {t('teamHome.docs', { n: inFolder(f.id) })}
                </small>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="home-sec">
        <div className="home-h">
          <h2>{t('teamHome.updates')}</h2>
        </div>
        {updates.length ? (
          updates.map((d) => (
            <Link key={d.id} className="home-row" to={`/d/${d.id}`} {...prefetchProps(d.id)}>
              <Icon name={docIcon(d.type)} className={d.type === 'whiteboard' ? 't-board' : undefined} />
              <span className="nm">{d.title || t('common.untitled')}</span>
              <span className="meta hide-phone">{folderName(d.folderId)}</span>
              <Avatar name={(d.lastEditedBy ?? d.owner).name} color={(d.lastEditedBy ?? d.owner).color} url={(d.lastEditedBy ?? d.owner).avatarUrl} sm />
              <span className="meta">{ago(d.updatedAt)}</span>
            </Link>
          ))
        ) : (
          <p className="home-empty">{t('teamHome.empty')}</p>
        )}
      </section>
      {inviting && <InviteDialog team={team} onClose={() => setInviting(false)} />}
    </>
  );
}

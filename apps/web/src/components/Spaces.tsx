import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceDTO } from '../api/types';
import { useSession } from '../state/session';
import { useT, type MessageKey } from '../i18n';
import { Icon } from './Icon';
import { CreateTeamDialog } from './CreateTeamDialog';
import { InviteDialog } from './InviteDialog';

/** A space's badge: the person's initial in a circle for the personal space, a colored square for a team. */
export function SpaceTile({
  space,
  size = 'md',
}: {
  space: Pick<WorkspaceDTO, 'name' | 'color'> & { kind?: WorkspaceDTO['kind'] };
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const { session } = useSession();
  const personal = space.kind === 'personal';
  const label = personal ? (session?.user.name ?? space.name) : space.name;
  return (
    <span
      className={`space-tile ${size}` + (personal ? ' personal' : '')}
      style={{ background: personal ? (session?.user.color ?? '#7c3aed') : space.color }}
      aria-hidden="true"
    >
      {[...label.trim()][0]?.toUpperCase() ?? '?'}
    </span>
  );
}

export const ROLE_LABEL: Record<WorkspaceDTO['role'], MessageKey> = {
  owner: 'team.role.owner',
  editor: 'team.role.editor',
  viewer: 'team.role.viewer',
};

/**
 * Shows the space a page's document or folder belongs to, when the user is a member of it, so
 * the sidebar, search and "new" buttons match what is open.
 */
export function useFollowSpace(workspaceId: string | null | undefined) {
  const { session, workspace, setWorkspace } = useSession();
  useEffect(() => {
    if (workspaceId && workspace && workspaceId !== workspace.id && session?.workspaces.some((w) => w.id === workspaceId))
      setWorkspace(workspaceId);
  }, [workspaceId]);
}

/** Name a space is shown under: "J's space" for the personal one. */
export function useSpaceName() {
  const t = useT();
  return (w: Pick<WorkspaceDTO, 'kind' | 'name'>) => (w.kind === 'personal' ? t('space.personal') : w.name);
}

/** Top of the sidebar: which space is shown, and a menu to switch, create a team or invite. */
export function SpaceSwitcher({ onNavigate }: { onNavigate?(): void }) {
  const t = useT();
  const nav = useNavigate();
  const spaceName = useSpaceName();
  const { session, workspace, setWorkspace } = useSession();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [inviting, setInviting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  if (!session || !workspace) return null;
  const spaces = session.workspaces;
  const teams = spaces.filter((w) => w.kind === 'team');
  const personal = spaces.filter((w) => w.kind !== 'team');
  const isTeam = workspace.kind === 'team';

  const pick = (w: WorkspaceDTO) => {
    setOpen(false);
    if (w.id !== workspace.id) {
      setWorkspace(w.id);
      nav('/');
      onNavigate?.();
    }
  };
  const row = (w: WorkspaceDTO) => (
    <button
      key={w.id}
      role="menuitemradio"
      aria-checked={w.id === workspace.id}
      className={'space-row' + (w.id === workspace.id ? ' cur' : '')}
      onClick={() => pick(w)}
    >
      <SpaceTile space={w} />
      <span className="nm">
        {spaceName(w)}
        <small>
          {w.kind === 'team'
            ? t('space.roleCount', { role: t(ROLE_LABEL[w.role]), n: w.memberCount })
            : t('space.onlyYou')}
        </small>
      </span>
      {w.id === workspace.id && <Icon name="check" className="tick" />}
    </button>
  );

  return (
    <div className="space-switch" ref={ref}>
      <button
        className={'space-btn' + (open ? ' open' : '')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('space.switch')}
        onClick={() => setOpen((o) => !o)}
      >
        <SpaceTile space={workspace} />
        <span className="nm">
          {spaceName(workspace)}
          <small>
            {isTeam ? t('space.teamCount', { n: workspace.memberCount }) : t('space.private')}
          </small>
        </span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className="space-menu" role="menu" aria-label={t('space.switch')}>
          <div className="grp">{t('space.mine')}</div>
          {personal.map(row)}
          {teams.length > 0 && <div className="grp">{t('space.teams')}</div>}
          {teams.map(row)}
          <div className="sep" />
          <button role="menuitem" className="space-row act" onClick={() => (setOpen(false), setCreating(true))}>
            <Icon name="plus" />
            {t('space.create')}
          </button>
          {isTeam && workspace.role !== 'viewer' && (
            <button role="menuitem" className="space-row act" onClick={() => (setOpen(false), setInviting(true))}>
              <Icon name="users" />
              {t('space.inviteTo', { name: workspace.name })}
            </button>
          )}
          {isTeam && (
            <button
              role="menuitem"
              className="space-row act"
              onClick={() => {
                setOpen(false);
                nav(`/settings/team-${workspace.id}`);
                onNavigate?.();
              }}
            >
              <Icon name="gear" />
              {t('space.settings')}
            </button>
          )}
        </div>
      )}
      {creating && <CreateTeamDialog onClose={() => setCreating(false)} />}
      {inviting && <InviteDialog team={workspace} onClose={() => setInviting(false)} />}
    </div>
  );
}

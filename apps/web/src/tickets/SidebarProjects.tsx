/* Sidebar section: the space's projects and saved ticket views. */
import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import type { SavedViewDTO } from '@bee/shared';
import { tickets as api } from '../api/tickets';
import { Icon } from '../components/Icon';
import { useMenu } from '../components/Menu';
import { useT } from '../i18n';
import { useSession } from '../state/session';
import { errMsg, useToast } from '../state/toast';
import { CreateProjectDialog } from './pages';
import { ProjectTile } from './ui';
import { useWorkspaceProjects } from './useProject';

export function viewLink(v: SavedViewDTO): string {
  const c = v.config;
  const q = new URLSearchParams();
  if (Object.keys(c.filter).length) q.set('f', JSON.stringify(c.filter));
  if (c.groupBy) q.set('g', c.groupBy);
  if (c.sortBy) q.set('s', c.sortBy);
  if (c.swimlane) q.set('l', c.swimlane);
  const qs = q.toString();
  return v.projectId ? `/projects/${v.projectId}/${c.view}${qs ? `?${qs}` : ''}` : `/my-tickets`;
}

export function SidebarProjects({
  workspaceId,
  open,
  onToggle,
  onNavigate,
}: {
  workspaceId: string;
  open: boolean;
  onToggle(): void;
  onNavigate(): void;
}) {
  const t = useT();
  const toast = useToast();
  const menu = useMenu();
  const loc = useLocation();
  const { workspace } = useSession();
  const projects = useWorkspaceProjects(workspaceId);
  const [views, setViews] = useState<SavedViewDTO[]>([]);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      api.views(workspaceId).then(
        (v) => live && setViews(v),
        () => {},
      );
    void load();
    addEventListener('bee:projects-changed', load);
    return () => {
      live = false;
      removeEventListener('bee:projects-changed', load);
    };
  }, [workspaceId]);
  const shown = (projects ?? []).filter((p) => !p.archivedAt);
  const canCreate = workspace?.role !== 'viewer';
  return (
    <>
      <div className="sec">
        <button className="sec-toggle" aria-expanded={open} onClick={onToggle}>
          <Icon name={open ? 'down' : 'chev'} size={11} />
          {t('tk.projects')}
        </button>
        <NavLink to="/projects" className="sec-more" onClick={onNavigate}>
          {t('nav.all')}
        </NavLink>
        {canCreate && (
          <button
            className="sec-new"
            title={t('tk.proj.new')}
            aria-label={t('tk.proj.new')}
            onClick={() => setCreating(true)}
          >
            <Icon name="plus" />
          </button>
        )}
      </div>
      {open && (
        <div className="tree quick">
          {shown.map((p) => (
            <div className="row" key={p.id}>
              <NavLink
                to={`/projects/${p.id}`}
                className={() => (loc.pathname.startsWith(`/projects/${p.id}`) ? 'on' : '')}
                style={{ paddingLeft: '0.5rem' }}
                onClick={onNavigate}
              >
                <ProjectTile project={p} size={16} />
                <span className="nm">{p.name}</span>
                <span className="tk-side-key">{p.key}</span>
              </NavLink>
            </div>
          ))}
          {views.map((v) => (
            <div className="row" key={v.id}>
              <NavLink
                to={viewLink(v)}
                className={() => ''}
                style={{ paddingLeft: '0.5rem' }}
                onClick={onNavigate}
                onContextMenu={(e) =>
                  v.mine &&
                  menu.open(e, [
                    {
                      label: t('tk.view.delete'),
                      icon: 'trash',
                      danger: true,
                      onSelect: () =>
                        void api.deleteView(v.id).then(
                          () => setViews((x) => x.filter((y) => y.id !== v.id)),
                          (er) => toast(errMsg(er)),
                        ),
                    },
                  ])
                }
              >
                <Icon name="star" />
                <span className="nm">{v.name}</span>
                {v.shared && <Icon name="users" size={12} />}
              </NavLink>
              {v.mine && (
                <button
                  className="more"
                  style={{ width: 'auto' }}
                  aria-label={t('common.moreFor', { name: v.name })}
                  onClick={(e) =>
                    menu.open(e, [
                      {
                        label: t('tk.view.delete'),
                        icon: 'trash',
                        danger: true,
                        onSelect: () =>
                          void api.deleteView(v.id).then(
                            () => setViews((x) => x.filter((y) => y.id !== v.id)),
                            (er) => toast(errMsg(er)),
                          ),
                      },
                    ])
                  }
                >
                  <Icon name="more" size={14} />
                </button>
              )}
            </div>
          ))}
          {projects && shown.length === 0 && <p className="quick-empty">{t('tk.side.empty')}</p>}
        </div>
      )}
      {menu.node}
      {creating && (
        <CreateProjectDialog workspaceId={workspaceId} onClose={() => setCreating(false)} />
      )}
    </>
  );
}

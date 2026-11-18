/* Ticket pages outside a project: the list of projects, My tickets, and a ticket on its own page. */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { compareTickets, type ProjectDTO, type ProjectTemplate, type TicketDTO } from '@bee/shared';
import { tickets as api } from '../api/tickets';
import { Icon } from '../components/Icon';
import { TopBar } from '../components/TopBar';
import { useFollowSpace, useSpaceName } from '../components/Spaces';
import { useI18n, type MessageKey } from '../i18n';
import { useSession } from '../state/session';
import { errMsg } from '../state/toast';
import { TicketDetail } from './TicketDetail';
import { fmtDate, PriorityIcon, ProjectTile, StatusDot, TypeIcon, today } from './ui';
import { projectsChanged, useWorkspaceProjects } from './useProject';

const COLORS = ['#e8a317', '#3b7dd8', '#1e6b2a', '#c2410c', '#7c3aed', '#0e7490', '#be185d'];

/** Suggests a key from a name: "Bee Product" → BP, "Website" → WEB. */
export function suggestKey(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '';
  const k = words.length > 1 ? words.map((w) => w[0]).join('') : words[0]!.slice(0, 3);
  return /^[A-Z]/.test(k) ? k.slice(0, 10) : 'P' + k.slice(0, 9);
}

export function CreateProjectDialog({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose(): void;
}) {
  const { t } = useI18n();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [template, setTemplate] = useState<ProjectTemplate>('scrum');
  const [color, setColor] = useState(COLORS[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownKey = keyEdited ? key : suggestKey(name);
  const valid = name.trim() && /^[A-Z][A-Z0-9]{1,9}$/.test(shownKey);
  const create = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProject(workspaceId, {
        name: name.trim(),
        key: shownKey,
        template,
        color,
      });
      projectsChanged();
      onClose();
      nav(`/projects/${p.id}/${template === 'scrum' ? 'backlog' : 'board'}`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tkNewProject"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="mh">
          <h3 id="tkNewProject">{t('tk.proj.new')}</h3>
          <button type="button" className="ico" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="mb tk-form">
          <div className="tk-templates" role="radiogroup" aria-label={t('tk.proj.template')}>
            {(['scrum', 'kanban', 'simple'] as ProjectTemplate[]).map((tp) => (
              <button
                type="button"
                key={tp}
                role="radio"
                aria-checked={template === tp}
                className={template === tp ? 'on' : ''}
                onClick={() => setTemplate(tp)}
              >
                <b>{t(`tk.tpl.${tp}` as MessageKey)}</b>
                <small>{t(`tk.tpl.${tp}.hint` as MessageKey)}</small>
              </button>
            ))}
          </div>
          <label>
            {t('tk.proj.name')}
            <input
              className="field-in"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('tk.proj.namePh')}
            />
          </label>
          <label>
            {t('tk.proj.key')}
            <input
              className="field-in mono"
              value={shownKey}
              maxLength={10}
              onChange={(e) => {
                setKeyEdited(true);
                setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
              }}
            />
            <small className="muted">{t('tk.proj.keyHint2', { key: shownKey || 'BEE' })}</small>
          </label>
          <div className="lbl">{t('tk.proj.color')}</div>
          <div className="tk-colors">
            {COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className={'tk-color' + (color === c ? ' on' : '')}
                style={{ background: c }}
                aria-label={c}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          {error && <p className="err">{error}</p>}
        </div>
        <div className="mf">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={!valid || busy}>
            {t('tk.proj.create')}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ProjectsPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const { workspace } = useSession();
  const spaceName = useSpaceName();
  const projects = useWorkspaceProjects(workspace?.id);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const canCreate = workspace?.role !== 'viewer';
  const list = (projects ?? []).filter((p) => showArchived || !p.archivedAt);
  return (
    <main className="main">
      <TopBar crumbs={[{ label: t('tk.projects') }]} />
      <section className="view">
        <div className="folder">
          <div className="fhead">
            <div>
              <h1>{t('tk.projects')}</h1>
              <p>{workspace ? t('tk.projects.sub', { space: spaceName(workspace) }) : ''}</p>
            </div>
            <div className="spacer" />
            {canCreate && (
              <button className="btn primary" onClick={() => setCreating(true)}>
                <Icon name="plus" />
                {t('tk.proj.new')}
              </button>
            )}
          </div>
          {projects === null ? (
            <div className="empty">{t('app.loading')}</div>
          ) : list.length === 0 ? (
            <div className="empty">
              <h2>{t('tk.projects.empty')}</h2>
              <p style={{ margin: 0 }}>{t('tk.projects.emptyHint')}</p>
              {canCreate && (
                <button className="btn primary" onClick={() => setCreating(true)}>
                  <Icon name="plus" />
                  {t('tk.proj.new')}
                </button>
              )}
            </div>
          ) : (
            <div className="cards tk-proj-cards">
              {list.map((p) => (
                <button
                  key={p.id}
                  className="card tk-proj-card"
                  onClick={() => nav(`/projects/${p.id}`)}
                >
                  <div className="cb">
                    <b>
                      <ProjectTile project={p} size={26} />
                      {p.name}
                    </b>
                    <span>
                      {p.key} · {t(`tk.tpl.${p.template}` as MessageKey)} ·{' '}
                      {t('tk.proj.open', { n: p.openCount })}
                      {p.archivedAt ? ` · ${t('tk.proj.archivedTag')}` : ''}
                    </span>
                    {p.lead && <span>{t('tk.proj.leadIs', { name: p.lead.name })}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
          {(projects ?? []).some((p) => p.archivedAt) && (
            <label
              className="check"
              style={{ marginTop: '1rem', display: 'inline-flex', gap: '0.375rem' }}
            >
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              {t('tk.projects.showArchived')}
            </label>
          )}
        </div>
      </section>
      {creating && workspace && (
        <CreateProjectDialog workspaceId={workspace.id} onClose={() => setCreating(false)} />
      )}
    </main>
  );
}

export function MyTicketsPage() {
  const { t, lang } = useI18n();
  const { workspace } = useSession();
  const projects = useWorkspaceProjects(workspace?.id);
  const [list, setList] = useState<TicketDTO[] | null>(null);
  const [withDone, setWithDone] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => {
    if (!workspace) return;
    void api
      .search({
        workspaceId: workspace.id,
        filter: { assignees: ['me'], ...(withDone ? {} : { categories: ['todo', 'doing'] }) },
      })
      .then(setList, () => setList([]));
  };
  useEffect(load, [workspace?.id, withDone]);
  const byProject = useMemo(() => {
    const m = new Map<string, ProjectDTO>();
    for (const p of projects ?? []) m.set(p.id, p);
    return m;
  }, [projects]);
  const statusOf = (x: TicketDTO) =>
    byProject.get(x.projectId)?.statuses.find((s) => s.id === x.statusId);
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: TicketDTO[] }[] = [
      { key: 'overdue', label: t('tk.my.overdue'), items: [] },
      { key: 'doing', label: t('tk.my.doing'), items: [] },
      { key: 'todo', label: t('tk.my.todo'), items: [] },
      { key: 'done', label: t('tk.my.done'), items: [] },
    ];
    for (const x of [...(list ?? [])].sort(compareTickets('priority'))) {
      const c = statusOf(x)?.category ?? 'todo';
      if (c !== 'done' && x.dueDate && x.dueDate < today()) out[0]!.items.push(x);
      else out[c === 'doing' ? 1 : c === 'done' ? 3 : 2]!.items.push(x);
    }
    return out.filter((g) => g.items.length);
  }, [list, byProject, t]);
  return (
    <main className="main">
      <TopBar crumbs={[{ label: t('tk.my.title') }]} />
      <section className="view">
        <div className="folder">
          <div className="fhead">
            <div>
              <h1>{t('tk.my.title')}</h1>
              <p>{t('tk.my.sub')}</p>
            </div>
            <div className="spacer" />
            <label
              className="check"
              style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center' }}
            >
              <input
                type="checkbox"
                checked={withDone}
                onChange={(e) => setWithDone(e.target.checked)}
              />
              {t('tk.my.withDone')}
            </label>
          </div>
          {list === null ? (
            <div className="empty">{t('app.loading')}</div>
          ) : !list.length ? (
            <div className="empty">
              <h2>{t('tk.my.empty')}</h2>
              <p style={{ margin: 0 }}>{t('tk.my.emptyHint')}</p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.key} className="tk-my-group">
                <h3 className={g.key === 'overdue' ? 'warn' : ''}>
                  {g.label} <span className="muted">{g.items.length}</span>
                </h3>
                <div className="tk-box">
                  {g.items.map((x) => {
                    const p = byProject.get(x.projectId);
                    const s = statusOf(x);
                    return (
                      <button key={x.id} className="tk-row" onClick={() => setOpen(x.id)}>
                        <TypeIcon type={x.type} />
                        <span className="tk-key">{x.key}</span>
                        <span className={'nm' + (s?.category === 'done' ? ' done' : '')}>
                          {x.title}
                        </span>
                        {p && (
                          <span className="muted hide-phone tk-proj-tag">
                            <ProjectTile project={p} size={14} />
                            {p.name}
                          </span>
                        )}
                        {x.dueDate && (
                          <span className={'sm ' + (g.key === 'overdue' ? 'tk-overdue' : 'muted')}>
                            {fmtDate(x.dueDate, lang)}
                          </span>
                        )}
                        <PriorityIcon priority={x.priority} />
                        <StatusDot status={s} />
                        <span className="muted st hide-phone">{s?.name}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </section>
      {open && (
        <>
          <div className="tk-panel-scrim" onClick={() => setOpen(null)} />
          <TicketDetail
            ticketId={open}
            mode="panel"
            onClose={() => setOpen(null)}
            onOpen={setOpen}
            onChanged={load}
            onDeleted={load}
          />
        </>
      )}
    </main>
  );
}

export function TicketPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const nav = useNavigate();
  const [project, setProject] = useState<{ id: string; name: string; workspaceId: string } | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    void api.get(id).then(
      (x) =>
        live &&
        setProject({ id: x.project.id, name: x.project.name, workspaceId: x.project.workspaceId }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [id]);
  useFollowSpace(project?.workspaceId);
  return (
    <main className="main">
      <TopBar
        crumbs={[
          { label: t('tk.projects'), to: '/projects' },
          ...(project ? [{ label: project.name, to: `/projects/${project.id}` }] : []),
        ]}
      >
        {project && (
          <Link className="btn hide-phone" to={`/projects/${project.id}/board?ticket=${id}`}>
            {t('tk.openInBoard')}
          </Link>
        )}
      </TopBar>
      <section className="view">
        <TicketDetail
          ticketId={id}
          mode="page"
          onOpen={(x) => nav(`/t/${x}`)}
          onDeleted={() => nav(project ? `/projects/${project.id}` : '/projects')}
        />
      </section>
    </main>
  );
}

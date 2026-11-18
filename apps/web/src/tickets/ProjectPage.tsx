/* A ticket project: header with the sprint, view tabs, filters, the view itself, the ticket
 * side panel and bulk actions. Route: /projects/:id/:view (backlog, board, list, timeline,
 * reports, settings); ?ticket=<id> opens a ticket, ?f=<json> carries the filter. */
import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  GROUP_BYS,
  matchesFilter,
  PRIORITIES,
  SORT_BYS,
  SWIMLANES,
  type GroupBy,
  type SortBy,
  type Swimlane,
  type TicketFilter,
  type ViewKind,
} from '@bee/shared';
import { tickets as api, type TicketPatch } from '../api/tickets';
import { Icon } from '../components/Icon';
import { TopBar } from '../components/TopBar';
import { useFollowSpace } from '../components/Spaces';
import { useI18n, type MessageKey } from '../i18n';
import { useSession } from '../state/session';
import { errMsg, useToast } from '../state/toast';
import { BacklogView } from './BacklogView';
import { BoardView } from './BoardView';
import { ProjectContext, type ProjectCtx } from './context';
import { CreateTicketDialog } from './CreateTicketDialog';
import { FilterBar } from './FilterBar';
import { ListView } from './ListView';
import { ProjectSettings } from './ProjectSettings';
import { ReportsView } from './ReportsView';
import { ResolutionDialog } from './ResolutionDialog';
import { CompleteSprintDialog } from './SprintDialogs';
import { TicketDetail } from './TicketDetail';
import { TimelineView } from './TimelineView';
import { Picker, PriorityIcon, ProjectTile, StatusDot, UserChip, fmtDate, priorityKey } from './ui';
import { projectsChanged, useProject } from './useProject';

type View = ViewKind | 'reports' | 'settings';
const VIEWS: View[] = ['backlog', 'board', 'list', 'timeline', 'reports', 'settings'];

function loadPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* private mode */
  }
}

export function ProjectPage() {
  const { id = '', view: viewParam } = useParams();
  const { session } = useSession();
  const { data, error } = useProject(id, session?.user.id ?? '');
  const { t } = useI18n();
  useFollowSpace(data?.project.workspaceId);
  if (error)
    return (
      <main className="main">
        <TopBar crumbs={[{ label: t('tk.projects'), to: '/projects' }]} />
        <div className="empty">
          <h2>{t('tk.proj.missing')}</h2>
        </div>
      </main>
    );
  if (!data)
    return (
      <main className="main">
        <TopBar crumbs={[{ label: t('tk.projects'), to: '/projects' }]} />
        <div className="empty">{t('app.loading')}</div>
      </main>
    );
  const def: View = data.project.usesSprints ? 'board' : 'board';
  const view = (VIEWS as string[]).includes(viewParam ?? '') ? (viewParam as View) : null;
  if (!view) return <Navigate to={`/projects/${id}/${def}`} replace />;
  if (view === 'backlog' && !data.project.usesSprints)
    return <Navigate to={`/projects/${id}/list`} replace />;
  return <Loaded data={data} view={view} />;
}

function Loaded({
  data,
  view,
}: {
  data: NonNullable<ReturnType<typeof useProject>['data']>;
  view: View;
}) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { project } = data;
  const prefKey = (k: string) => `bee.tk.${project.id}.${k}`;
  const [swimlane, setSwimlaneState] = useState<Swimlane>(() =>
    loadPref(prefKey('lane'), SWIMLANES, 'none'),
  );
  const [groupBy, setGroupByState] = useState<GroupBy>(() =>
    loadPref(prefKey('group'), GROUP_BYS, 'status'),
  );
  const [sortBy, setSortByState] = useState<SortBy>(() =>
    loadPref(prefKey('sort'), SORT_BYS, 'rank'),
  );
  const [creating, setCreating] = useState<TicketPatch | null>(null);
  const [resolutionFor, setResolutionFor] = useState<{
    id: string;
    statusId: string;
    extra?: TicketPatch;
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [completing, setCompleting] = useState(false);
  const [bulkPick, setBulkPick] = useState<{ key: string; el: HTMLElement } | null>(null);
  const [savingView, setSavingView] = useState(false);

  const filter = useMemo<TicketFilter>(() => {
    try {
      return JSON.parse(params.get('f') ?? '{}') as TicketFilter;
    } catch {
      return {};
    }
  }, [params]);
  const setFilter = (f: TicketFilter) => {
    const n = new URLSearchParams(params);
    if (Object.keys(f).length) n.set('f', JSON.stringify(f));
    else n.delete('f');
    setParams(n, { replace: true });
  };
  // Saved views carry their layout in the link.
  useEffect(() => {
    const g = params.get('g') as GroupBy | null;
    const s = params.get('s') as SortBy | null;
    const l = params.get('l') as Swimlane | null;
    if (g && GROUP_BYS.includes(g)) setGroupByState(g);
    if (s && SORT_BYS.includes(s)) setSortByState(s);
    if (l && SWIMLANES.includes(l)) setSwimlaneState(l);
  }, [params.get('g'), params.get('s'), params.get('l')]);
  const setSwimlane = (v: Swimlane) => (setSwimlaneState(v), savePref(prefKey('lane'), v));
  const setGroupBy = (v: GroupBy) => (setGroupByState(v), savePref(prefKey('group'), v));
  const setSortBy = (v: SortBy) => (setSortByState(v), savePref(prefKey('sort'), v));
  const openId = params.get('ticket');
  const openTicket = (tid: string | null) => {
    const n = new URLSearchParams(params);
    if (tid) n.set('ticket', tid);
    else n.delete('ticket');
    setParams(n);
  };

  // Which tickets each view starts from, before the filter bar.
  const base = useMemo(() => {
    const all = data.tickets;
    if (view === 'board') {
      if (project.usesSprints)
        return data.activeSprint ? all.filter((x) => x.sprintId === data.activeSprint!.id) : [];
      return all;
    }
    return all;
  }, [data.tickets, view, data.activeSprint]);
  const visible = useMemo(
    () => base.filter((x) => matchesFilter(x, filter, data.filterCtx)),
    [base, filter, data.filterCtx],
  );

  useEffect(() => setSelected(new Set()), [view, project.id]);
  // Keyboard: C creates a ticket.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el?.closest('input,textarea,select,[contenteditable="true"]') ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      if (e.key === 'c' && project.canEdit && !creating) {
        e.preventDefault();
        setCreating({});
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [project.canEdit, creating]);

  const move = (tid: string, statusId: string, extra?: TicketPatch) => {
    const s = data.status(statusId);
    if (s?.category === 'done' && s.requireResolution)
      setResolutionFor({ id: tid, statusId, extra });
    else void data.update(tid, { ...extra, statusId });
  };

  const ctx: ProjectCtx = {
    ...data,
    filter,
    visible,
    openTicket,
    move,
    newTicket: (d = {}) => setCreating(d),
    selected,
    setSelected,
    createQuick: async (p) => {
      try {
        const x = await api.create(project.id, p);
        data.upsert(x);
      } catch (e) {
        toast(errMsg(e));
      }
    },
  };

  const bulk = async (patch: TicketPatch | null, del = false) => {
    try {
      const r = await api.bulk([...selected], patch, del);
      data.upsert(r.updated);
      data.drop(r.deleted);
      if (r.errors.length)
        toast(t('tk.bulk.partial', { n: r.errors.length, msg: r.errors[0]!.message }));
      else
        toast(
          del
            ? t('tk.bulk.deleted', { n: r.deleted.length })
            : t('tk.bulk.updated', { n: r.updated.length }),
        );
      setSelected(new Set());
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const sprint = data.activeSprint;
  const sprintPts = sprint ? data.tickets.filter((x) => x.sprintId === sprint.id) : [];
  const donePts = sprintPts
    .filter((x) => data.status(x.statusId)?.category === 'done')
    .reduce((n, x) => n + (x.storyPoints ?? 0), 0);
  const doingPts = sprintPts
    .filter((x) => data.status(x.statusId)?.category === 'doing')
    .reduce((n, x) => n + (x.storyPoints ?? 0), 0);
  const allPts = sprintPts.reduce((n, x) => n + (x.storyPoints ?? 0), 0);
  const daysLeft = sprint?.endDate
    ? Math.max(0, Math.ceil((Date.parse(sprint.endDate + 'T23:59:59') - Date.now()) / 86400_000))
    : null;

  const tabs = VIEWS.filter((v) =>
    v === 'backlog' ? project.usesSprints : v === 'settings' ? project.canAdmin : true,
  );
  const showFilters =
    view === 'board' || view === 'list' || view === 'backlog' || view === 'timeline';

  const viewOpts =
    view === 'board' ? (
      <label className="tk-opt">
        {t('tk.opt.swimlane')}
        <select value={swimlane} onChange={(e) => setSwimlane(e.target.value as Swimlane)}>
          {SWIMLANES.map((s) => (
            <option key={s} value={s}>
              {t(`tk.lane.${s}` as MessageKey)}
            </option>
          ))}
        </select>
      </label>
    ) : view === 'list' ? (
      <>
        <label className="tk-opt">
          {t('tk.opt.group')}
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            {GROUP_BYS.filter((g) => g !== 'sprint' || project.usesSprints).map((g) => (
              <option key={g} value={g}>
                {t(`tk.group.${g}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="tk-opt">
          {t('tk.opt.sort')}
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
            {SORT_BYS.map((s) => (
              <option key={s} value={s}>
                {t(`tk.sort.${s}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
      </>
    ) : null;

  return (
    <ProjectContext.Provider value={ctx}>
      <main className="main tk-main">
        <TopBar
          crumbs={[{ label: t('tk.projects'), to: '/projects' }, { label: project.name }]}
          phoneMenu={
            project.canEdit
              ? [{ label: t('tk.new'), icon: 'plus', onSelect: () => setCreating({}) }]
              : []
          }
        >
          {project.canEdit && (
            <button
              className="btn primary hide-phone"
              onClick={() => setCreating({})}
              title={t('tk.newShortcut')}
            >
              <Icon name="plus" />
              {t('tk.new')}
            </button>
          )}
        </TopBar>
        <section className="view tk-view">
          <header className="tk-head">
            <div className="tk-title-row">
              <ProjectTile project={project} size={30} />
              <div className="tk-title-txt">
                <h1>{view === 'board' && sprint ? sprint.name : project.name}</h1>
                <p className="muted">
                  {view === 'board' && sprint
                    ? [
                        `${fmtDate(sprint.startDate, lang)} – ${fmtDate(sprint.endDate, lang)}`,
                        daysLeft !== null ? t('tk.sprint.daysLeft', { n: daysLeft }) : '',
                        sprint.goal,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : `${project.key} · ${t('tk.proj.open', { n: data.tickets.filter((x) => data.status(x.statusId)?.category !== 'done').length })}${project.archivedAt ? ` · ${t('tk.proj.archivedTag')}` : ''}`}
                </p>
              </div>
              {view === 'board' && sprint && allPts > 0 && (
                <span
                  className="tk-sprint-prog hide-phone"
                  title={t('tk.sprint.progress', { done: donePts, all: allPts })}
                >
                  <span className="bar">
                    <i className="done" style={{ width: `${(donePts / allPts) * 100}%` }} />
                    <i className="doing" style={{ width: `${(doingPts / allPts) * 100}%` }} />
                  </span>
                  <span className="muted">
                    {t('tk.sprint.progress', { done: donePts, all: allPts })}
                  </span>
                </span>
              )}
              <div className="spacer" />
              {view === 'board' && sprint && project.canEdit && (
                <button className="btn" onClick={() => setCompleting(true)}>
                  {t('tk.sprint.complete')}
                </button>
              )}
            </div>
            <nav className="tk-tabs big" aria-label={t('tk.views')}>
              {tabs.map((v) => (
                <button
                  key={v}
                  className={view === v ? 'on' : ''}
                  aria-current={view === v ? 'page' : undefined}
                  onClick={() =>
                    nav(
                      `/projects/${project.id}/${v}${params.get('f') ? `?f=${encodeURIComponent(params.get('f')!)}` : ''}`,
                    )
                  }
                >
                  {t(`tk.view.${v}` as MessageKey)}
                </button>
              ))}
            </nav>
          </header>
          {showFilters && (
            <FilterBar
              data={data}
              filter={filter}
              setFilter={setFilter}
              hideStatus={view === 'board'}
              right={
                <>
                  {viewOpts}
                  <button className="btn sm" onClick={() => setSavingView(true)}>
                    <Icon name="star" size={12} />
                    {t('tk.view.save')}
                  </button>
                </>
              }
            />
          )}
          <div className="tk-body">
            {view === 'board' && <BoardView tickets={visible} swimlane={swimlane} />}
            {view === 'list' && <ListView tickets={visible} groupBy={groupBy} sortBy={sortBy} />}
            {view === 'backlog' && <BacklogView tickets={visible} />}
            {view === 'timeline' && <TimelineView tickets={visible} />}
            {view === 'reports' && <ReportsView />}
            {view === 'settings' && <ProjectSettings />}
          </div>
        </section>

        {selected.size > 0 && project.canEdit && (
          <div className="tk-bulk" role="toolbar" aria-label={t('tk.bulk.label')}>
            <b>{t('tk.bulk.selected', { n: selected.size })}</b>
            {(
              [
                'status',
                'assignee',
                'priority',
                ...(project.usesSprints ? ['sprint'] : []),
                ...(data.epics.length ? ['epic'] : []),
                'labels',
                'points',
              ] as const
            ).map((k) => (
              <button key={k} onClick={(e) => setBulkPick({ key: k, el: e.currentTarget })}>
                {t(`tk.bulk.${k}` as MessageKey)}
              </button>
            ))}
            <button
              className="danger"
              onClick={() =>
                confirm(t('tk.bulk.deleteConfirm', { n: selected.size })) && void bulk(null, true)
              }
            >
              {t('tk.bulk.delete')}
            </button>
            <button aria-label={t('tk.bulk.clear')} onClick={() => setSelected(new Set())}>
              <Icon name="x" />
            </button>
          </div>
        )}
        {bulkPick && (
          <Picker
            anchor={bulkPick.el}
            search={bulkPick.key === 'assignee' || bulkPick.key === 'epic'}
            options={
              bulkPick.key === 'status'
                ? project.statuses.map((s) => ({
                    id: s.id,
                    label: s.name,
                    icon: <StatusDot status={s} />,
                  }))
                : bulkPick.key === 'assignee'
                  ? [
                      { id: '', label: t('tk.unassigned'), icon: <UserChip user={null} /> },
                      ...data.members.map((m) => ({
                        id: m.id,
                        label: m.name,
                        icon: <UserChip user={m} />,
                      })),
                    ]
                  : bulkPick.key === 'priority'
                    ? [...PRIORITIES]
                        .reverse()
                        .map((p) => ({
                          id: p,
                          label: t(priorityKey(p)),
                          icon: <PriorityIcon priority={p} />,
                        }))
                    : bulkPick.key === 'sprint'
                      ? [
                          { id: '', label: t('tk.backlog') },
                          ...data.sprints
                            .filter((s) => s.state !== 'closed')
                            .map((s) => ({ id: s.id, label: s.name })),
                        ]
                      : bulkPick.key === 'epic'
                        ? [
                            { id: '', label: t('tk.none') },
                            ...data.epics.map((e) => ({ id: e.id, label: e.title, hint: e.key })),
                          ]
                        : bulkPick.key === 'labels'
                          ? project.labels.map((l) => ({
                              id: l.id,
                              label: l.name,
                              icon: <span className="tk-swatch" style={{ background: l.color }} />,
                            }))
                          : [0, 1, 2, 3, 5, 8, 13, 21].map((n) => ({
                              id: String(n),
                              label: String(n),
                            }))
            }
            onPick={(v) => {
              const k = bulkPick.key;
              if (k === 'status') {
                const s = data.status(v);
                if (s?.category === 'done' && s.requireResolution)
                  void bulk({ statusId: v, resolution: 'done' });
                else void bulk({ statusId: v });
              } else if (k === 'assignee') void bulk({ assigneeId: v || null });
              else if (k === 'priority') void bulk({ priority: v as TicketPatch['priority'] });
              else if (k === 'sprint') void bulk({ sprintId: v || null });
              else if (k === 'epic') void bulk({ parentId: v || null });
              else if (k === 'labels') {
                // Adds the label to each selected ticket.
                const ids = [...selected];
                void Promise.all(
                  ids.map((tid) => {
                    const x = data.byId.get(tid);
                    return x && !x.labelIds.includes(v)
                      ? data.update(tid, { labelIds: [...x.labelIds, v] })
                      : null;
                  }),
                ).then(() => setSelected(new Set()));
              } else void bulk({ storyPoints: Number(v) });
            }}
            onClose={() => setBulkPick(null)}
          />
        )}

        {openId && (
          <>
            <div className="tk-panel-scrim" onClick={() => openTicket(null)} />
            <TicketDetail
              ticketId={openId}
              mode="panel"
              allTickets={data.tickets}
              onClose={() => openTicket(null)}
              onOpen={(x) => openTicket(x)}
              onChanged={(x) => data.upsert(x)}
              onDeleted={(ids) => data.drop(ids)}
            />
          </>
        )}
      </main>
      {creating && (
        <CreateTicketDialog
          ctx={data}
          defaults={{
            ...(project.usesSprints && view === 'board' && data.activeSprint
              ? { sprintId: data.activeSprint.id }
              : {}),
            ...(filter.epicId ? { parentId: filter.epicId } : {}),
            ...creating,
          }}
          onCreated={(x) => {
            data.upsert(x);
            toast(t('tk.created', { key: x.key }));
          }}
          onClose={() => setCreating(null)}
        />
      )}
      {resolutionFor && (
        <ResolutionDialog
          onCancel={() => setResolutionFor(null)}
          onPick={(r) => {
            void data.update(resolutionFor.id, {
              ...resolutionFor.extra,
              statusId: resolutionFor.statusId,
              resolution: r,
            });
            setResolutionFor(null);
          }}
        />
      )}
      {completing && sprint && (
        <CompleteSprintDialog sprint={sprint} onClose={() => setCompleting(false)} />
      )}
      {savingView && (
        <SaveViewDialog
          onClose={() => setSavingView(false)}
          onSave={async (name, shared) => {
            try {
              await api.saveView(project.workspaceId, {
                name,
                projectId: project.id,
                shared,
                config: { view: view as ViewKind, filter, groupBy, sortBy, swimlane },
              });
              projectsChanged();
              toast(t('tk.view.saved'));
              setSavingView(false);
            } catch (e) {
              toast(errMsg(e));
            }
          }}
        />
      )}
    </ProjectContext.Provider>
  );
}

function SaveViewDialog({
  onClose,
  onSave,
}: {
  onClose(): void;
  onSave(name: string, shared: boolean): void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tkSaveView"
        style={{ width: 'min(24rem,100%)' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave(name.trim(), shared);
        }}
      >
        <div className="mh">
          <h3 id="tkSaveView">{t('tk.view.saveTitle')}</h3>
          <button type="button" className="ico" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="mb tk-form">
          <label>
            {t('tk.view.name')}
            <input
              className="field-in"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            {t('tk.view.shared')}
          </label>
        </div>
        <div className="mf">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={!name.trim()}>
            {t('tk.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

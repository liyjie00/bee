/* New ticket: type, title, description and the main fields; "create another" keeps it open. */
import { useEffect, useMemo, useState } from 'react';
import { BeeMarkdownEditor } from '@bee/editor';
import {
  allowedParentTypes,
  PRIORITIES,
  sprintable,
  TICKET_TYPES,
  type ProjectDTO,
  type SprintDTO,
  type TicketDTO,
  type TicketType,
} from '@bee/shared';
import { tickets as api, type Member, type TicketPatch } from '../api/tickets';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n';
import { errMsg } from '../state/toast';
import {
  PriorityIcon,
  Picker,
  ProjectTile,
  StatusDot,
  TypeIcon,
  UserChip,
  usePicker,
  priorityKey,
  typeKey,
} from './ui';

type Key = 'project' | 'type' | 'status' | 'assignee' | 'priority' | 'parent' | 'sprint' | 'labels';

export interface CreateContext {
  project: ProjectDTO;
  members: Member[];
  sprints: SprintDTO[];
  tickets: TicketDTO[];
}

export function CreateTicketDialog({
  ctx,
  projects,
  onSwitchProject,
  defaults = {},
  documentId,
  onCreated,
  onClose,
}: {
  ctx: CreateContext;
  /** offer a choice of project (e.g. from a document) */
  projects?: ProjectDTO[];
  onSwitchProject?(id: string): void;
  defaults?: TicketPatch;
  documentId?: string;
  onCreated(t: TicketDTO): void;
  onClose(): void;
}) {
  const { t, lang } = useI18n();
  const { project, members, sprints } = ctx;
  const pk = usePicker<Key>();
  const [type, setType] = useState<TicketType>(defaults.type ?? 'task');
  const [title, setTitle] = useState(defaults.title ?? '');
  const [description, setDescription] = useState(defaults.description ?? '');
  const [descKey, setDescKey] = useState(0);
  const [patch, setPatch] = useState<TicketPatch>(() => {
    const { type: _t, title: _ti, description: _d, ...rest } = defaults;
    return rest;
  });
  const [another, setAnother] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status =
    project.statuses.find((s) => s.id === patch.statusId) ??
    project.statuses.find((s) => s.category === 'todo') ??
    project.statuses[0];
  const assignee = members.find((m) => m.id === patch.assigneeId) ?? null;
  const parentTypes = allowedParentTypes(type);
  const parents = useMemo(
    () => (parentTypes ? ctx.tickets.filter((x) => parentTypes.includes(x.type)) : []),
    [ctx.tickets, type],
  );
  const parent = ctx.tickets.find((x) => x.id === patch.parentId) ?? null;
  const openSprints = sprints.filter((s) => s.state !== 'closed');
  const sprint = sprints.find((s) => s.id === patch.sprintId) ?? null;

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !pk.open && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [pk.open]);

  // A parent that no longer fits the type is dropped.
  useEffect(() => {
    if (parent && !(parentTypes ?? []).includes(parent.type))
      setPatch((p) => ({ ...p, parentId: null }));
  }, [type]);

  async function create() {
    if (!title.trim() || busy) return;
    if (type === 'subtask' && !patch.parentId) {
      setError(t('tk.create.needParent'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...patch,
        type,
        title: title.trim(),
        description,
        sprintId: sprintable(type) ? patch.sprintId : undefined,
      };
      const tk = await api.create(project.id, { ...body, documentId });
      onCreated(tk);
      if (another) {
        setTitle('');
        setDescription('');
        setDescKey((k) => k + 1);
      } else onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const pill = (key: Key, content: React.ReactNode, label: string) => (
    <button
      type="button"
      className="tk-pill"
      aria-label={label}
      title={label}
      onClick={(e) => pk.toggle(key, e.currentTarget)}
    >
      {content}
    </button>
  );

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal tk-create"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tkCreateTitle"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void create();
          }
        }}
      >
        <div className="mh">
          <div className="tk-create-where">
            {projects && projects.length > 1 ? (
              pill(
                'project',
                <>
                  <ProjectTile project={project} size={16} />
                  {project.name}
                  <Icon name="down" size={10} />
                </>,
                t('tk.f.project'),
              )
            ) : (
              <span className="tk-pill static">
                <ProjectTile project={project} size={16} />
                {project.name}
              </span>
            )}
            <Icon name="chev" size={11} />
            <h3 id="tkCreateTitle">{t('tk.create.title')}</h3>
          </div>
          <button className="ico" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="mb">
          <div className="tk-create-type">
            {pill(
              'type',
              <>
                <TypeIcon type={type} />
                {t(typeKey(type))}
                <Icon name="down" size={10} />
              </>,
              t('tk.f.type'),
            )}
          </div>
          <input
            className="tk-create-title"
            autoFocus
            value={title}
            placeholder={t('tk.create.titlePh')}
            aria-label={t('tk.f.title')}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
                e.preventDefault();
                void create();
              }
            }}
          />
          <BeeMarkdownEditor
            resetKey={descKey}
            value={description}
            editable
            locale={lang}
            placeholder={t('tk.create.descPh')}
            onChange={setDescription}
            debounceMs={150}
            className="tk-desc-edit"
          />
          <div className="tk-create-fields">
            {pill(
              'status',
              <>
                <StatusDot status={status} />
                {status?.name}
              </>,
              t('tk.f.status'),
            )}
            {pill(
              'assignee',
              <>
                <UserChip user={assignee} />
                {assignee?.name ?? t('tk.unassigned')}
              </>,
              t('tk.f.assignee'),
            )}
            {pill(
              'priority',
              <>
                <PriorityIcon priority={patch.priority ?? 'medium'} />
                {t(priorityKey(patch.priority ?? 'medium'))}
              </>,
              t('tk.f.priority'),
            )}
            {parentTypes &&
              pill(
                'parent',
                <>
                  <TypeIcon type={parent?.type ?? parentTypes[0]!} />
                  {parent
                    ? `${parent.key} ${parent.title}`
                    : type === 'subtask'
                      ? t('tk.f.parent')
                      : t('tk.f.epic')}
                </>,
                t('tk.f.parent'),
              )}
            {project.usesSprints &&
              sprintable(type) &&
              pill(
                'sprint',
                <>
                  <Icon name="clock" size={13} />
                  {sprint?.name ?? t('tk.backlog')}
                </>,
                t('tk.f.sprint'),
              )}
            {project.labels.length > 0 &&
              pill(
                'labels',
                <>
                  <Icon name="note" size={13} />
                  {patch.labelIds?.length
                    ? project.labels
                        .filter((l) => patch.labelIds!.includes(l.id))
                        .map((l) => l.name)
                        .join(', ')
                    : t('tk.f.labels')}
                </>,
                t('tk.f.labels'),
              )}
            <label className="tk-pill">
              <span>{t('tk.f.points')}</span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={patch.storyPoints ?? ''}
                onChange={(e) =>
                  setPatch((p) => ({
                    ...p,
                    storyPoints: e.target.value === '' ? null : Number(e.target.value),
                  }))
                }
                style={{ width: '3rem' }}
              />
            </label>
            <label className="tk-pill">
              <span>{t('tk.f.due')}</span>
              <input
                type="date"
                value={patch.dueDate ?? ''}
                onChange={(e) => setPatch((p) => ({ ...p, dueDate: e.target.value || null }))}
              />
            </label>
          </div>
          {error && <p className="err">{error}</p>}
        </div>
        <div className="mf">
          <label className="tk-another">
            <input
              type="checkbox"
              checked={another}
              onChange={(e) => setAnother(e.target.checked)}
            />
            {t('tk.create.another')}
          </label>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!title.trim() || busy}
            onClick={() => void create()}
          >
            {t('tk.create.submit')}{' '}
            <kbd>{navigator.platform.includes('Mac') ? '⌘↵' : 'Ctrl+↵'}</kbd>
          </button>
        </div>
        {pk.open?.key === 'project' && projects && (
          <Picker
            anchor={pk.open.el}
            options={projects
              .filter((p) => p.canEdit)
              .map((p) => ({
                id: p.id,
                label: p.name,
                hint: p.key,
                icon: <ProjectTile project={p} size={16} />,
              }))}
            value={project.id}
            onPick={(id) => onSwitchProject?.(id)}
            onClose={pk.close}
          />
        )}
        {pk.open?.key === 'type' && (
          <Picker
            anchor={pk.open.el}
            options={TICKET_TYPES.map((ty) => ({
              id: ty,
              label: t(typeKey(ty)),
              icon: <TypeIcon type={ty} />,
            }))}
            value={type}
            onPick={(id) => setType(id as TicketType)}
            onClose={pk.close}
          />
        )}
        {pk.open?.key === 'status' && (
          <Picker
            anchor={pk.open.el}
            options={project.statuses.map((s) => ({
              id: s.id,
              label: s.name,
              icon: <StatusDot status={s} />,
            }))}
            value={status?.id}
            onPick={(id) => setPatch((p) => ({ ...p, statusId: id }))}
            onClose={pk.close}
          />
        )}
        {pk.open?.key === 'assignee' && (
          <Picker
            anchor={pk.open.el}
            search
            options={[
              { id: '', label: t('tk.unassigned'), icon: <UserChip user={null} /> },
              ...members.map((m) => ({ id: m.id, label: m.name, icon: <UserChip user={m} /> })),
            ]}
            value={patch.assigneeId ?? ''}
            onPick={(id) => setPatch((p) => ({ ...p, assigneeId: id || null }))}
            onClose={pk.close}
          />
        )}
        {pk.open?.key === 'priority' && (
          <Picker
            anchor={pk.open.el}
            options={[...PRIORITIES].reverse().map((p) => ({
              id: p,
              label: t(priorityKey(p)),
              icon: <PriorityIcon priority={p} />,
            }))}
            value={patch.priority ?? 'medium'}
            onPick={(id) => setPatch((p) => ({ ...p, priority: id as TicketPatch['priority'] }))}
            onClose={pk.close}
          />
        )}
        {pk.open?.key === 'parent' && (
          <Picker
            anchor={pk.open.el}
            search
            options={[
              { id: '', label: t('tk.none') },
              ...parents.map((x) => ({
                id: x.id,
                label: x.title,
                hint: x.key,
                keywords: x.key,
                icon: <TypeIcon type={x.type} />,
              })),
            ]}
            value={patch.parentId ?? ''}
            onPick={(id) => setPatch((p) => ({ ...p, parentId: id || null }))}
            onClose={pk.close}
          />
        )}
        {pk.open?.key === 'sprint' && (
          <Picker
            anchor={pk.open.el}
            options={[
              { id: '', label: t('tk.backlog') },
              ...openSprints.map((s) => ({
                id: s.id,
                label: s.name,
                hint: s.state === 'active' ? t('tk.sprint.active') : undefined,
              })),
            ]}
            value={patch.sprintId ?? ''}
            onPick={(id) => setPatch((p) => ({ ...p, sprintId: id || null }))}
            onClose={pk.close}
          />
        )}
        {pk.open?.key === 'labels' && (
          <Picker
            anchor={pk.open.el}
            multi
            options={project.labels.map((l) => ({
              id: l.id,
              label: l.name,
              icon: <span className="tk-swatch" style={{ background: l.color }} />,
            }))}
            value={patch.labelIds ?? []}
            onPick={(id) =>
              setPatch((p) => {
                const cur = p.labelIds ?? [];
                return {
                  ...p,
                  labelIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
                };
              })
            }
            onClose={pk.close}
          />
        )}
      </div>
    </div>
  );
}

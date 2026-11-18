/* Filter chips above the board, list, backlog and timeline. */
import type { ReactNode } from 'react';
import { PRIORITIES, TICKET_TYPES, type TicketFilter } from '@bee/shared';
import { Icon } from '../components/Icon';
import { useT } from '../i18n';
import {
  PriorityIcon,
  StatusDot,
  TypeIcon,
  UserChip,
  Picker,
  usePicker,
  priorityKey,
  typeKey,
  type PickOption,
} from './ui';
import type { ProjectData } from './useProject';

type Key = 'type' | 'assignee' | 'priority' | 'label' | 'epic' | 'status' | 'due' | 'more';

const toggle = <T,>(arr: T[] | undefined, v: T): T[] | undefined => {
  const a = arr ?? [];
  const n = a.includes(v) ? a.filter((x) => x !== v) : [...a, v];
  return n.length ? n : undefined;
};

export function FilterBar({
  data,
  filter,
  setFilter,
  right,
  hideStatus,
}: {
  data: ProjectData;
  filter: TicketFilter;
  setFilter(f: TicketFilter): void;
  right?: ReactNode;
  hideStatus?: boolean;
}) {
  const t = useT();
  const pk = usePicker<Key>();
  const set = (patch: Partial<TicketFilter>) => {
    const n: TicketFilter = { ...filter, ...patch };
    for (const k of Object.keys(n) as (keyof TicketFilter)[])
      if (n[k] === undefined || n[k] === '') delete n[k];
    setFilter(n);
  };
  const { project, members, epics } = data;

  const chip = (key: Key, label: string, count: number, onClear: () => void) => (
    <span className={'tk-chip' + (count ? ' on' : '')}>
      <button onClick={(e) => pk.toggle(key, e.currentTarget)} aria-haspopup="listbox">
        {count ? `${label} · ${count}` : label}
        <Icon name="down" size={10} />
      </button>
      {!!count && (
        <button
          className="x"
          aria-label={t('tk.filter.clearOne', { name: label })}
          onClick={onClear}
        >
          <Icon name="x" size={10} />
        </button>
      )}
    </span>
  );

  const opts: Partial<
    Record<Key, { options: PickOption[]; value: string[] | undefined; pick(id: string): void }>
  > = {
    type: {
      options: TICKET_TYPES.map((ty) => ({
        id: ty,
        label: t(typeKey(ty)),
        icon: <TypeIcon type={ty} />,
      })),
      value: filter.types,
      pick: (id) => set({ types: toggle(filter.types, id as (typeof TICKET_TYPES)[number]) }),
    },
    assignee: {
      options: [
        { id: 'me', label: t('tk.filter.me'), icon: <Icon name="user" size={14} /> },
        { id: 'none', label: t('tk.unassigned'), icon: <UserChip user={null} /> },
        ...members.map((m) => ({ id: m.id, label: m.name, icon: <UserChip user={m} /> })),
      ],
      value: filter.assignees,
      pick: (id) => set({ assignees: toggle(filter.assignees, id) }),
    },
    priority: {
      options: [...PRIORITIES]
        .reverse()
        .map((p) => ({ id: p, label: t(priorityKey(p)), icon: <PriorityIcon priority={p} /> })),
      value: filter.priorities,
      pick: (id) =>
        set({ priorities: toggle(filter.priorities, id as (typeof PRIORITIES)[number]) }),
    },
    label: {
      options: project.labels.map((l) => ({
        id: l.id,
        label: l.name,
        icon: <span className="tk-swatch" style={{ background: l.color }} />,
      })),
      value: filter.labelIds,
      pick: (id) => set({ labelIds: toggle(filter.labelIds, id) }),
    },
    status: {
      options: project.statuses.map((s) => ({
        id: s.id,
        label: s.name,
        icon: <StatusDot status={s} />,
      })),
      value: filter.statusIds,
      pick: (id) => set({ statusIds: toggle(filter.statusIds, id) }),
    },
  };

  const epicOpts: PickOption[] = epics.map((e) => ({
    id: e.id,
    label: e.title,
    hint: e.key,
    icon: <TypeIcon type="epic" />,
    keywords: e.key,
  }));
  const dueOpts: PickOption[] = [
    { id: 'overdue', label: t('tk.due.overdue') },
    { id: 'week', label: t('tk.due.week') },
    { id: 'none', label: t('tk.due.none') },
  ];
  const active = Object.keys(filter).length > 0;
  const cur = pk.open ? opts[pk.open.key] : undefined;

  return (
    <div className="tk-filters">
      <label className="tk-q">
        <Icon name="search" size={14} />
        <input
          value={filter.q ?? ''}
          placeholder={t('tk.filter.search')}
          aria-label={t('tk.filter.search')}
          onChange={(e) => set({ q: e.target.value || undefined })}
        />
      </label>
      {chip('type', t('tk.f.type'), filter.types?.length ?? 0, () => set({ types: undefined }))}
      {chip('assignee', t('tk.f.assignee'), filter.assignees?.length ?? 0, () =>
        set({ assignees: undefined }),
      )}
      {epics.length > 0 &&
        chip('epic', t('tk.f.epic'), filter.epicId ? 1 : 0, () => set({ epicId: undefined }))}
      {!hideStatus &&
        chip('status', t('tk.f.status'), filter.statusIds?.length ?? 0, () =>
          set({ statusIds: undefined }),
        )}
      {chip('priority', t('tk.f.priority'), filter.priorities?.length ?? 0, () =>
        set({ priorities: undefined }),
      )}
      {project.labels.length > 0 &&
        chip('label', t('tk.f.labels'), filter.labelIds?.length ?? 0, () =>
          set({ labelIds: undefined }),
        )}
      {chip('due', t('tk.f.due'), filter.due ? 1 : 0, () => set({ due: undefined }))}
      {active && (
        <button className="tk-clear" onClick={() => setFilter({})}>
          {t('tk.filter.clear')}
        </button>
      )}
      <div className="spacer" />
      {right}
      {pk.open && cur && (
        <Picker
          anchor={pk.open.el}
          options={cur.options}
          value={cur.value ?? []}
          multi
          onPick={cur.pick}
          onClose={pk.close}
          search={cur.options.length > 8}
        />
      )}
      {pk.open?.key === 'epic' && (
        <Picker
          anchor={pk.open.el}
          options={epicOpts}
          value={filter.epicId ?? null}
          onPick={(id) => set({ epicId: filter.epicId === id ? undefined : id })}
          onClose={pk.close}
        />
      )}
      {pk.open?.key === 'due' && (
        <Picker
          anchor={pk.open.el}
          options={dueOpts}
          value={filter.due ?? null}
          onPick={(id) => set({ due: filter.due === id ? undefined : (id as TicketFilter['due']) })}
          onClose={pk.close}
        />
      )}
    </div>
  );
}

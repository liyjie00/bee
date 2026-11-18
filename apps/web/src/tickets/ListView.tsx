/* Table of tickets, grouped by any field and sorted, with inline status changes and quick add. */
import { useMemo, useState, type ReactNode } from 'react';
import {
  compareTickets,
  PRIORITIES,
  TICKET_TYPES,
  type GroupBy,
  type SortBy,
  type TicketDTO,
} from '@bee/shared';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n';
import { useProjectCtx } from './context';
import {
  fmtDate,
  Picker,
  PriorityIcon,
  StatusDot,
  TypeIcon,
  UserChip,
  priorityKey,
  today,
  typeKey,
} from './ui';

interface Group {
  id: string;
  label: ReactNode;
  tickets: TicketDTO[];
}

export function ListView({
  tickets,
  groupBy,
  sortBy,
}: {
  tickets: TicketDTO[];
  groupBy: GroupBy;
  sortBy: SortBy;
}) {
  const { t, lang } = useI18n();
  const ctx = useProjectCtx();
  const { project, members, sprints, selected, setSelected } = ctx;
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [statusPick, setStatusPick] = useState<{ id: string; el: HTMLElement } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const groups = useMemo<Group[]>(() => {
    const sorted = [...tickets].sort(compareTickets(sortBy));
    const by = (key: (x: TicketDTO) => string, order: { id: string; label: ReactNode }[]) =>
      order
        .map((o) => ({ ...o, tickets: sorted.filter((x) => key(x) === o.id) }))
        .filter((g) => g.tickets.length > 0);
    switch (groupBy) {
      case 'status':
        return project.statuses
          .map((s) => ({
            id: s.id,
            label: (
              <>
                <StatusDot status={s} />
                {s.name}
              </>
            ),
            tickets: sorted.filter((x) => x.statusId === s.id),
          }))
          .filter((g) => g.tickets.length > 0 || ctx.status(g.id)?.category !== 'done');
      case 'assignee':
        return by(
          (x) => x.assignee?.id ?? '',
          [
            ...members.map((m) => ({
              id: m.id,
              label: (
                <>
                  <UserChip user={m} />
                  {m.name}
                </>
              ),
            })),
            { id: '', label: t('tk.unassigned') },
          ],
        );
      case 'priority':
        return by(
          (x) => x.priority,
          [...PRIORITIES].reverse().map((p) => ({
            id: p,
            label: (
              <>
                <PriorityIcon priority={p} />
                {t(priorityKey(p))}
              </>
            ),
          })),
        );
      case 'type':
        return by(
          (x) => x.type,
          TICKET_TYPES.map((ty) => ({
            id: ty,
            label: (
              <>
                <TypeIcon type={ty} />
                {t(typeKey(ty))}
              </>
            ),
          })),
        );
      case 'sprint':
        return by(
          (x) => x.sprintId ?? '',
          [
            ...sprints
              .filter((s) => s.state !== 'closed')
              .map((s) => ({ id: s.id, label: s.name })),
            ...sprints
              .filter((s) => s.state === 'closed')
              .map((s) => ({ id: s.id, label: s.name })),
            { id: '', label: t('tk.backlog') },
          ],
        );
      case 'epic': {
        const epicOf = (x: TicketDTO) => {
          let p = x.parentId;
          for (let i = 0; p && i < 3; i++) {
            const y = ctx.byId.get(p);
            if (!y) break;
            if (y.type === 'epic') return y.id;
            p = y.parentId;
          }
          return '';
        };
        return by(epicOf, [
          ...ctx.epics.map((e) => ({
            id: e.id,
            label: (
              <>
                <TypeIcon type="epic" />
                {e.title}
              </>
            ),
          })),
          { id: '', label: t('tk.lane.noEpic') },
        ]);
      }
      default:
        return [{ id: 'all', label: '', tickets: sorted }];
    }
  }, [tickets, groupBy, sortBy, project, members, sprints, t]);

  const allIds = tickets.map((x) => x.id);
  const allOn = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const toggle = (id: string) => {
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelected(n);
  };

  const quickAdd = async (g: Group) => {
    const title = draft.trim();
    if (!title) return;
    const defaults: Record<string, unknown> = {};
    if (groupBy === 'status') defaults.statusId = g.id;
    if (groupBy === 'assignee') defaults.assigneeId = g.id || null;
    if (groupBy === 'priority') defaults.priority = g.id;
    if (groupBy === 'type') defaults.type = g.id;
    if (groupBy === 'sprint') defaults.sprintId = g.id || null;
    if (groupBy === 'epic' && g.id) defaults.parentId = g.id;
    await ctx.createQuick({ title, type: 'task', ...defaults });
    setDraft('');
  };

  if (!tickets.length)
    return (
      <div className="empty">
        <h2>{t('tk.list.empty')}</h2>
        {project.canEdit && (
          <button className="btn primary" onClick={() => ctx.newTicket()}>
            <Icon name="plus" />
            {t('tk.new')}
          </button>
        )}
      </div>
    );

  return (
    <div className="tk-list-wrap">
      <table className="tk-list">
        <thead>
          <tr>
            <th className="cb">
              <input
                type="checkbox"
                aria-label={t('tk.selectAll')}
                checked={allOn}
                onChange={() => setSelected(allOn ? new Set() : new Set(allIds))}
              />
            </th>
            <th className="key">{t('tk.col.key')}</th>
            <th>{t('tk.col.title')}</th>
            <th className="st">{t('tk.f.status')}</th>
            <th className="pr">{t('tk.f.priority')}</th>
            <th className="lb hide-phone">{t('tk.f.labels')}</th>
            <th className="pt hide-phone">{t('tk.col.points')}</th>
            <th className="du hide-phone">{t('tk.col.due')}</th>
            <th className="as">{t('tk.f.assignee')}</th>
          </tr>
        </thead>
        {groups.map((g) => {
          const isFolded = folded.has(g.id);
          const pts = g.tickets.reduce((x, c) => x + (c.storyPoints ?? 0), 0);
          return (
            <tbody key={g.id}>
              {groupBy !== 'none' && (
                <tr className="tk-gh">
                  <td colSpan={9}>
                    <button
                      aria-expanded={!isFolded}
                      onClick={() =>
                        setFolded((f) => {
                          const n = new Set(f);
                          if (n.has(g.id)) n.delete(g.id);
                          else n.add(g.id);
                          return n;
                        })
                      }
                    >
                      <Icon name={isFolded ? 'chev' : 'down'} size={11} />
                      {g.label}
                      <span className="muted">{g.tickets.length}</span>
                      {pts > 0 && <span className="tk-pts">{pts}</span>}
                    </button>
                  </td>
                </tr>
              )}
              {!isFolded &&
                g.tickets.map((x) => {
                  const s = ctx.status(x.statusId);
                  const done = s?.category === 'done';
                  const overdue = !done && !!x.dueDate && x.dueDate < today();
                  return (
                    <tr
                      key={x.id}
                      className={selected.has(x.id) ? 'sel' : ''}
                      onClick={() => ctx.openTicket(x.id)}
                    >
                      <td className="cb" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={t('tk.select', { key: x.key })}
                          checked={selected.has(x.id)}
                          onChange={() => toggle(x.id)}
                        />
                      </td>
                      <td className="key">
                        <span className="tk-keycell">
                          <TypeIcon type={x.type} />
                          <span className="tk-key">{x.key}</span>
                        </span>
                      </td>
                      <td className={'ttl' + (done ? ' done' : '')}>
                        {x.title}
                        {x.childCount > 0 && (
                          <span className="muted sm">
                            {' '}
                            · {x.childDoneCount}/{x.childCount}
                          </span>
                        )}
                        {x.blockedBy.length > 0 && (
                          <span className="tk-blocked sm">{t('tk.blocked')}</span>
                        )}
                      </td>
                      <td className="st" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="tk-stbtn"
                          disabled={!project.canEdit}
                          onClick={(e) => setStatusPick({ id: x.id, el: e.currentTarget })}
                        >
                          <StatusDot status={s} />
                          {s?.name}
                        </button>
                      </td>
                      <td className="pr">
                        <PriorityIcon priority={x.priority} />
                      </td>
                      <td className="lb hide-phone">
                        {project.labels
                          .filter((l) => x.labelIds.includes(l.id))
                          .map((l) => (
                            <span
                              key={l.id}
                              className="tk-label"
                              style={{ background: l.color + '22', color: l.color }}
                            >
                              {l.name}
                            </span>
                          ))}
                      </td>
                      <td className="pt hide-phone">
                        {x.storyPoints != null && <span className="tk-pts">{x.storyPoints}</span>}
                      </td>
                      <td className={'du hide-phone' + (overdue ? ' tk-overdue' : '')}>
                        {fmtDate(x.dueDate, lang)}
                      </td>
                      <td className="as">
                        <UserChip user={x.assignee} />
                      </td>
                    </tr>
                  );
                })}
              {!isFolded && project.canEdit && groupBy !== 'none' && (
                <tr className="tk-addrow">
                  <td />
                  <td colSpan={8}>
                    {adding === g.id ? (
                      <input
                        autoFocus
                        value={draft}
                        placeholder={t('tk.quickAddPh')}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void quickAdd(g);
                          if (e.key === 'Escape') setAdding(null);
                        }}
                        onBlur={() => !draft && setAdding(null)}
                      />
                    ) : (
                      <button onClick={() => (setAdding(g.id), setDraft(''))}>
                        <Icon name="plus" size={12} />
                        {t('tk.quickAdd')}
                      </button>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          );
        })}
      </table>
      {statusPick && (
        <Picker
          anchor={statusPick.el}
          options={project.statuses.map((s) => ({
            id: s.id,
            label: s.name,
            icon: <StatusDot status={s} />,
          }))}
          value={ctx.byId.get(statusPick.id)?.statusId}
          onPick={(id) => ctx.move(statusPick.id, id)}
          onClose={() => setStatusPick(null)}
        />
      )}
    </div>
  );
}

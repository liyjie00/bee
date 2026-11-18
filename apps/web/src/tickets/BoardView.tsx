/* Kanban board: one column per status, optional swimlanes, drag cards to change status/order. */
import { useMemo, useState, type DragEvent } from 'react';
import {
  PRIORITIES,
  priorityRank,
  rankBetween,
  type Priority,
  type StatusDTO,
  type Swimlane,
  type TicketDTO,
} from '@bee/shared';
import type { TicketPatch } from '../api/tickets';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n';
import { useProjectCtx } from './context';
import { fmtDate, PriorityIcon, StatusDot, TypeIcon, UserChip, priorityKey, today } from './ui';

interface Lane {
  id: string;
  label: string;
  icon?: React.ReactNode;
  patch: (t: TicketDTO) => TicketPatch | null;
  match: (t: TicketDTO) => boolean;
}

const DONE_SHOWN = 20;

export function TicketCard({
  t: tk,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  t: TicketDTO;
  dragging?: boolean;
  onDragStart?(e: DragEvent): void;
  onDragEnd?(): void;
}) {
  const { t, lang } = useI18n();
  const ctx = useProjectCtx();
  const labels = ctx.project.labels.filter((l) => tk.labelIds.includes(l.id));
  const parent = tk.parentId ? ctx.byId.get(tk.parentId) : undefined;
  const done = ctx.status(tk.statusId)?.category === 'done';
  const overdue = !done && !!tk.dueDate && tk.dueDate < today();
  return (
    <button
      className={
        'tk-card' +
        (dragging ? ' dragging' : '') +
        (done ? ' done' : '') +
        (ctx.selected.has(tk.id) ? ' sel' : '')
      }
      draggable={ctx.project.canEdit}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          const n = new Set(ctx.selected);
          if (n.has(tk.id)) n.delete(tk.id);
          else n.add(tk.id);
          ctx.setSelected(n);
        } else ctx.openTicket(tk.id);
      }}
    >
      <span className="r">
        <TypeIcon type={tk.type} />
        <span className="tk-key">{tk.key}</span>
        {parent && tk.type === 'subtask' && <span className="muted up">↑ {parent.key}</span>}
        <span className="spacer" />
        <PriorityIcon priority={tk.priority} />
      </span>
      <span className="ttl">{tk.title}</span>
      {labels.length > 0 && (
        <span className="r wrap">
          {labels.map((l) => (
            <span
              key={l.id}
              className="tk-label"
              style={{ background: l.color + '22', color: l.color }}
            >
              {l.name}
            </span>
          ))}
        </span>
      )}
      {tk.childCount > 0 && (
        <span className="r muted sm">
          <span className="tk-progress">
            <i style={{ width: `${(tk.childDoneCount / tk.childCount) * 100}%` }} />
          </span>
          {t('tk.card.children', { done: tk.childDoneCount, total: tk.childCount })}
        </span>
      )}
      <span className="r sm">
        {tk.blockedBy.length > 0 && (
          <span className="tk-blocked" title={t('tk.blockedBy', { keys: tk.blockedBy.join(', ') })}>
            {t('tk.blockedBy', { keys: tk.blockedBy[0]! })}
          </span>
        )}
        {tk.dueDate && (
          <span className={overdue ? 'tk-overdue' : 'muted'}>
            {overdue
              ? t('tk.overdue', { date: fmtDate(tk.dueDate, lang) })
              : fmtDate(tk.dueDate, lang)}
          </span>
        )}
        {tk.commentCount > 0 && (
          <span className="muted ic">
            <Icon name="chat" size={11} />
            {tk.commentCount}
          </span>
        )}
        <span className="spacer" />
        {tk.storyPoints != null && <span className="tk-pts">{tk.storyPoints}</span>}
        <UserChip user={tk.assignee} />
      </span>
    </button>
  );
}

export function BoardView({ tickets, swimlane }: { tickets: TicketDTO[]; swimlane: Swimlane }) {
  const { t } = useI18n();
  const ctx = useProjectCtx();
  const { project, members } = ctx;
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [showAllDone, setShowAllDone] = useState(false);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const cards = tickets.filter((x) => x.type !== 'epic');

  const lanes = useMemo<Lane[]>(() => {
    if (swimlane === 'epic') {
      const ids = new Set(cards.map((c) => epicOf(c)));
      const list: Lane[] = ctx.epics
        .filter((e) => ids.has(e.id))
        .map((e) => ({
          id: e.id,
          label: `${e.key} ${e.title}`,
          icon: <TypeIcon type="epic" />,
          match: (c) => epicOf(c) === e.id,
          patch: (c) => (c.type === 'subtask' ? null : { parentId: e.id }),
        }));
      list.push({
        id: 'none',
        label: t('tk.lane.noEpic'),
        match: (c) => !epicOf(c),
        patch: (c) => (c.type === 'subtask' ? null : { parentId: null }),
      });
      return list;
    }
    if (swimlane === 'assignee') {
      const ids = new Set(cards.map((c) => c.assignee?.id ?? ''));
      const list: Lane[] = members
        .filter((m) => ids.has(m.id))
        .map((m) => ({
          id: m.id,
          label: m.name,
          icon: <UserChip user={m} />,
          match: (c) => c.assignee?.id === m.id,
          patch: () => ({ assigneeId: m.id }),
        }));
      list.push({
        id: 'none',
        label: t('tk.unassigned'),
        match: (c) => !c.assignee,
        patch: () => ({ assigneeId: null }),
      });
      return list;
    }
    if (swimlane === 'priority') {
      return [...PRIORITIES].reverse().map((p: Priority) => ({
        id: p,
        label: t(priorityKey(p)),
        icon: <PriorityIcon priority={p} />,
        match: (c) => c.priority === p,
        patch: () => ({ priority: p }),
      }));
    }
    return [{ id: 'all', label: '', match: () => true, patch: () => ({}) }];

    function epicOf(c: TicketDTO): string | null {
      let p = c.parentId;
      for (let i = 0; p && i < 3; i++) {
        const x = ctx.byId.get(p);
        if (!x) return null;
        if (x.type === 'epic') return x.id;
        p = x.parentId;
      }
      return null;
    }
  }, [swimlane, cards, ctx.epics, members, t]);

  const colTickets = (s: StatusDTO, lane: Lane) => {
    const list = cards
      .filter((c) => c.statusId === s.id && lane.match(c))
      .sort((a, b) => a.rank - b.rank);
    if (s.category === 'done' && !showAllDone) {
      return list.sort((a, b) => ((b.completedAt ?? '') > (a.completedAt ?? '') ? 1 : -1));
    }
    return list;
  };

  const drop = (e: DragEvent, s: StatusDTO, lane: Lane, list: TicketDTO[]) => {
    e.preventDefault();
    setOver(null);
    const id = drag ?? e.dataTransfer.getData('text/bee-ticket');
    setDrag(null);
    const tk = id ? ctx.byId.get(id) : undefined;
    if (!tk) return;
    // Drop position: before the first card whose middle is below the pointer.
    const cell = e.currentTarget as HTMLElement;
    const els = [...cell.querySelectorAll<HTMLElement>('.tk-card')];
    let idx = els.findIndex(
      (el) => e.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2,
    );
    if (idx < 0) idx = els.length;
    const others = list.filter((x) => x.id !== tk.id);
    const before = others[idx - 1]?.rank;
    const after = others[idx]?.rank;
    const rank = rankBetween(before, after);
    const lanePatch = lane.patch(tk) ?? {};
    const patch: TicketPatch = { rank, ...lanePatch };
    if (s.id !== tk.statusId) ctx.move(tk.id, s.id, patch);
    else void ctx.update(tk.id, patch);
  };

  if (!cards.length && project.usesSprints && !ctx.activeSprint)
    return (
      <div className="empty">
        <h2>{t('tk.board.noSprint')}</h2>
        <p style={{ margin: 0 }}>{t('tk.board.noSprintHint')}</p>
      </div>
    );

  return (
    <div className="tk-board" style={{ ['--cols' as string]: project.statuses.length }}>
      <div className="tk-cols head">
        {project.statuses.map((s) => {
          const n = cards.filter((c) => c.statusId === s.id).length;
          const pts = cards
            .filter((c) => c.statusId === s.id)
            .reduce((x, c) => x + (c.storyPoints ?? 0), 0);
          const overLimit = s.wipLimit != null && n > s.wipLimit;
          return (
            <div key={s.id} className={'tk-colh' + (overLimit ? ' over' : '')}>
              <StatusDot status={s} />
              <b>{s.name}</b>
              <span className="muted">{s.wipLimit != null ? `${n} / ${s.wipLimit}` : n}</span>
              <span className="spacer" />
              {pts > 0 && <span className="tk-pts">{pts}</span>}
              {project.canEdit && (
                <button
                  className="ico sm"
                  aria-label={t('tk.newIn', { status: s.name })}
                  onClick={() => ctx.newTicket({ statusId: s.id, sprintId: ctx.activeSprint?.id })}
                >
                  <Icon name="plus" size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {lanes.map((lane) => {
        const inLane = cards.filter(lane.match);
        if (swimlane !== 'none' && !inLane.length && lane.id !== 'none') return null;
        const isFolded = folded.has(lane.id);
        return (
          <div key={lane.id} className="tk-lane">
            {swimlane !== 'none' && (
              <button
                className="tk-laneh"
                aria-expanded={!isFolded}
                onClick={() =>
                  setFolded((f) => {
                    const n = new Set(f);
                    if (n.has(lane.id)) n.delete(lane.id);
                    else n.add(lane.id);
                    return n;
                  })
                }
              >
                <Icon name={isFolded ? 'chev' : 'down'} size={11} />
                {lane.icon}
                <b>{lane.label}</b>
                <span className="muted">{t('tk.lane.count', { n: inLane.length })}</span>
              </button>
            )}
            {!isFolded && (
              <div className="tk-cols">
                {project.statuses.map((s) => {
                  const list = colTickets(s, lane);
                  const cut = s.category === 'done' && !showAllDone && list.length > DONE_SHOWN;
                  const cellKey = `${lane.id}:${s.id}`;
                  return (
                    <div
                      key={s.id}
                      className={'tk-cell' + (over === cellKey ? ' over' : '')}
                      onDragOver={(e) => {
                        if (!drag) return;
                        e.preventDefault();
                        if (over !== cellKey) setOver(cellKey);
                      }}
                      onDragLeave={(e) => {
                        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node))
                          setOver(null);
                      }}
                      onDrop={(e) => drop(e, s, lane, list)}
                    >
                      {(cut ? list.slice(0, DONE_SHOWN) : list).map((c) => (
                        <TicketCard
                          key={c.id}
                          t={c}
                          dragging={drag === c.id}
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/bee-ticket', c.id);
                            e.dataTransfer.effectAllowed = 'move';
                            setDrag(c.id);
                          }}
                          onDragEnd={() => {
                            setDrag(null);
                            setOver(null);
                          }}
                        />
                      ))}
                      {cut && (
                        <button className="tk-more" onClick={() => setShowAllDone(true)}>
                          {t('tk.showAll', { n: list.length })}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const sortByPriority = (a: TicketDTO, b: TicketDTO) =>
  priorityRank(b.priority) - priorityRank(a.priority);

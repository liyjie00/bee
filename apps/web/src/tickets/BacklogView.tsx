/* Backlog and sprint planning: drag tickets between sprints, start and complete sprints. */
import { useMemo, useState, type DragEvent } from 'react';
import { rankBetween, type SprintDTO, type TicketDTO } from '@bee/shared';
import { tickets as api } from '../api/tickets';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n';
import { errMsg, useToast } from '../state/toast';
import { useProjectCtx } from './context';
import { fmtDate, StatusDot, TypeIcon, UserChip, today } from './ui';
import { CompleteSprintDialog, SprintDialog } from './SprintDialogs';

export function BacklogView({ tickets }: { tickets: TicketDTO[] }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const ctx = useProjectCtx();
  const { project, sprints, selected, setSelected } = ctx;
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ sprint: SprintDTO | null; start?: boolean } | null>(
    null,
  );
  const [completing, setCompleting] = useState<SprintDTO | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const items = tickets.filter((x) => x.type !== 'epic' && x.type !== 'subtask');
  const open = sprints
    .filter((s) => s.state !== 'closed')
    .sort((a, b) => (a.state === 'active' ? -1 : b.state === 'active' ? 1 : 0));
  const sections: { id: string; sprint: SprintDTO | null; tickets: TicketDTO[] }[] = [
    ...open.map((s) => ({
      id: s.id,
      sprint: s,
      tickets: items.filter((x) => x.sprintId === s.id),
    })),
    { id: 'backlog', sprint: null, tickets: items.filter((x) => !x.sprintId) },
  ];
  const epicName = useMemo(() => {
    const m = new Map<string, TicketDTO>();
    for (const e of ctx.epics) m.set(e.id, e);
    return m;
  }, [ctx.epics]);

  const drop = (e: DragEvent, sectionId: string, list: TicketDTO[]) => {
    e.preventDefault();
    setOver(null);
    const id = drag;
    setDrag(null);
    const tk = id ? ctx.byId.get(id) : undefined;
    if (!tk) return;
    const rows = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.tk-brow')];
    let idx = rows.findIndex(
      (el) => e.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2,
    );
    if (idx < 0) idx = rows.length;
    const others = list.filter((x) => x.id !== tk.id);
    const rank = rankBetween(others[idx - 1]?.rank, others[idx]?.rank);
    const sprintId = sectionId === 'backlog' ? null : sectionId;
    // Dragging one of several selected tickets moves them all.
    if (selected.has(tk.id) && selected.size > 1 && sprintId !== tk.sprintId) {
      void api.bulk([...selected], { sprintId }).then(
        (r) => {
          ctx.upsert(r.updated);
          setSelected(new Set());
        },
        (er) => toast(errMsg(er)),
      );
      return;
    }
    void ctx.update(tk.id, { rank, ...(sprintId !== tk.sprintId ? { sprintId } : {}) });
  };

  const quickAdd = async (sectionId: string) => {
    const title = draft.trim();
    if (!title) return;
    await ctx.createQuick({
      title,
      type: 'story',
      sprintId: sectionId === 'backlog' ? null : sectionId,
    });
    setDraft('');
  };

  const toggleSel = (id: string) => {
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelected(n);
  };

  return (
    <div className="tk-backlog">
      <div className="tk-bl-head">
        <span className="muted">{t('tk.backlog.hint')}</span>
        <div className="spacer" />
        {project.canEdit && (
          <button
            className="btn"
            onClick={() =>
              void api.createSprint(project.id).then(
                () => ctx.reloadProject(),
                (e) => toast(errMsg(e)),
              )
            }
          >
            <Icon name="plus" />
            {t('tk.sprint.create')}
          </button>
        )}
      </div>
      {sections.map((sec) => {
        const s = sec.sprint;
        const pts = sec.tickets.reduce((x, c) => x + (c.storyPoints ?? 0), 0);
        const by = (cat: string) =>
          sec.tickets
            .filter((x) => ctx.status(x.statusId)?.category === cat)
            .reduce((n, c) => n + (c.storyPoints ?? 0), 0);
        const isFolded = folded.has(sec.id);
        const list = [...sec.tickets].sort((a, b) => a.rank - b.rank);
        return (
          <section
            key={sec.id}
            className={
              'tk-bl-sec' +
              (over === sec.id ? ' over' : '') +
              (s?.state === 'active' ? ' active' : '')
            }
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              if (over !== sec.id) setOver(sec.id);
            }}
            onDragLeave={(e) => {
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node))
                setOver(null);
            }}
            onDrop={(e) => drop(e, sec.id, list)}
          >
            <header className="tk-bl-sh">
              <button
                className="fold"
                aria-expanded={!isFolded}
                onClick={() =>
                  setFolded((f) => {
                    const n = new Set(f);
                    if (n.has(sec.id)) n.delete(sec.id);
                    else n.add(sec.id);
                    return n;
                  })
                }
              >
                <Icon name={isFolded ? 'chev' : 'down'} size={11} />
                <b>{s ? s.name : t('tk.backlog')}</b>
              </button>
              {s?.state === 'active' && <span className="tk-badge">{t('tk.sprint.active')}</span>}
              <span className="muted">
                {s && (s.startDate || s.endDate)
                  ? `${fmtDate(s.startDate, lang)} – ${fmtDate(s.endDate, lang)} · `
                  : ''}
                {t('tk.n.tickets', { n: sec.tickets.length })}
                {s?.goal ? ` · ${s.goal}` : ''}
              </span>
              <div className="spacer" />
              {s ? (
                <span className="tk-bl-pts">
                  <span className="tk-pts">{t('tk.pts.todo', { n: by('todo') })}</span>
                  <span className="tk-pts doing">{t('tk.pts.doing', { n: by('doing') })}</span>
                  <span className="tk-pts done">{t('tk.pts.done', { n: by('done') })}</span>
                  {s.capacity != null && (
                    <span className={'muted cap' + (pts > s.capacity ? ' over' : '')}>
                      {t('tk.sprint.capacity', { n: pts, cap: s.capacity })}
                    </span>
                  )}
                </span>
              ) : (
                <span className="muted">{t('tk.n.points', { n: pts })}</span>
              )}
              {s && project.canEdit && (
                <>
                  {s.state === 'planned' && (
                    <button
                      className="btn sm primary"
                      disabled={!!ctx.activeSprint}
                      title={ctx.activeSprint ? t('tk.sprint.oneActive') : undefined}
                      onClick={() => setEditing({ sprint: s, start: true })}
                    >
                      {t('tk.sprint.start')}
                    </button>
                  )}
                  {s.state === 'active' && (
                    <button className="btn sm" onClick={() => setCompleting(s)}>
                      {t('tk.sprint.complete')}
                    </button>
                  )}
                  <button
                    className="ico sm"
                    aria-label={t('tk.sprint.edit')}
                    title={t('tk.sprint.edit')}
                    onClick={() => setEditing({ sprint: s })}
                  >
                    <Icon name="pen" size={12} />
                  </button>
                  {s.state === 'planned' && (
                    <button
                      className="ico sm"
                      aria-label={t('tk.sprint.delete')}
                      title={t('tk.sprint.delete')}
                      onClick={() => {
                        if (!confirm(t('tk.sprint.deleteConfirm', { name: s.name }))) return;
                        void api.deleteSprint(s.id).then(
                          async () => {
                            await Promise.all([ctx.reloadProject(), ctx.reload()]);
                          },
                          (e) => toast(errMsg(e)),
                        );
                      }}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  )}
                </>
              )}
            </header>
            {!isFolded && (
              <div className="tk-bl-rows">
                {list.map((x) => {
                  const st = ctx.status(x.statusId);
                  const epic = (() => {
                    const p = x.parentId ? ctx.byId.get(x.parentId) : undefined;
                    return p?.type === 'epic' ? epicName.get(p.id) : undefined;
                  })();
                  const overdue = st?.category !== 'done' && !!x.dueDate && x.dueDate < today();
                  return (
                    <div
                      key={x.id}
                      className={
                        'tk-brow' +
                        (selected.has(x.id) ? ' sel' : '') +
                        (drag === x.id ? ' dragging' : '')
                      }
                      draggable={project.canEdit}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/bee-ticket', x.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDrag(x.id);
                      }}
                      onDragEnd={() => {
                        setDrag(null);
                        setOver(null);
                      }}
                      onClick={() => ctx.openTicket(x.id)}
                    >
                      <input
                        type="checkbox"
                        aria-label={t('tk.select', { key: x.key })}
                        checked={selected.has(x.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSel(x.id)}
                      />
                      <TypeIcon type={x.type} />
                      <span className="tk-key">{x.key}</span>
                      <span className={'nm' + (st?.category === 'done' ? ' done' : '')}>
                        {x.title}
                      </span>
                      {x.childCount > 0 && (
                        <span className="muted sm hide-phone">
                          {x.childDoneCount}/{x.childCount}
                        </span>
                      )}
                      {epic && <span className="tk-epic hide-phone">{epic.title}</span>}
                      {overdue && (
                        <span className="tk-overdue sm hide-phone">{fmtDate(x.dueDate, lang)}</span>
                      )}
                      <span className="tk-st hide-phone">
                        <StatusDot status={st} />
                        {st?.name}
                      </span>
                      <span className="tk-pts">{x.storyPoints ?? '–'}</span>
                      <UserChip user={x.assignee} />
                    </div>
                  );
                })}
                {list.length === 0 && (
                  <p className="tk-bl-empty">{s ? t('tk.sprint.empty') : t('tk.backlog.empty')}</p>
                )}
                {project.canEdit &&
                  (adding === sec.id ? (
                    <div className="tk-brow add">
                      <Icon name="plus" size={12} />
                      <input
                        autoFocus
                        value={draft}
                        placeholder={t('tk.quickAddPh')}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void quickAdd(sec.id);
                          if (e.key === 'Escape') setAdding(null);
                        }}
                        onBlur={() => !draft && setAdding(null)}
                      />
                    </div>
                  ) : (
                    <button className="tk-bl-add" onClick={() => (setAdding(sec.id), setDraft(''))}>
                      <Icon name="plus" size={12} />
                      {t('tk.quickAdd')}
                    </button>
                  ))}
              </div>
            )}
          </section>
        );
      })}
      {editing && (
        <SprintDialog
          sprint={editing.sprint}
          start={editing.start}
          onClose={() => setEditing(null)}
          onSaved={() => void ctx.reloadProject()}
        />
      )}
      {completing && (
        <CompleteSprintDialog sprint={completing} onClose={() => setCompleting(null)} />
      )}
    </div>
  );
}

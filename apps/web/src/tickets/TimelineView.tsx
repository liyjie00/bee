/* Roadmap: epics and their children as bars on a calendar; drag a bar to move it, its ends to resize. */
import { useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { TicketDTO } from '@bee/shared';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n';
import { useProjectCtx } from './context';
import { StatusDot, TypeIcon, UserChip, today } from './ui';

type Scale = 'week' | 'month' | 'quarter';
const DAY_PX: Record<Scale, number> = { week: 40, month: 14, quarter: 5 };
const DAY = 86400_000;

const toDay = (s: string) => Math.round(Date.parse(s + 'T00:00:00Z') / DAY);
const fromDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

interface Row {
  t: TicketDTO;
  depth: number;
  hasKids: boolean;
}

export function TimelineView({ tickets }: { tickets: TicketDTO[] }) {
  const { t, lang } = useI18n();
  const ctx = useProjectCtx();
  const [scale, setScale] = useState<Scale>('month');
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<{ id: string; start: number; end: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const px = DAY_PX[scale];

  // Epics first with their children below; then tickets without an epic that have dates.
  const rows = useMemo<Row[]>(() => {
    const shown = new Set(tickets.map((x) => x.id));
    const kids = new Map<string, TicketDTO[]>();
    for (const x of tickets)
      if (x.parentId && x.type !== 'subtask')
        kids.set(x.parentId, [...(kids.get(x.parentId) ?? []), x]);
    const out: Row[] = [];
    for (const e of tickets.filter((x) => x.type === 'epic')) {
      const k = (kids.get(e.id) ?? []).sort((a, b) => a.rank - b.rank);
      out.push({ t: e, depth: 0, hasKids: k.length > 0 });
      if (!folded.has(e.id)) for (const c of k) out.push({ t: c, depth: 1, hasKids: false });
    }
    const loose = tickets.filter(
      (x) =>
        x.type !== 'epic' &&
        x.type !== 'subtask' &&
        !(x.parentId && shown.has(x.parentId) && ctx.byId.get(x.parentId)?.type === 'epic') &&
        (x.startDate || x.dueDate),
    );
    for (const x of loose) out.push({ t: x, depth: 0, hasKids: false });
    return out;
  }, [tickets, folded]);

  // Span of an epic without its own dates: its children's.
  const span = (x: TicketDTO): [number, number] | null => {
    if (dragging?.id === x.id) return [dragging.start, dragging.end];
    if (x.startDate || x.dueDate) {
      const s = toDay(x.startDate ?? x.dueDate!);
      const e = toDay(x.dueDate ?? x.startDate!);
      return [Math.min(s, e), Math.max(s, e)];
    }
    if (x.type === 'epic') {
      const k = tickets.filter((c) => c.parentId === x.id && (c.startDate || c.dueDate));
      if (!k.length) return null;
      const s = Math.min(...k.map((c) => toDay(c.startDate ?? c.dueDate!)));
      const e = Math.max(...k.map((c) => toDay(c.dueDate ?? c.startDate!)));
      return [s, e];
    }
    return null;
  };

  const now = toDay(today());
  const spans = rows.map((r) => span(r.t)).filter((x): x is [number, number] => !!x);
  const first = Math.min(now - 14, ...spans.map((s) => s[0])) - 7;
  const last = Math.max(now + 90, ...spans.map((s) => s[1])) + 14;
  const width = (last - first + 1) * px;

  // Month (or week) labels along the top.
  const ticks = useMemo(() => {
    const out: { x: number; label: string; major: boolean }[] = [];
    for (let d = first; d <= last; d++) {
      const dt = new Date(d * DAY);
      const isMonth = dt.getUTCDate() === 1;
      const isWeek = dt.getUTCDay() === 1;
      if (isMonth || (scale === 'week' && isWeek)) {
        out.push({
          x: (d - first) * px,
          major: isMonth,
          label: isMonth
            ? dt.toLocaleDateString(lang === 'zh-CN' ? 'zh-CN' : 'en-US', {
                month: 'short',
                year: dt.getUTCMonth() === 0 ? 'numeric' : undefined,
                timeZone: 'UTC',
              })
            : String(dt.getUTCDate()),
        });
      }
    }
    return out;
  }, [first, last, px, scale, lang]);

  const sprintBands = ctx.sprints
    .filter((s) => s.startDate && s.endDate)
    .map((s) => ({
      s,
      x: (toDay(s.startDate!) - first) * px,
      w: (toDay(s.endDate!) - toDay(s.startDate!) + 1) * px,
    }));

  const startDrag = (
    e: RPointerEvent,
    x: TicketDTO,
    mode: 'move' | 'start' | 'end',
    base: [number, number],
  ) => {
    if (
      !ctx.project.canEdit ||
      (x.type === 'epic' && !x.startDate && !x.dueDate && mode !== 'move')
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    let cur = { id: x.id, start: base[0], end: base[1] };
    setDragging(cur);
    const move = (ev: PointerEvent) => {
      const d = Math.round((ev.clientX - x0) / px);
      cur =
        mode === 'move'
          ? { id: x.id, start: base[0] + d, end: base[1] + d }
          : mode === 'start'
            ? { id: x.id, start: Math.min(base[0] + d, base[1]), end: base[1] }
            : { id: x.id, start: base[0], end: Math.max(base[1] + d, base[0]) };
      setDragging(cur);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      setDragging(null);
      if (cur.start !== base[0] || cur.end !== base[1])
        void ctx.update(x.id, { startDate: fromDay(cur.start), dueDate: fromDay(cur.end) });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  /** A ticket without dates: click its row's empty space to give it two weeks from that day. */
  const place = (e: React.MouseEvent<HTMLDivElement>, x: TicketDTO) => {
    if (!ctx.project.canEdit || span(x)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const d = first + Math.floor((e.clientX - r.left) / px);
    void ctx.update(x.id, { startDate: fromDay(d), dueDate: fromDay(d + 13) });
  };

  const scrollToday = () => {
    const el = scroller.current;
    if (el) el.scrollLeft = (now - first) * px - el.clientWidth / 3;
  };

  return (
    <div className="tk-timeline">
      <div className="tk-tl-bar">
        <div className="seg" role="group" aria-label={t('tk.tl.scale')}>
          {(['week', 'month', 'quarter'] as Scale[]).map((s) => (
            <button key={s} className={scale === s ? 'on' : ''} onClick={() => setScale(s)}>
              {t(`tk.tl.${s}`)}
            </button>
          ))}
        </div>
        <button className="btn sm" onClick={scrollToday}>
          {t('tk.tl.today')}
        </button>
        <span className="muted sm">{t('tk.tl.hint')}</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <h2>{t('tk.tl.empty')}</h2>
          <p style={{ margin: 0 }}>{t('tk.tl.emptyHint')}</p>
        </div>
      ) : (
        <div className="tk-tl">
          <div className="tk-tl-names">
            <div className="tk-tl-hd" />
            {rows.map(({ t: x, depth, hasKids }) => (
              <div
                key={x.id}
                className="tk-tl-name"
                style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
              >
                {hasKids ? (
                  <button
                    className="ico sm"
                    aria-expanded={!folded.has(x.id)}
                    aria-label={x.title}
                    onClick={() =>
                      setFolded((f) => {
                        const n = new Set(f);
                        if (n.has(x.id)) n.delete(x.id);
                        else n.add(x.id);
                        return n;
                      })
                    }
                  >
                    <Icon name={folded.has(x.id) ? 'chev' : 'down'} size={11} />
                  </button>
                ) : (
                  <span style={{ width: '1.25rem' }} />
                )}
                <TypeIcon type={x.type} />
                <button
                  className="nm"
                  onClick={() => ctx.openTicket(x.id)}
                  title={`${x.key} ${x.title}`}
                >
                  {x.title}
                </button>
                <span className="tk-key hide-phone">{x.key}</span>
              </div>
            ))}
          </div>
          <div className="tk-tl-grid" ref={scroller}>
            <div style={{ width, position: 'relative' }}>
              <div className="tk-tl-hd">
                {ticks.map((k) => (
                  <span
                    key={k.x}
                    className={'tick' + (k.major ? ' major' : '')}
                    style={{ left: k.x }}
                  >
                    {k.label}
                  </span>
                ))}
                {sprintBands.map((b) => (
                  <span
                    key={b.s.id}
                    className={'tk-tl-sprint' + (b.s.state === 'active' ? ' active' : '')}
                    style={{ left: b.x, width: b.w }}
                    title={b.s.name}
                  >
                    {b.s.name}
                  </span>
                ))}
              </div>
              <div className="tk-tl-today" style={{ left: (now - first) * px + px / 2 }} />
              {ticks
                .filter((k) => k.major)
                .map((k) => (
                  <div key={'g' + k.x} className="tk-tl-line" style={{ left: k.x }} />
                ))}
              {rows.map(({ t: x }) => {
                const sp = span(x);
                const st = ctx.status(x.statusId);
                const derived = x.type === 'epic' && !x.startDate && !x.dueDate;
                const pct = x.childCount
                  ? x.childDoneCount / x.childCount
                  : st?.category === 'done'
                    ? 1
                    : 0;
                return (
                  <div
                    key={x.id}
                    className="tk-tl-row"
                    onClick={(e) => place(e, x)}
                    title={!sp && ctx.project.canEdit ? t('tk.tl.place') : undefined}
                  >
                    {sp && (
                      <div
                        className={
                          `tk-tl-bar-item t-${x.type}` +
                          (st?.category === 'done' ? ' done' : '') +
                          (derived ? ' derived' : '')
                        }
                        style={{ left: (sp[0] - first) * px, width: (sp[1] - sp[0] + 1) * px }}
                        onPointerDown={(e) => startDrag(e, x, 'move', sp)}
                        onDoubleClick={() => ctx.openTicket(x.id)}
                      >
                        <span className="fill" style={{ width: `${pct * 100}%` }} />
                        <span className="h l" onPointerDown={(e) => startDrag(e, x, 'start', sp)} />
                        <span className="lbl">
                          <StatusDot status={st} />
                          {x.type === 'epic' && x.childCount
                            ? `${Math.round(pct * 100)}%`
                            : x.title}
                        </span>
                        {x.assignee && <UserChip user={x.assignee} />}
                        <span className="h r" onPointerDown={(e) => startDrag(e, x, 'end', sp)} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* Reports: sprint burndown, velocity and workload per person. */
import { useEffect, useState } from 'react';
import type { BurndownDTO, VelocityDTO, WorkloadDTO } from '@bee/shared';
import { tickets as api } from '../api/tickets';
import { useI18n } from '../i18n';
import { useProjectCtx } from './context';
import { fmtDate, UserChip } from './ui';

export function ReportsView() {
  const { t, lang } = useI18n();
  const ctx = useProjectCtx();
  const { project, sprints } = ctx;
  const candidates = sprints
    .filter((s) => s.state !== 'planned')
    .sort((a, b) => ((a.startDate ?? '') < (b.startDate ?? '') ? 1 : -1));
  const [sprintId, setSprintId] = useState<string>(ctx.activeSprint?.id ?? candidates[0]?.id ?? '');
  const [bd, setBd] = useState<BurndownDTO | null>(null);
  const [vel, setVel] = useState<VelocityDTO | null>(null);
  const [wl, setWl] = useState<WorkloadDTO | null>(null);

  useEffect(() => {
    if (project.usesSprints) void api.velocity(project.id).then(setVel, () => setVel(null));
  }, [project.id]);
  useEffect(() => {
    if (sprintId) void api.burndown(sprintId).then(setBd, () => setBd(null));
    else setBd(null);
    void api
      .workload(project.id, project.usesSprints && sprintId ? sprintId : undefined)
      .then(setWl, () => setWl(null));
  }, [sprintId, ctx.tickets]);

  // Non-sprint projects: counts by status category and created/completed in the last 30 days.
  const cats = { todo: 0, doing: 0, done: 0 };
  for (const x of ctx.tickets)
    if (x.type !== 'epic') cats[ctx.status(x.statusId)?.category ?? 'todo']++;
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const created30 = ctx.tickets.filter((x) => x.createdAt >= since).length;
  const done30 = ctx.tickets.filter((x) => x.completedAt && x.completedAt >= since).length;
  const cycle = (() => {
    const xs = ctx.tickets.filter((x) => x.completedAt && x.completedAt >= since);
    if (!xs.length) return null;
    const days =
      xs.reduce(
        (n, x) => n + (Date.parse(x.completedAt!) - Date.parse(x.createdAt)) / 86400_000,
        0,
      ) / xs.length;
    return Math.round(days * 10) / 10;
  })();

  return (
    <div className="tk-reports">
      {project.usesSprints && (
        <div className="tk-rep-bar">
          <select
            className="field-in"
            value={sprintId}
            onChange={(e) => setSprintId(e.target.value)}
            aria-label={t('tk.f.sprint')}
            style={{ width: 'auto' }}
          >
            {candidates.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.state === 'active' ? ` · ${t('tk.sprint.active')}` : ''}
              </option>
            ))}
            {!candidates.length && <option value="">{t('tk.rep.noSprints')}</option>}
          </select>
        </div>
      )}
      <div className="tk-tiles">
        {project.usesSprints && bd ? (
          <>
            <Tile
              label={t('tk.rep.completed')}
              value={`${bd.scope - bd.remaining}`}
              unit={t('tk.rep.ofPoints', { n: bd.scope })}
            />
            <Tile
              label={t('tk.rep.remaining')}
              value={`${bd.remaining}`}
              unit={t('tk.rep.points')}
            />
            <Tile
              label={t('tk.rep.added')}
              value={`+${bd.added}`}
              unit={t('tk.rep.points')}
              warn={bd.added > 0}
            />
            <Tile
              label={t('tk.rep.daysLeft')}
              value={
                bd.sprint.endDate
                  ? String(
                      Math.max(
                        0,
                        Math.ceil(
                          (Date.parse(bd.sprint.endDate + 'T23:59:59') - Date.now()) / 86400_000,
                        ),
                      ),
                    )
                  : '–'
              }
              unit={t('tk.rep.days')}
            />
          </>
        ) : (
          <>
            <Tile
              label={t('tk.rep.open')}
              value={String(cats.todo + cats.doing)}
              unit={t('tk.rep.tickets')}
            />
            <Tile
              label={t('tk.rep.created30')}
              value={String(created30)}
              unit={t('tk.rep.tickets')}
            />
            <Tile label={t('tk.rep.done30')} value={String(done30)} unit={t('tk.rep.tickets')} />
            <Tile
              label={t('tk.rep.cycle')}
              value={cycle === null ? '–' : String(cycle)}
              unit={t('tk.rep.days')}
            />
          </>
        )}
      </div>
      <div className="tk-rep-grid">
        {project.usesSprints && (
          <section className="tk-card-box">
            <h3>{t('tk.rep.burndown')}</h3>
            {bd && bd.days.length ? (
              <Burndown bd={bd} lang={lang} />
            ) : (
              <p className="muted">{t('tk.rep.burndownEmpty')}</p>
            )}
          </section>
        )}
        {project.usesSprints && (
          <section className="tk-card-box">
            <h3>{t('tk.rep.velocity')}</h3>
            {vel && vel.sprints.length ? (
              <>
                <Velocity vel={vel} />
                <p className="muted sm">{t('tk.rep.velocityAvg', { n: vel.average })}</p>
              </>
            ) : (
              <p className="muted">{t('tk.rep.velocityEmpty')}</p>
            )}
          </section>
        )}
        <section className="tk-card-box wide">
          <h3>{t('tk.rep.workload')}</h3>
          {wl && wl.rows.length ? (
            <div className="tk-wl">
              {wl.rows.map((r, i) => {
                const total = r.todo + r.doing + r.done;
                const max = Math.max(...wl.rows.map((x) => x.todo + x.doing + x.done), 1);
                return (
                  <div key={r.user?.id ?? i} className="tk-wl-row">
                    <UserChip user={r.user} />
                    <span className="nm">{r.user?.name ?? t('tk.unassigned')}</span>
                    <span className="bar" style={{ width: `${(total / max) * 100}%` }}>
                      <i className="done" style={{ flex: r.done }} />
                      <i className="doing" style={{ flex: r.doing }} />
                      <i className="todo" style={{ flex: r.todo }} />
                    </span>
                    <span className="muted n">
                      {t('tk.rep.wlPoints', { n: total, c: r.count })}
                    </span>
                  </div>
                );
              })}
              <div className="tk-legend">
                <span>
                  <i className="done" />
                  {t('tk.cat.done')}
                </span>
                <span>
                  <i className="doing" />
                  {t('tk.cat.doing')}
                </span>
                <span>
                  <i className="todo" />
                  {t('tk.cat.todo')}
                </span>
              </div>
            </div>
          ) : (
            <p className="muted">{t('tk.rep.workloadEmpty')}</p>
          )}
        </section>
      </div>
      {project.usesSprints && bd && (
        <p className="muted sm">
          {t('tk.rep.range', {
            from: fmtDate(bd.sprint.startDate, lang),
            to: fmtDate(bd.sprint.endDate, lang),
          })}
        </p>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  unit,
  warn,
}: {
  label: string;
  value: string;
  unit: string;
  warn?: boolean;
}) {
  return (
    <div className="tk-tile-stat">
      <span className="muted">{label}</span>
      <b className={warn ? 'warn' : ''}>{value}</b>
      <small className="muted">{unit}</small>
    </div>
  );
}

function Burndown({ bd, lang }: { bd: BurndownDTO; lang: string }) {
  const W = 560;
  const H = 240;
  const L = 36;
  const B = 24;
  const start = bd.sprint.startDate ?? bd.days[0]!.date;
  const end = bd.sprint.endDate ?? bd.days[bd.days.length - 1]!.date;
  const total = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 86400_000));
  const max = Math.max(1, ...bd.days.map((d) => Math.max(d.scope, d.remaining)));
  const x = (date: string) =>
    L + ((Date.parse(date) - Date.parse(start)) / 86400_000 / total) * (W - L - 8);
  const y = (v: number) => 10 + (1 - v / max) * (H - B - 10);
  const initial = bd.days[0]?.scope ?? max;
  const pts = (k: 'remaining' | 'scope') => bd.days.map((d) => `${x(d.date)},${y(d[k])}`).join(' ');
  const last = bd.days[bd.days.length - 1]!;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const label = (d: string) =>
    new Date(d + 'T00:00:00').toLocaleDateString(lang === 'zh-CN' ? 'zh-CN' : 'en-US', {
      month: 'numeric',
      day: 'numeric',
    });
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="tk-chart"
      role="img"
      aria-label={`Burndown: ${last.remaining} of ${last.scope} points remaining`}
    >
      {grid.map((g) => (
        <g key={g}>
          <line x1={L} x2={W - 8} y1={y(g)} y2={y(g)} className="grid" />
          <text x={L - 6} y={y(g) + 3} textAnchor="end" className="ax">
            {g}
          </text>
        </g>
      ))}
      <text x={L} y={H - 6} className="ax">
        {label(start)}
      </text>
      <text x={W - 8} y={H - 6} textAnchor="end" className="ax">
        {label(end)}
      </text>
      <line x1={x(start)} y1={y(initial)} x2={x(end)} y2={y(0)} className="ideal" />
      <polyline points={pts('scope')} className="scope" />
      <polyline points={pts('remaining')} className="remaining" />
      <circle cx={x(last.date)} cy={y(last.remaining)} r={4} className="dot" />
      <text x={x(last.date) + 7} y={y(last.remaining) - 6} className="lbl">
        {last.remaining}
      </text>
    </svg>
  );
}

function Velocity({ vel }: { vel: VelocityDTO }) {
  const W = 340;
  const H = 180;
  const max = Math.max(1, ...vel.sprints.flatMap((s) => [s.committed, s.completed]));
  const bw = (W - 20) / vel.sprints.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="tk-chart" role="img" aria-label="Velocity">
      {vel.sprints.map((s, i) => {
        const x0 = 10 + i * bw;
        const h = (v: number) => (v / max) * (H - 40);
        return (
          <g key={s.id}>
            <rect
              x={x0 + bw * 0.15}
              y={H - 22 - h(s.committed)}
              width={bw * 0.32}
              height={h(s.committed)}
              rx={3}
              className="committed"
            />
            <rect
              x={x0 + bw * 0.5}
              y={H - 22 - h(s.completed)}
              width={bw * 0.32}
              height={h(s.completed)}
              rx={3}
              className="completed"
            />
            <text
              x={x0 + bw * 0.66}
              y={H - 26 - h(s.completed)}
              textAnchor="middle"
              className="lbl"
            >
              {s.completed}
            </text>
            <text x={x0 + bw / 2} y={H - 6} textAnchor="middle" className="ax">
              {s.name.replace(/^.*?(\d+)$/, 'S$1')}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* Edit / start a sprint, and complete the active one. */
import { useState } from 'react';
import type { SprintDTO } from '@bee/shared';
import { tickets as api } from '../api/tickets';
import { Icon } from '../components/Icon';
import { useT } from '../i18n';
import { errMsg, useToast } from '../state/toast';
import { useProjectCtx } from './context';
import { today } from './ui';

const plusDays = (d: string, n: number) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

function Shell({
  title,
  children,
  onClose,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  onClose(): void;
  footer: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width: 'min(28rem,100%)' }}
      >
        <div className="mh">
          <h3>{title}</h3>
          <button className="ico" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="mb tk-form">{children}</div>
        <div className="mf">
          <div className="spacer" />
          {footer}
        </div>
      </div>
    </div>
  );
}

export function SprintDialog({
  sprint,
  start,
  onClose,
  onSaved,
}: {
  sprint: SprintDTO | null;
  start?: boolean;
  onClose(): void;
  onSaved(): void;
}) {
  const t = useT();
  const toast = useToast();
  const ctx = useProjectCtx();
  const s0 = sprint?.startDate ?? today();
  const [name, setName] = useState(sprint?.name ?? '');
  const [goal, setGoal] = useState(sprint?.goal ?? '');
  const [startDate, setStart] = useState(s0);
  const [endDate, setEnd] = useState(sprint?.endDate ?? plusDays(s0, 13));
  const [capacity, setCapacity] = useState<string>(
    sprint?.capacity != null ? String(sprint.capacity) : '',
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: name.trim() || undefined,
        goal,
        startDate,
        endDate,
        capacity: capacity === '' ? null : Number(capacity),
      };
      if (sprint) await api.updateSprint(sprint.id, body);
      else await api.createSprint(ctx.project.id, body);
      if (start && sprint) await api.startSprint(sprint.id, { startDate, endDate, goal });
      onSaved();
      onClose();
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell
      title={
        start
          ? t('tk.sprint.startTitle', { name: sprint?.name ?? '' })
          : sprint
            ? t('tk.sprint.edit')
            : t('tk.sprint.create')
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={busy || endDate < startDate}
            onClick={() => void save()}
          >
            {start ? t('tk.sprint.start') : t('tk.save')}
          </button>
        </>
      }
    >
      <label>
        {t('tk.sprint.name')}
        <input
          className="field-in"
          value={name}
          placeholder={sprint?.name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        {t('tk.sprint.goal')}
        <textarea
          className="field-in"
          rows={2}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
      </label>
      <div className="row2">
        <label>
          {t('tk.f.start')}
          <input
            className="field-in"
            type="date"
            value={startDate}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          {t('tk.sprint.end')}
          <input
            className="field-in"
            type="date"
            value={endDate}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
      </div>
      <div className="tk-durations">
        {[1, 2, 3, 4].map((w) => (
          <button key={w} className="btn sm" onClick={() => setEnd(plusDays(startDate, w * 7 - 1))}>
            {t('tk.sprint.weeks', { n: w })}
          </button>
        ))}
      </div>
      <label>
        {t('tk.sprint.capacityLabel')}
        <input
          className="field-in"
          type="number"
          min={0}
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
        />
      </label>
    </Shell>
  );
}

export function CompleteSprintDialog({ sprint, onClose }: { sprint: SprintDTO; onClose(): void }) {
  const t = useT();
  const toast = useToast();
  const ctx = useProjectCtx();
  const inSprint = ctx.tickets.filter((x) => x.sprintId === sprint.id && x.type !== 'subtask');
  const open = inSprint.filter((x) => ctx.status(x.statusId)?.category !== 'done');
  const done = inSprint.length - open.length;
  const planned = ctx.sprints.filter((s) => s.state === 'planned');
  const [moveTo, setMoveTo] = useState<string>(planned[0]?.id ?? 'new');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api.completeSprint(sprint.id, moveTo);
      await Promise.all([ctx.reloadProject(), ctx.reload()]);
      toast(t('tk.sprint.completed', { name: sprint.name }));
      onClose();
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell
      title={t('tk.sprint.completeTitle', { name: sprint.name })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void go()}>
            {t('tk.sprint.complete')}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{t('tk.sprint.completeSummary', { done, open: open.length })}</p>
      {open.length > 0 && (
        <label>
          {t('tk.sprint.moveOpen')}
          <select className="field-in" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            {planned.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="new">{t('tk.sprint.newSprint')}</option>
            <option value="backlog">{t('tk.backlog')}</option>
          </select>
        </label>
      )}
    </Shell>
  );
}

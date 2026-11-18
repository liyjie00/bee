/* Project settings: general, workflow (statuses and transitions), labels, custom fields. */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FIELD_KINDS,
  LABEL_COLORS,
  STATUS_CATEGORIES,
  TICKET_TYPES,
  type FieldDTO,
  type FieldKind,
  type StatusCategory,
  type TicketType,
} from '@bee/shared';
import { tickets as api } from '../api/tickets';
import { Icon } from '../components/Icon';
import { useI18n, type MessageKey } from '../i18n';
import { errMsg, useToast } from '../state/toast';
import { useProjectCtx } from './context';
import { projectsChanged } from './useProject';
import { forgetProjectMeta } from './TicketDetail';
import { StatusDot, typeKey } from './ui';

type Section = 'general' | 'workflow' | 'labels' | 'fields' | 'data';

export function ProjectSettings() {
  const { t } = useI18n();
  const ctx = useProjectCtx();
  const [sec, setSec] = useState<Section>('general');
  if (!ctx.project.canAdmin)
    return (
      <div className="empty">
        <h2>{t('tk.set.noAccess')}</h2>
      </div>
    );
  return (
    <div className="tk-settings">
      <nav className="tk-set-nav" aria-label={t('tk.view.settings')}>
        {(['general', 'workflow', 'labels', 'fields', 'data'] as Section[]).map((s) => (
          <button key={s} className={sec === s ? 'on' : ''} onClick={() => setSec(s)}>
            {t(`tk.set.${s}` as MessageKey)}
          </button>
        ))}
      </nav>
      <div className="tk-set-body">
        {sec === 'general' && <General />}
        {sec === 'workflow' && <Workflow />}
        {sec === 'labels' && <Labels />}
        {sec === 'fields' && <Fields />}
        {sec === 'data' && <DataSection />}
      </div>
    </div>
  );
}

const useSave = () => {
  const toast = useToast();
  const ctx = useProjectCtx();
  return async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      forgetProjectMeta(ctx.project.id);
      await ctx.reloadProject();
      projectsChanged();
      if (done) toast(done);
    } catch (e) {
      toast(errMsg(e));
    }
  };
};

const COLORS = [
  '#e8a317',
  '#3b7dd8',
  '#1e6b2a',
  '#c2410c',
  '#7c3aed',
  '#0e7490',
  '#be185d',
  '#4a5146',
];

function General() {
  const { t } = useI18n();
  const nav = useNavigate();
  const ctx = useProjectCtx();
  const save = useSave();
  const p = ctx.project;
  const [name, setName] = useState(p.name);
  const [key, setKey] = useState(p.key);
  const [description, setDescription] = useState(p.description);
  return (
    <div className="tk-form">
      <h2>{t('tk.set.general')}</h2>
      <label>
        {t('tk.proj.name')}
        <input
          className="field-in"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            name.trim() &&
            name !== p.name &&
            void save(() => api.updateProject(p.id, { name: name.trim() }))
          }
        />
      </label>
      <label>
        {t('tk.proj.key')}
        <input
          className="field-in mono"
          value={key}
          maxLength={10}
          onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
          onBlur={() =>
            key !== p.key &&
            void save(() => api.updateProject(p.id, { key }), t('tk.set.keyChanged'))
          }
        />
        <small className="muted">{t('tk.proj.keyHint')}</small>
      </label>
      <label>
        {t('tk.proj.description')}
        <textarea
          className="field-in"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() =>
            description !== p.description &&
            void save(() => api.updateProject(p.id, { description }))
          }
        />
      </label>
      <div className="lbl">{t('tk.proj.color')}</div>
      <div className="tk-colors">
        {COLORS.map((c) => (
          <button
            key={c}
            className={'tk-color' + (p.color === c ? ' on' : '')}
            style={{ background: c }}
            aria-label={c}
            onClick={() => void save(() => api.updateProject(p.id, { color: c }))}
          />
        ))}
      </div>
      <label>
        {t('tk.proj.lead')}
        <select
          className="field-in"
          value={p.lead?.id ?? ''}
          onChange={(e) =>
            void save(() => api.updateProject(p.id, { leadId: e.target.value || null }))
          }
        >
          <option value="">{t('tk.none')}</option>
          {ctx.members
            .filter((m) => m.role !== 'viewer')
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
        </select>
        <small className="muted">{t('tk.proj.leadHint')}</small>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={p.usesSprints}
          onChange={(e) =>
            void save(() => api.updateProject(p.id, { usesSprints: e.target.checked }))
          }
        />
        {t('tk.proj.usesSprints')}
      </label>
      <hr />
      <div className="tk-danger">
        <button
          className="btn"
          onClick={() =>
            void save(
              () => api.updateProject(p.id, { archived: !p.archivedAt }),
              p.archivedAt ? t('tk.proj.unarchived') : t('tk.proj.archived'),
            )
          }
        >
          {p.archivedAt ? t('tk.proj.unarchive') : t('tk.proj.archive')}
        </button>
        <button
          className="btn danger"
          onClick={() => {
            const typed = prompt(t('tk.proj.deleteConfirm', { key: p.key }));
            if (typed?.trim().toUpperCase() !== p.key) return;
            void api.deleteProject(p.id).then(() => {
              projectsChanged();
              nav('/projects');
            });
          }}
        >
          {t('tk.proj.delete')}
        </button>
      </div>
    </div>
  );
}

function Workflow() {
  const { t } = useI18n();
  const ctx = useProjectCtx();
  const save = useSave();
  const p = ctx.project;
  const [adding, setAdding] = useState<{ name: string; category: StatusCategory } | null>(null);
  const statuses = p.statuses;
  const allowed = new Set(p.transitions.map((x) => `${x.fromId}>${x.toId}`));
  const move = (i: number, d: number) => {
    const ids = statuses.map((s) => s.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void save(() => api.orderStatuses(p.id, ids));
  };
  const counts = (id: string) => ctx.tickets.filter((x) => x.statusId === id).length;
  return (
    <div className="tk-form wide">
      <h2>{t('tk.set.workflow')}</h2>
      <p className="muted">{t('tk.set.workflowHint')}</p>
      <div className="tk-statuses">
        {statuses.map((s, i) => (
          <div key={s.id} className="tk-st-row">
            <span className="ord">
              <button
                className="ico sm"
                aria-label={t('tk.set.up')}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                ↑
              </button>
              <button
                className="ico sm"
                aria-label={t('tk.set.down')}
                disabled={i === statuses.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
            </span>
            <input
              type="color"
              value={s.color}
              aria-label={t('tk.set.color')}
              onChange={(e) =>
                void save(() => api.updateStatus(p.id, s.id, { color: e.target.value }))
              }
            />
            <StatusDot status={s} />
            <input
              className="field-in nm"
              defaultValue={s.name}
              aria-label={t('tk.set.statusName')}
              onBlur={(e) =>
                e.target.value.trim() &&
                e.target.value !== s.name &&
                void save(() => api.updateStatus(p.id, s.id, { name: e.target.value.trim() }))
              }
            />
            <select
              className="field-in"
              value={s.category}
              aria-label={t('tk.set.category')}
              onChange={(e) =>
                void save(() =>
                  api.updateStatus(p.id, s.id, { category: e.target.value as StatusCategory }),
                )
              }
            >
              {STATUS_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`tk.cat.${c}` as MessageKey)}
                </option>
              ))}
            </select>
            <label className="wip">
              {t('tk.set.wip')}
              <input
                className="field-in"
                type="number"
                min={1}
                defaultValue={s.wipLimit ?? ''}
                onBlur={(e) => {
                  const v = e.target.value === '' ? null : Number(e.target.value);
                  if (v !== s.wipLimit)
                    void save(() => api.updateStatus(p.id, s.id, { wipLimit: v }));
                }}
              />
            </label>
            {s.category === 'done' && (
              <label className="check sm">
                <input
                  type="checkbox"
                  checked={s.requireResolution}
                  onChange={(e) =>
                    void save(() =>
                      api.updateStatus(p.id, s.id, { requireResolution: e.target.checked }),
                    )
                  }
                />
                {t('tk.set.requireResolution')}
              </label>
            )}
            <span className="muted n">{t('tk.n.tickets', { n: counts(s.id) })}</span>
            <button
              className="ico sm"
              aria-label={t('tk.set.deleteStatus')}
              disabled={statuses.length <= 1}
              onClick={() => {
                const others = statuses.filter((x) => x.id !== s.id);
                const target = others.find((x) => x.category === s.category) ?? others[0]!;
                if (
                  counts(s.id) &&
                  !confirm(
                    t('tk.set.deleteStatusConfirm', {
                      name: s.name,
                      n: counts(s.id),
                      to: target.name,
                    }),
                  )
                )
                  return;
                void save(async () => {
                  await api.deleteStatus(p.id, s.id, target.id);
                  await ctx.reload();
                });
              }}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
        {adding ? (
          <form
            className="tk-st-row add"
            onSubmit={(e) => {
              e.preventDefault();
              if (!adding.name.trim()) return;
              void save(() =>
                api.addStatus(p.id, {
                  name: adding.name.trim(),
                  category: adding.category,
                  color:
                    adding.category === 'done'
                      ? '#1e6b2a'
                      : adding.category === 'doing'
                        ? '#3b7dd8'
                        : '#7b8375',
                }),
              ).then(() => setAdding(null));
            }}
          >
            <input
              className="field-in nm"
              autoFocus
              placeholder={t('tk.set.statusName')}
              value={adding.name}
              onChange={(e) => setAdding({ ...adding, name: e.target.value })}
            />
            <select
              className="field-in"
              value={adding.category}
              onChange={(e) => setAdding({ ...adding, category: e.target.value as StatusCategory })}
            >
              {STATUS_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`tk.cat.${c}` as MessageKey)}
                </option>
              ))}
            </select>
            <button className="btn primary sm">{t('tk.set.add')}</button>
            <button type="button" className="btn sm" onClick={() => setAdding(null)}>
              {t('common.cancel')}
            </button>
          </form>
        ) : (
          <button className="btn" onClick={() => setAdding({ name: '', category: 'doing' })}>
            <Icon name="plus" />
            {t('tk.set.addStatus')}
          </button>
        )}
      </div>

      <h3>{t('tk.set.transitions')}</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={p.restrictTransitions}
          onChange={(e) =>
            void save(() => api.updateProject(p.id, { restrictTransitions: e.target.checked }))
          }
        />
        {t('tk.set.restrict')}
      </label>
      {p.restrictTransitions && (
        <div className="tk-matrix-wrap">
          <table className="tk-matrix">
            <thead>
              <tr>
                <th>{t('tk.set.fromTo')}</th>
                {statuses.map((s) => (
                  <th key={s.id}>
                    <StatusDot status={s} /> {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {statuses.map((from) => (
                <tr key={from.id}>
                  <th>
                    <StatusDot status={from} /> {from.name}
                  </th>
                  {statuses.map((to) => (
                    <td key={to.id}>
                      {from.id !== to.id && (
                        <input
                          type="checkbox"
                          aria-label={`${from.name} → ${to.name}`}
                          checked={allowed.has(`${from.id}>${to.id}`)}
                          onChange={(e) => {
                            const n = new Set(allowed);
                            const k = `${from.id}>${to.id}`;
                            if (e.target.checked) n.add(k);
                            else n.delete(k);
                            void save(() =>
                              api.setTransitions(
                                p.id,
                                [...n].map((x) => ({
                                  fromId: x.split('>')[0]!,
                                  toId: x.split('>')[1]!,
                                })),
                              ),
                            );
                          }}
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Labels() {
  const { t } = useI18n();
  const ctx = useProjectCtx();
  const save = useSave();
  const p = ctx.project;
  const [name, setName] = useState('');
  return (
    <div className="tk-form">
      <h2>{t('tk.set.labels')}</h2>
      {p.labels.map((l) => (
        <div key={l.id} className="tk-st-row">
          <input
            type="color"
            value={l.color}
            aria-label={t('tk.set.color')}
            onChange={(e) =>
              void save(() => api.updateLabel(p.id, l.id, { color: e.target.value }))
            }
          />
          <input
            className="field-in nm"
            defaultValue={l.name}
            onBlur={(e) =>
              e.target.value.trim() &&
              e.target.value !== l.name &&
              void save(() => api.updateLabel(p.id, l.id, { name: e.target.value.trim() }))
            }
          />
          <span className="muted n">
            {t('tk.n.tickets', { n: ctx.tickets.filter((x) => x.labelIds.includes(l.id)).length })}
          </span>
          <button
            className="ico sm"
            aria-label={t('tk.set.delete')}
            onClick={() =>
              confirm(t('tk.set.deleteLabelConfirm', { name: l.name })) &&
              void save(async () => {
                await api.deleteLabel(p.id, l.id);
                await ctx.reload();
              })
            }
          >
            <Icon name="trash" size={13} />
          </button>
        </div>
      ))}
      <form
        className="tk-st-row add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void save(() =>
            api.addLabel(p.id, name.trim(), LABEL_COLORS[p.labels.length % LABEL_COLORS.length]),
          ).then(() => setName(''));
        }}
      >
        <input
          className="field-in nm"
          placeholder={t('tk.label.newPh')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn sm primary" disabled={!name.trim()}>
          {t('tk.label.add')}
        </button>
      </form>
    </div>
  );
}

function Fields() {
  const { t } = useI18n();
  const ctx = useProjectCtx();
  const save = useSave();
  const p = ctx.project;
  const [draft, setDraft] = useState<{ name: string; kind: FieldKind; options: string } | null>(
    null,
  );
  const withOptions = (k: FieldKind) => k === 'select' || k === 'multi_select';
  return (
    <div className="tk-form wide">
      <h2>{t('tk.set.fields')}</h2>
      <p className="muted">{t('tk.set.fieldsHint')}</p>
      {p.fields.map((f) => (
        <FieldRow key={f.id} f={f} />
      ))}
      {draft ? (
        <form
          className="tk-field-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.name.trim()) return;
            const options = withOptions(draft.kind)
              ? draft.options
                  .split(/[,，\n]/)
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((label) => ({ label }))
              : undefined;
            void save(() =>
              api.addField(p.id, { name: draft.name.trim(), kind: draft.kind, options }),
            ).then(() => setDraft(null));
          }}
        >
          <input
            className="field-in"
            autoFocus
            placeholder={t('tk.set.fieldName')}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <select
            className="field-in"
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as FieldKind })}
          >
            {FIELD_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`tk.kind.${k}` as MessageKey)}
              </option>
            ))}
          </select>
          {withOptions(draft.kind) && (
            <input
              className="field-in"
              placeholder={t('tk.set.optionsPh')}
              value={draft.options}
              onChange={(e) => setDraft({ ...draft, options: e.target.value })}
            />
          )}
          <button className="btn primary sm">{t('tk.set.add')}</button>
          <button type="button" className="btn sm" onClick={() => setDraft(null)}>
            {t('common.cancel')}
          </button>
        </form>
      ) : (
        <button className="btn" onClick={() => setDraft({ name: '', kind: 'text', options: '' })}>
          <Icon name="plus" />
          {t('tk.set.addField')}
        </button>
      )}
    </div>
  );
}

function FieldRow({ f }: { f: FieldDTO }) {
  const { t } = useI18n();
  const ctx = useProjectCtx();
  const save = useSave();
  const p = ctx.project;
  const [opt, setOpt] = useState('');
  const applies = f.appliesTo ?? [...TICKET_TYPES];
  const setApplies = (ty: TicketType, on: boolean) => {
    const n = on ? [...new Set([...applies, ty])] : applies.filter((x) => x !== ty);
    if (!n.length) return;
    void save(() =>
      api.updateField(p.id, f.id, { appliesTo: n.length === TICKET_TYPES.length ? null : n }),
    );
  };
  return (
    <div className="tk-field">
      <div className="tk-st-row">
        <input
          className="field-in nm"
          defaultValue={f.name}
          onBlur={(e) =>
            e.target.value.trim() &&
            e.target.value !== f.name &&
            void save(() => api.updateField(p.id, f.id, { name: e.target.value.trim() }))
          }
        />
        <span className="pill">{t(`tk.kind.${f.kind}` as MessageKey)}</span>
        <span className="spacer" />
        <button
          className="ico sm"
          aria-label={t('tk.set.delete')}
          onClick={() =>
            confirm(t('tk.set.deleteFieldConfirm', { name: f.name })) &&
            void save(async () => {
              await api.deleteField(p.id, f.id);
              await ctx.reload();
            })
          }
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
      {(f.kind === 'select' || f.kind === 'multi_select') && (
        <div className="tk-opts">
          {f.options.map((o) => (
            <span
              key={o.id}
              className="tk-label"
              style={{ background: o.color + '22', color: o.color }}
            >
              {o.label}
              <button
                aria-label={t('tk.set.delete')}
                onClick={() =>
                  void save(() =>
                    api.updateField(p.id, f.id, {
                      options: f.options.filter((x) => x.id !== o.id),
                    }),
                  )
                }
              >
                ×
              </button>
            </span>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!opt.trim()) return;
              void save(() =>
                api.updateField(p.id, f.id, { options: [...f.options, { label: opt.trim() }] }),
              ).then(() => setOpt(''));
            }}
          >
            <input
              className="field-in sm"
              placeholder={t('tk.set.addOption')}
              value={opt}
              onChange={(e) => setOpt(e.target.value)}
            />
          </form>
        </div>
      )}
      <div className="tk-applies">
        <span className="muted">{t('tk.set.appliesTo')}</span>
        {TICKET_TYPES.map((ty) => (
          <label key={ty} className="check sm">
            <input
              type="checkbox"
              checked={applies.includes(ty)}
              onChange={(e) => setApplies(ty, e.target.checked)}
            />
            {t(typeKey(ty))}
          </label>
        ))}
      </div>
    </div>
  );
}

function DataSection() {
  const { t } = useI18n();
  const toast = useToast();
  const ctx = useProjectCtx();
  const p = ctx.project;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    created: number;
    errors: string[];
    errorCount: number;
  } | null>(null);
  return (
    <div className="tk-form">
      <h2>{t('tk.set.data')}</h2>
      <h3>{t('tk.csv.export')}</h3>
      <p className="muted">{t('tk.csv.exportHint')}</p>
      <a
        className="btn"
        style={{ alignSelf: 'flex-start' }}
        href={`/api/projects/${p.id}/export.csv`}
        download
      >
        <Icon name="download" />
        {t('tk.csv.download', { key: p.key })}
      </a>
      {p.canEdit && (
        <>
          <h3>{t('tk.csv.import')}</h3>
          <p className="muted">{t('tk.csv.importHint')}</p>
          <label
            className="btn"
            style={{ alignSelf: 'flex-start', flexDirection: 'row', cursor: 'pointer' }}
          >
            <Icon name="upload" />
            {busy ? t('app.loading') : t('tk.csv.pick')}
            <input
              type="file"
              accept=".csv,text/csv"
              hidden
              disabled={busy}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                setBusy(true);
                try {
                  const r = await api.importCsv(p.id, await f.text());
                  setResult(r);
                  await Promise.all([ctx.reload(), ctx.reloadProject()]);
                  toast(t('tk.csv.done', { n: r.created }));
                } catch (er) {
                  toast(errMsg(er));
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
          {result && (
            <div className="tk-csv-result">
              <b>{t('tk.csv.done', { n: result.created })}</b>
              {result.errorCount > 0 && (
                <>
                  <span className="muted">{t('tk.csv.problems', { n: result.errorCount })}</span>
                  <ul>
                    {result.errors.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* A ticket's full view: description, subtasks, links, documents, attachments, activity and
 * its fields. Shown as a side panel over a project view, or as a page of its own. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BeeMarkdownEditor } from '@bee/editor';
import {
  allowedParentTypes,
  LINK_KINDS,
  PRIORITIES,
  RESOLUTIONS,
  sprintable,
  TICKET_TYPES,
  type FieldDTO,
  type LinkKind,
  type ProjectDTO,
  type SprintDTO,
  type TicketDetailDTO,
  type TicketDTO,
  type TicketType,
} from '@bee/shared';
import { api } from '../api/http';
import { tickets as tapi, type Member, type TicketPatch } from '../api/tickets';
import { Icon, docIcon } from '../components/Icon';
import { MentionInput } from '../components/MentionInput';
import { useMenu } from '../components/Menu';
import { useAgo, useI18n, type MessageKey } from '../i18n';
import { errMsg, useToast } from '../state/toast';
import { useSession } from '../state/session';
import { ResolutionDialog } from './ResolutionDialog';
import {
  fmtDate,
  fmtMinutes,
  parseMinutes,
  Picker,
  PriorityIcon,
  ProjectTile,
  StatusDot,
  TypeIcon,
  UserChip,
  usePicker,
  priorityKey,
  typeKey,
  type PickOption,
} from './ui';

type Key =
  | 'status'
  | 'assignee'
  | 'reporter'
  | 'priority'
  | 'parent'
  | 'sprint'
  | 'labels'
  | 'type'
  | 'watchers'
  | 'resolution'
  | `field:${string}`;

interface Meta {
  project: ProjectDTO;
  members: Member[];
  sprints: SprintDTO[];
}

const metaCache = new Map<string, Promise<Meta>>();
export const forgetProjectMeta = (id: string) => metaCache.delete(id);
function loadMeta(projectId: string): Promise<Meta> {
  let p = metaCache.get(projectId);
  if (!p) {
    p = tapi.project(projectId);
    metaCache.set(projectId, p);
    p.catch(() => metaCache.delete(projectId));
  }
  return p;
}

export function TicketDetail({
  ticketId,
  mode,
  onClose,
  onChanged,
  onDeleted,
  onOpen,
  allTickets,
}: {
  ticketId: string;
  mode: 'panel' | 'page';
  onClose?(): void;
  /** the ticket (or one it touched) changed */
  onChanged?(t: TicketDTO): void;
  onDeleted?(ids: string[]): void;
  /** opens another ticket (subtask, parent, link) */
  onOpen?(id: string): void;
  /** the project's tickets, for parent and link pickers (loaded on demand otherwise) */
  allTickets?: TicketDTO[];
}) {
  const { t, lang } = useI18n();
  const ago = useAgo();
  const toast = useToast();
  const nav = useNavigate();
  const menu = useMenu();
  const { session } = useSession();
  const pk = usePicker<Key>();
  const [tk, setTk] = useState<TicketDetailDTO | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [missing, setMissing] = useState(false);
  const [others, setOthers] = useState<TicketDTO[] | null>(allTickets ?? null);
  const [comment, setComment] = useState('');
  const [tab, setTab] = useState<'all' | 'comments' | 'history'>('all');
  const [title, setTitle] = useState('');
  const [newSub, setNewSub] = useState<string | null>(null);
  const [linking, setLinking] = useState<{
    kind: LinkKind;
    direction: 'out' | 'in';
    key: string;
  } | null>(null);
  const [docQuery, setDocQuery] = useState<string | null>(null);
  const [docHits, setDocHits] = useState<{ id: string; title: string; type: string }[]>([]);
  const [askResolution, setAskResolution] = useState<string | null>(null);
  const [descKey, setDescKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const d = await tapi.get(ticketId);
      setTk(d);
      setTitle(d.title);
      setMissing(false);
      const m = await loadMeta(d.projectId);
      setMeta(m);
    } catch {
      setMissing(true);
    }
  }, [ticketId]);

  useEffect(() => {
    setTk(null);
    setDescKey((k) => k + 1);
    void load();
  }, [ticketId]);
  useEffect(() => {
    if (allTickets) setOthers(allTickets);
  }, [allTickets]);
  useEffect(() => {
    if (!tk || others) return;
    void tapi.list(tk.projectId).then(
      (r) => setOthers(r.tickets),
      () => setOthers([]),
    );
  }, [tk?.projectId]);
  useEffect(() => {
    if (mode !== 'panel') return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || pk.open) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input,textarea,.ProseMirror')) return;
      onClose?.();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [mode, pk.open]);

  // Doc search for "link a document".
  useEffect(() => {
    if (docQuery === null || !tk) return;
    const timer = setTimeout(() => {
      const ws = tk.project.workspaceId;
      const run = docQuery.trim()
        ? api.search(ws, docQuery.trim()).then((r) => r.map((x) => x.document))
        : api.recent(ws);
      void run.then(
        (docs) =>
          setDocHits(docs.slice(0, 8).map((d) => ({ id: d.id, title: d.title, type: d.type }))),
        () => setDocHits([]),
      );
    }, 150);
    return () => clearTimeout(timer);
  }, [docQuery, tk?.id]);

  const statusOf = (id: string) => meta?.project.statuses.find((s) => s.id === id);

  const patch = async (p: TicketPatch) => {
    if (!tk) return;
    try {
      const r = await tapi.update(tk.id, p);
      onChanged?.(r);
      await load();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'resolution_required' && p.statusId) setAskResolution(p.statusId);
      else toast(errMsg(e));
    }
  };

  const setStatus = (statusId: string) => {
    const s = statusOf(statusId);
    if (s?.category === 'done' && s.requireResolution) setAskResolution(statusId);
    else void patch({ statusId });
  };

  if (missing)
    return (
      <div className={mode === 'panel' ? 'tk-panel' : 'tk-page'}>
        <div className="empty">
          <h2>{t('tk.detail.missing')}</h2>
          {onClose && (
            <button className="btn" onClick={onClose}>
              {t('common.close')}
            </button>
          )}
        </div>
      </div>
    );
  if (!tk || !meta)
    return (
      <div className={mode === 'panel' ? 'tk-panel' : 'tk-page'}>
        <div className="empty">{t('app.loading')}</div>
      </div>
    );

  const { project, members, sprints } = meta;
  const edit = tk.canEdit;
  const status = statusOf(tk.statusId);
  const parentTypes = allowedParentTypes(tk.type);
  const parentOptions = (others ?? []).filter(
    (x) => parentTypes?.includes(x.type) && x.id !== tk.id,
  );
  const sprint = sprints.find((s) => s.id === tk.sprintId) ?? null;
  const nextStatuses = project.restrictTransitions
    ? project.transitions
        .filter((x) => x.fromId === tk.statusId)
        .map((x) => statusOf(x.toId))
        .filter((s): s is NonNullable<typeof s> => !!s)
    : project.statuses.filter((s) => s.position > (status?.position ?? 0)).slice(0, 1);
  const people = (q: string) =>
    Promise.resolve(
      members
        .filter((m) => m.name.toLowerCase().includes(q.toLowerCase()))
        .map((m) => ({
          id: m.id,
          name: m.name,
          color: m.color,
          avatarUrl: m.avatarUrl,
          email: '',
        })),
    );
  const memberOpts = (none = true): PickOption[] => [
    ...(none ? [{ id: '', label: t('tk.unassigned'), icon: <UserChip user={null} /> }] : []),
    ...members.map((m) => ({ id: m.id, label: m.name, icon: <UserChip user={m} /> })),
  ];

  const val = (key: Key, content: ReactNode, opts: { empty?: boolean; disabled?: boolean } = {}) =>
    edit && !opts.disabled ? (
      <button
        className={'tk-val' + (opts.empty ? ' empty' : '')}
        onClick={(e) => pk.toggle(key, e.currentTarget)}
      >
        {content}
      </button>
    ) : (
      <span className={'tk-val ro' + (opts.empty ? ' empty' : '')}>{content}</span>
    );

  const fieldValue = (f: FieldDTO): ReactNode => {
    const v = tk.fields[f.id];
    if (v === undefined || v === null || v === '')
      return <span className="muted">{t('tk.none')}</span>;
    switch (f.kind) {
      case 'select': {
        const o = f.options.find((x) => x.id === v);
        return o ? (
          <span className="tk-label" style={{ background: o.color + '22', color: o.color }}>
            {o.label}
          </span>
        ) : null;
      }
      case 'multi_select':
        return (v as string[]).map((id) => {
          const o = f.options.find((x) => x.id === id);
          return o ? (
            <span
              key={id}
              className="tk-label"
              style={{ background: o.color + '22', color: o.color }}
            >
              {o.label}
            </span>
          ) : null;
        });
      case 'user': {
        const m = members.find((x) => x.id === v);
        return m ? (
          <>
            <UserChip user={m} />
            {m.name}
          </>
        ) : null;
      }
      case 'checkbox':
        return v ? t('tk.yes') : t('tk.no');
      case 'url':
        return (
          <a href={String(v)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            {String(v)}
          </a>
        );
      case 'date':
        return fmtDate(String(v), lang);
      default:
        return String(v);
    }
  };

  const fieldEditor = (f: FieldDTO) => {
    const v = tk.fields[f.id];
    const save = (x: unknown) => void patch({ fields: { [f.id]: x } });
    if (!edit) return <span className="tk-val ro">{fieldValue(f)}</span>;
    switch (f.kind) {
      case 'select':
      case 'multi_select':
      case 'user':
        return val(`field:${f.id}`, fieldValue(f));
      case 'checkbox':
        return (
          <input
            type="checkbox"
            checked={!!v}
            onChange={(e) => save(e.target.checked)}
            aria-label={f.name}
          />
        );
      case 'date':
        return (
          <input
            className="tk-inline"
            type="date"
            value={(v as string) ?? ''}
            onChange={(e) => save(e.target.value || null)}
            aria-label={f.name}
          />
        );
      case 'number':
        return (
          <input
            className="tk-inline"
            type="number"
            defaultValue={(v as number) ?? ''}
            aria-label={f.name}
            onBlur={(e) => {
              const n = e.target.value === '' ? null : Number(e.target.value);
              if (n !== (v ?? null)) save(n);
            }}
          />
        );
      default:
        return (
          <input
            className="tk-inline"
            defaultValue={(v as string) ?? ''}
            placeholder={f.kind === 'url' ? 'https://' : t('tk.none')}
            aria-label={f.name}
            onBlur={(e) => {
              const s = e.target.value.trim();
              if (s !== ((v as string) ?? '')) save(s || null);
            }}
          />
        );
    }
  };

  const fieldsFor = project.fields.filter((f) => !f.appliesTo || f.appliesTo.includes(tk.type));
  const openField = pk.open?.key.startsWith('field:')
    ? project.fields.find((f) => `field:${f.id}` === pk.open!.key)
    : undefined;

  const describe = (e: TicketDetailDTO['events'][number]): ReactNode => {
    const name = (id: unknown) => members.find((m) => m.id === id)?.name ?? t('tk.unassigned');
    const st = (id: unknown) => statusOf(String(id))?.name ?? '?';
    const spr = (id: unknown) =>
      id ? (sprints.find((s) => s.id === id)?.name ?? '?') : t('tk.backlog');
    const k = `tk.ev.${e.field.startsWith('field:') ? 'field' : e.field}` as MessageKey;
    switch (e.field) {
      case 'created':
        return t('tk.ev.created');
      case 'status':
        return t('tk.ev.status', { from: st(e.from), to: st(e.to) });
      case 'assignee':
        return t('tk.ev.assignee', { to: name(e.to) });
      case 'priority':
        return t('tk.ev.priority', {
          from: t(priorityKey(e.from as never)),
          to: t(priorityKey(e.to as never)),
        });
      case 'sprint':
        return t('tk.ev.sprint', { to: spr(e.to) });
      case 'storyPoints':
        return t('tk.ev.storyPoints', { from: String(e.from ?? '—'), to: String(e.to ?? '—') });
      case 'type':
        return t('tk.ev.type', {
          from: t(typeKey(e.from as TicketType)),
          to: t(typeKey(e.to as TicketType)),
        });
      case 'title':
        return t('tk.ev.title', { to: String(e.to) });
      case 'link': {
        const l = e.to as { kind: LinkKind; direction: 'out' | 'in'; key?: string };
        return t('tk.ev.link', {
          kind: t(`tk.link.${l.kind}.${l.direction}` as MessageKey),
          key: l.key ?? '',
        });
      }
      default:
        if (e.field.startsWith('field:')) {
          const f = project.fields.find((x) => `field:${x.id}` === e.field);
          return t('tk.ev.field', { name: f?.name ?? '?' });
        }
        return t(k);
    }
  };

  const activity: { at: string; node: ReactNode; key: string }[] = [
    ...(tab !== 'history'
      ? tk.comments.map((c) => ({
          at: c.createdAt,
          key: c.id,
          node: (
            <div className="tk-comment">
              <UserChip user={c.author} sm={false} />
              <div className="body">
                <div className="who">
                  <b>{c.author?.name ?? t('tk.someone')}</b>
                  <span className="muted">
                    {' '}
                    · {ago(c.createdAt)}
                    {c.editedAt ? ` · ${t('tk.edited')}` : ''}
                  </span>
                  {c.mine && (
                    <button
                      className="ico sm"
                      aria-label={t('common.more')}
                      onClick={(e) =>
                        menu.open(e, [
                          {
                            label: t('tk.comment.edit'),
                            icon: 'pen',
                            onSelect: () => {
                              const body = prompt(t('tk.comment.edit'), c.body);
                              if (body?.trim())
                                void tapi
                                  .editComment(c.id, body.trim())
                                  .then(load, (er) => toast(errMsg(er)));
                            },
                          },
                          {
                            label: t('tk.comment.delete'),
                            icon: 'trash',
                            danger: true,
                            onSelect: () =>
                              void tapi.deleteComment(c.id).then(load, (er) => toast(errMsg(er))),
                          },
                        ])
                      }
                    >
                      <Icon name="more" size={12} />
                    </button>
                  )}
                </div>
                <div className="txt">{c.body}</div>
              </div>
            </div>
          ),
        }))
      : []),
    ...(tab !== 'comments'
      ? tk.events.map((e) => ({
          at: e.createdAt,
          key: e.id,
          node: (
            <div className="tk-event">
              <UserChip user={e.actor} />
              <span>
                <b>{e.actor?.name ?? t('tk.someone')}</b> {describe(e)}{' '}
                <span className="muted">· {ago(e.createdAt)}</span>
              </span>
            </div>
          ),
        }))
      : []),
  ].sort((a, b) => (a.at < b.at ? -1 : 1));

  const send = async () => {
    const body = comment.trim();
    if (!body) return;
    try {
      await tapi.comment(tk.id, body);
      setComment('');
      await load();
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const addSub = async () => {
    const title = newSub?.trim();
    if (!title) return setNewSub(null);
    try {
      const childType: TicketType = tk.type === 'epic' ? 'story' : 'subtask';
      const c = await tapi.create(tk.projectId, { type: childType, title, parentId: tk.id });
      onChanged?.(c);
      setNewSub('');
      await load();
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const doneKids = tk.children.filter((c) => statusOf(c.statusId)?.category === 'done').length;
  const url = `${location.origin}/t/${tk.id}`;

  return (
    <div
      className={mode === 'panel' ? 'tk-panel' : 'tk-page'}
      role={mode === 'panel' ? 'dialog' : undefined}
      aria-label={`${tk.key} ${tk.title}`}
    >
      <div className="tk-dh">
        <ProjectTile project={project} />
        <Link to={`/projects/${project.id}`} className="muted">
          {project.name}
        </Link>
        {tk.parent && (
          <>
            <Icon name="chev" size={11} />
            <button className="tk-crumb" onClick={() => onOpen?.(tk.parent!.id)}>
              <TypeIcon type={tk.parent.type} />
              {tk.parent.key}
            </button>
          </>
        )}
        <Icon name="chev" size={11} />
        {val(
          'type',
          <>
            <TypeIcon type={tk.type} />
            <span className="tk-key">{tk.key}</span>
          </>,
        )}
        <div className="spacer" />
        <button
          className={'btn sm' + (tk.watching ? ' on' : '')}
          onClick={() => void tapi.watch(tk.id, !tk.watching).then(load, (e) => toast(errMsg(e)))}
          title={tk.watching ? t('tk.unwatch') : t('tk.watch')}
        >
          <Icon name="bell" size={13} />
          {tk.watching ? t('tk.watching') : t('tk.watch')} · {tk.watchers.length}
        </button>
        <button
          className="ico"
          aria-label={t('common.copyLink')}
          title={t('common.copyLink')}
          onClick={() =>
            void navigator.clipboard?.writeText(url).then(() => toast(t('common.linkCopied')))
          }
        >
          <Icon name="link" />
        </button>
        {mode === 'panel' && (
          <button
            className="ico hide-phone"
            aria-label={t('tk.openPage')}
            title={t('tk.openPage')}
            onClick={() => nav(`/t/${tk.id}`)}
          >
            <Icon name="arrow" />
          </button>
        )}
        {edit && (
          <button
            className="ico"
            aria-label={t('common.more')}
            onClick={(e) =>
              menu.open(e, [
                {
                  label: t('tk.delete'),
                  icon: 'trash',
                  danger: true,
                  onSelect: () => {
                    if (!confirm(t('tk.deleteConfirm', { key: tk.key }))) return;
                    void tapi.remove(tk.id).then(
                      (ids) => {
                        onDeleted?.(ids);
                        toast(t('tk.deleted', { key: tk.key }));
                        onClose?.();
                      },
                      (er) => toast(errMsg(er)),
                    );
                  },
                },
              ])
            }
          >
            <Icon name="more" />
          </button>
        )}
        {onClose && (
          <button className="ico" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        )}
      </div>

      <div className="tk-dbody">
        <div className="tk-dtop">
          {edit ? (
            <textarea
              className="tk-title-edit"
              rows={1}
              value={title}
              aria-label={t('tk.f.title')}
              onChange={(e) => setTitle(e.target.value.replace(/\n/g, ''))}
              onBlur={() =>
                title.trim() && title.trim() !== tk.title && void patch({ title: title.trim() })
              }
              onKeyDown={(e) =>
                e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())
              }
            />
          ) : (
            <h1 className="tk-title">{tk.title}</h1>
          )}
          {edit && (
            <div className="tk-actions">
              <button className="btn sm" onClick={() => setNewSub('')}>
                <Icon name="plus" size={12} />
                {tk.type === 'epic' ? t('tk.addChild') : t('tk.addSubtask')}
              </button>
              <button
                className="btn sm"
                onClick={() => setLinking({ kind: 'relates', direction: 'out', key: '' })}
              >
                <Icon name="link" size={12} />
                {t('tk.addLink')}
              </button>
              <button className="btn sm" onClick={() => setDocQuery('')}>
                <Icon name="doc" size={12} />
                {t('tk.addDoc')}
              </button>
              <label className="btn sm">
                <Icon name="upload" size={12} />
                {t('tk.attach')}
                <input
                  type="file"
                  hidden
                  multiple
                  onChange={async (e) => {
                    const files = [...(e.target.files ?? [])];
                    e.target.value = '';
                    for (const f of files)
                      await tapi.upload(tk.id, f).catch((er) => toast(errMsg(er)));
                    await load();
                  }}
                />
              </label>
            </div>
          )}
        </div>
        <div className="tk-dmain">
          <section className="tk-sec">
            <BeeMarkdownEditor
              key={tk.id}
              resetKey={descKey}
              value={tk.description}
              editable={edit}
              locale={lang}
              placeholder={t('tk.descPh')}
              uploadImage={(f) => tapi.upload(tk.id, f).then((r) => r.url)}
              onUploadError={(e) => toast(errMsg(e))}
              onChange={(md) =>
                void tapi
                  .update(tk.id, { description: md })
                  .then(onChanged, (e) => toast(errMsg(e)))
              }
              searchDocs={async (q) => {
                const ws = project.workspaceId;
                const docs = q
                  ? (await api.search(ws, q)).map((r) => r.document)
                  : await api.recent(ws);
                return docs
                  .slice(0, 8)
                  .map((d) => ({ id: d.id, title: d.title || t('common.untitled'), type: d.type }));
              }}
              onOpenLink={(href) => {
                const u = new URL(href, location.origin);
                if (u.origin !== location.origin) return false;
                nav(u.pathname + u.search + u.hash);
                return true;
              }}
              className="tk-desc-edit"
            />
          </section>

          {(tk.children.length > 0 || newSub !== null) && (
            <section className="tk-sec">
              <h3 className="tk-sh">
                {tk.type === 'epic' ? t('tk.children') : t('tk.subtasks')}
                {tk.children.length > 0 && (
                  <>
                    <span className="ok">
                      {doneKids} / {tk.children.length}
                    </span>
                    <span className="tk-progress">
                      <i style={{ width: `${(doneKids / tk.children.length) * 100}%` }} />
                    </span>
                  </>
                )}
              </h3>
              <div className="tk-box">
                {tk.children.map((c) => (
                  <button key={c.id} className="tk-row" onClick={() => onOpen?.(c.id)}>
                    <TypeIcon type={c.type} />
                    <span className="tk-key">{c.key}</span>
                    <span
                      className={'nm' + (statusOf(c.statusId)?.category === 'done' ? ' done' : '')}
                    >
                      {c.title}
                    </span>
                    {c.storyPoints != null && <span className="tk-pts">{c.storyPoints}</span>}
                    <StatusDot status={statusOf(c.statusId)} />
                    <span className="muted st">{statusOf(c.statusId)?.name}</span>
                    <UserChip user={c.assignee} />
                  </button>
                ))}
                {newSub !== null && (
                  <div className="tk-row add">
                    <TypeIcon type={tk.type === 'epic' ? 'story' : 'subtask'} />
                    <input
                      autoFocus
                      value={newSub}
                      placeholder={t('tk.childPh')}
                      onChange={(e) => setNewSub(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void addSub();
                        if (e.key === 'Escape') setNewSub(null);
                      }}
                      onBlur={() => !newSub && setNewSub(null)}
                    />
                  </div>
                )}
              </div>
            </section>
          )}

          {(tk.links.length > 0 || linking) && (
            <section className="tk-sec">
              <h3 className="tk-sh">{t('tk.links')}</h3>
              <div className="tk-box">
                {tk.links.map((l) => (
                  <div key={l.id} className="tk-row">
                    <span className="muted lk">
                      {t(`tk.link.${l.kind}.${l.direction}` as MessageKey)}
                    </span>
                    <TypeIcon type={l.ticket.type} />
                    <button className="tk-key link" onClick={() => onOpen?.(l.ticket.id)}>
                      {l.ticket.key}
                    </button>
                    <span className={'nm' + (l.ticket.status.category === 'done' ? ' done' : '')}>
                      {l.ticket.title}
                    </span>
                    <StatusDot status={l.ticket.status} />
                    <span className="muted st">{l.ticket.status.name}</span>
                    {edit && (
                      <button
                        className="ico sm"
                        aria-label={t('tk.unlink')}
                        onClick={() => void tapi.unlink(l.id).then(load, (e) => toast(errMsg(e)))}
                      >
                        <Icon name="x" size={11} />
                      </button>
                    )}
                  </div>
                ))}
                {linking && (
                  <div className="tk-row add">
                    <select
                      value={`${linking.kind}.${linking.direction}`}
                      onChange={(e) => {
                        const [kind, direction] = e.target.value.split('.') as [
                          LinkKind,
                          'out' | 'in',
                        ];
                        setLinking({ ...linking, kind, direction });
                      }}
                      aria-label={t('tk.linkKind')}
                    >
                      {LINK_KINDS.flatMap((k) =>
                        (k === 'relates' ? ['out'] : ['out', 'in']).map((d) => (
                          <option key={`${k}.${d}`} value={`${k}.${d}`}>
                            {t(`tk.link.${k}.${d}` as MessageKey)}
                          </option>
                        )),
                      )}
                    </select>
                    <input
                      autoFocus
                      list="tk-link-keys"
                      value={linking.key}
                      placeholder={t('tk.linkPh')}
                      onChange={(e) => setLinking({ ...linking, key: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setLinking(null);
                        if (e.key !== 'Enter' || !linking.key.trim()) return;
                        const key = linking.key.trim().split(/\s/)[0]!;
                        void tapi
                          .link(tk.id, {
                            kind: linking.kind,
                            direction: linking.direction,
                            targetKey: key,
                          })
                          .then(
                            () => {
                              setLinking(null);
                              void load();
                            },
                            (er) => toast(errMsg(er)),
                          );
                      }}
                    />
                    <datalist id="tk-link-keys">
                      {(others ?? [])
                        .filter((x) => x.id !== tk.id)
                        .slice(0, 300)
                        .map((x) => (
                          <option key={x.id} value={`${x.key} ${x.title}`} />
                        ))}
                    </datalist>
                    <button
                      className="ico sm"
                      aria-label={t('common.cancel')}
                      onClick={() => setLinking(null)}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </div>
                )}
              </div>
            </section>
          )}

          {(tk.documents.length > 0 || docQuery !== null) && (
            <section className="tk-sec">
              <h3 className="tk-sh">{t('tk.docs')}</h3>
              <div className="tk-box">
                {tk.documents.map((d) => (
                  <div key={d.id + d.source} className="tk-row">
                    <Icon
                      name={docIcon(d.type)}
                      className={d.type === 'whiteboard' ? 't-board' : undefined}
                    />
                    <Link to={`/d/${d.id}`} className="nm">
                      {d.title || t('common.untitled')}
                    </Link>
                    <span className="muted st">
                      {d.source === 'mention' ? t('tk.doc.mention') : t('tk.doc.manual')}
                    </span>
                    {edit && d.source === 'manual' && (
                      <button
                        className="ico sm"
                        aria-label={t('tk.unlink')}
                        onClick={() =>
                          void tapi.unlinkDocument(tk.id, d.id).then(load, (e) => toast(errMsg(e)))
                        }
                      >
                        <Icon name="x" size={11} />
                      </button>
                    )}
                  </div>
                ))}
                {docQuery !== null && (
                  <div className="tk-docpick">
                    <input
                      autoFocus
                      value={docQuery}
                      placeholder={t('tk.docPh')}
                      onChange={(e) => setDocQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Escape' && setDocQuery(null)}
                    />
                    {docHits.map((d) => (
                      <button
                        key={d.id}
                        onClick={() =>
                          void tapi.linkDocument(tk.id, d.id).then(
                            () => {
                              setDocQuery(null);
                              void load();
                            },
                            (e) => toast(errMsg(e)),
                          )
                        }
                      >
                        <Icon name={docIcon(d.type)} size={13} />
                        {d.title || t('common.untitled')}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {tk.attachments.length > 0 && (
            <section className="tk-sec">
              <h3 className="tk-sh">{t('tk.attachments')}</h3>
              <div className="tk-files">
                {tk.attachments.map((f) => (
                  <div key={f.id} className="tk-file">
                    {f.mime.startsWith('image/') ? (
                      <img src={f.url} alt="" />
                    ) : (
                      <Icon name="doc" size={22} />
                    )}
                    <a href={f.url} target="_blank" rel="noreferrer" title={f.filename}>
                      {f.filename}
                    </a>
                    {edit && (
                      <button
                        className="ico sm"
                        aria-label={t('tk.removeFile')}
                        onClick={() =>
                          void tapi.deleteUpload(tk.id, f.id).then(load, (e) => toast(errMsg(e)))
                        }
                      >
                        <Icon name="x" size={11} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="tk-sec">
            <div className="tk-tabs" role="tablist">
              {(['all', 'comments', 'history'] as const).map((k) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={tab === k}
                  className={tab === k ? 'on' : ''}
                  onClick={() => setTab(k)}
                >
                  {t(`tk.tab.${k}` as MessageKey)}
                  {k === 'comments' && tk.comments.length > 0 && ` ${tk.comments.length}`}
                </button>
              ))}
            </div>
            <div className="tk-activity">
              {activity.map((a) => (
                <div key={a.key}>{a.node}</div>
              ))}
            </div>
            {tk.canComment && (
              <div className="tk-composer">
                <MentionInput
                  className="field-in"
                  value={comment}
                  onValue={setComment}
                  loadPeople={people}
                  placeholder={t('tk.commentPh')}
                  aria-label={t('tk.commentPh')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <button
                  className="btn primary"
                  disabled={!comment.trim()}
                  onClick={() => void send()}
                >
                  {t('tk.send')}
                </button>
              </div>
            )}
          </section>
        </div>

        <aside className="tk-dside">
          <div className="tk-statusrow">
            {val(
              'status',
              <>
                <StatusDot status={status} />
                {status?.name}
                <Icon name="down" size={10} />
              </>,
            )}
            {edit &&
              nextStatuses.map((s) => (
                <button key={s.id} className="btn sm" onClick={() => setStatus(s.id)}>
                  → {s.name}
                </button>
              ))}
          </div>
          {status?.category === 'done' && tk.resolution && (
            <Prop label={t('tk.f.resolution')}>
              {val('resolution', t(`tk.res.${tk.resolution}` as MessageKey))}
            </Prop>
          )}
          <Prop label={t('tk.f.assignee')}>
            {val(
              'assignee',
              <>
                <UserChip user={tk.assignee} />
                {tk.assignee?.name ?? t('tk.unassigned')}
              </>,
              { empty: !tk.assignee },
            )}
            {edit && !tk.assignee && (
              <button
                className="tk-link"
                onClick={() => {
                  if (session) void patch({ assigneeId: session.user.id });
                }}
              >
                {t('tk.assignMe')}
              </button>
            )}
          </Prop>
          <Prop label={t('tk.f.reporter')}>
            {val(
              'reporter',
              <>
                <UserChip user={tk.reporter} />
                {tk.reporter?.name ?? t('tk.none')}
              </>,
            )}
          </Prop>
          <Prop label={t('tk.f.watchers')}>
            {val(
              'watchers',
              tk.watchers.length ? (
                <span className="tk-avs">
                  {tk.watchers.slice(0, 5).map((w) => (
                    <UserChip key={w.id} user={w} />
                  ))}
                  {tk.watchers.length > 5 && (
                    <span className="muted">+{tk.watchers.length - 5}</span>
                  )}
                </span>
              ) : (
                t('tk.none')
              ),
              { empty: !tk.watchers.length },
            )}
          </Prop>
          {parentTypes && (
            <Prop label={tk.type === 'subtask' ? t('tk.f.parent') : t('tk.f.epic')}>
              {val(
                'parent',
                tk.parent ? (
                  <>
                    <TypeIcon type={tk.parent.type} />
                    <span className="tk-key">{tk.parent.key}</span>
                    <span className="ell">{tk.parent.title}</span>
                  </>
                ) : (
                  t('tk.none')
                ),
                { empty: !tk.parent },
              )}
            </Prop>
          )}
          {project.usesSprints && sprintable(tk.type) && (
            <Prop label={t('tk.f.sprint')}>
              {val(
                'sprint',
                sprint ? (
                  <>
                    {sprint.name}
                    {sprint.state === 'active' && (
                      <span className="tk-badge">{t('tk.sprint.active')}</span>
                    )}
                  </>
                ) : (
                  t('tk.backlog')
                ),
                { empty: !sprint },
              )}
            </Prop>
          )}
          {tk.type !== 'epic' && (
            <Prop label={t('tk.f.points')}>
              {edit ? (
                <input
                  className="tk-inline"
                  type="number"
                  min={0}
                  step={0.5}
                  key={`p${tk.storyPoints}`}
                  defaultValue={tk.storyPoints ?? ''}
                  aria-label={t('tk.f.points')}
                  onBlur={(e) => {
                    const n = e.target.value === '' ? null : Number(e.target.value);
                    if (n !== tk.storyPoints) void patch({ storyPoints: n });
                  }}
                />
              ) : (
                <span className="tk-val ro">{tk.storyPoints ?? t('tk.none')}</span>
              )}
            </Prop>
          )}
          <Prop label={t('tk.f.priority')}>
            {val(
              'priority',
              <>
                <PriorityIcon priority={tk.priority} />
                {t(priorityKey(tk.priority))}
              </>,
            )}
          </Prop>
          <Prop label={t('tk.f.labels')}>
            {val(
              'labels',
              tk.labelIds.length
                ? project.labels
                    .filter((l) => tk.labelIds.includes(l.id))
                    .map((l) => (
                      <span
                        key={l.id}
                        className="tk-label"
                        style={{ background: l.color + '22', color: l.color }}
                      >
                        {l.name}
                      </span>
                    ))
                : t('tk.none'),
              { empty: !tk.labelIds.length },
            )}
          </Prop>
          <Prop label={t('tk.f.dates')}>
            {edit ? (
              <span className="tk-dates">
                <input
                  className="tk-inline"
                  type="date"
                  value={tk.startDate ?? ''}
                  aria-label={t('tk.f.start')}
                  onChange={(e) => void patch({ startDate: e.target.value || null })}
                />
                →
                <input
                  className="tk-inline"
                  type="date"
                  value={tk.dueDate ?? ''}
                  aria-label={t('tk.f.due')}
                  onChange={(e) => void patch({ dueDate: e.target.value || null })}
                />
              </span>
            ) : (
              <span className="tk-val ro">
                {tk.startDate || tk.dueDate
                  ? `${fmtDate(tk.startDate, lang) || '…'} → ${fmtDate(tk.dueDate, lang) || '…'}`
                  : t('tk.none')}
              </span>
            )}
          </Prop>
          <Prop label={t('tk.f.time')}>
            <TimeField tk={tk} edit={edit} onSave={(p) => void patch(p)} />
          </Prop>
          {fieldsFor.length > 0 && <div className="tk-dside-sec">{t('tk.customFields')}</div>}
          {fieldsFor.map((f) => (
            <Prop key={f.id} label={f.name}>
              {fieldEditor(f)}
            </Prop>
          ))}
          <div className="tk-meta muted">
            {t('tk.createdBy', {
              name: tk.reporter?.name ?? t('tk.someone'),
              time: ago(tk.createdAt),
            })}
            <br />
            {t('tk.updated', { time: ago(tk.updatedAt) })}
          </div>
        </aside>
      </div>

      {pk.open?.key === 'status' && (
        <Picker
          anchor={pk.open.el}
          options={project.statuses
            .filter(
              (s) =>
                !project.restrictTransitions ||
                s.id === tk.statusId ||
                project.transitions.some((x) => x.fromId === tk.statusId && x.toId === s.id),
            )
            .map((s) => ({ id: s.id, label: s.name, icon: <StatusDot status={s} /> }))}
          value={tk.statusId}
          onPick={(id) => id !== tk.statusId && setStatus(id)}
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
          value={tk.type}
          onPick={(id) => void patch({ type: id as TicketType })}
          onClose={pk.close}
        />
      )}
      {pk.open?.key === 'assignee' && (
        <Picker
          anchor={pk.open.el}
          search
          options={memberOpts()}
          value={tk.assignee?.id ?? ''}
          onPick={(id) => void patch({ assigneeId: id || null })}
          onClose={pk.close}
        />
      )}
      {pk.open?.key === 'reporter' && (
        <Picker
          anchor={pk.open.el}
          search
          options={memberOpts()}
          value={tk.reporter?.id ?? ''}
          onPick={(id) => void patch({ reporterId: id || null })}
          onClose={pk.close}
        />
      )}
      {pk.open?.key === 'watchers' && (
        <Picker
          anchor={pk.open.el}
          multi
          search
          options={memberOpts(false)}
          value={tk.watchers.map((w) => w.id)}
          onPick={(id) =>
            void tapi
              .setWatcher(tk.id, id, !tk.watchers.some((w) => w.id === id))
              .then(load, (e) => toast(errMsg(e)))
          }
          onClose={pk.close}
        />
      )}
      {pk.open?.key === 'priority' && (
        <Picker
          anchor={pk.open.el}
          options={[...PRIORITIES]
            .reverse()
            .map((p) => ({ id: p, label: t(priorityKey(p)), icon: <PriorityIcon priority={p} /> }))}
          value={tk.priority}
          onPick={(id) => void patch({ priority: id as TicketPatch['priority'] })}
          onClose={pk.close}
        />
      )}
      {pk.open?.key === 'parent' && (
        <Picker
          anchor={pk.open.el}
          search
          options={[
            ...(tk.type === 'subtask' ? [] : [{ id: '', label: t('tk.none') }]),
            ...parentOptions.map((x) => ({
              id: x.id,
              label: x.title,
              hint: x.key,
              keywords: x.key,
              icon: <TypeIcon type={x.type} />,
            })),
          ]}
          value={tk.parentId ?? ''}
          onPick={(id) => void patch({ parentId: id || null })}
          onClose={pk.close}
        />
      )}
      {pk.open?.key === 'sprint' && (
        <Picker
          anchor={pk.open.el}
          options={[
            { id: '', label: t('tk.backlog') },
            ...sprints
              .filter((s) => s.state !== 'closed')
              .map((s) => ({
                id: s.id,
                label: s.name,
                hint: s.state === 'active' ? t('tk.sprint.active') : undefined,
              })),
          ]}
          value={tk.sprintId ?? ''}
          onPick={(id) => void patch({ sprintId: id || null })}
          onClose={pk.close}
        />
      )}
      {pk.open?.key === 'resolution' && (
        <Picker
          anchor={pk.open.el}
          options={RESOLUTIONS.map((r) => ({ id: r, label: t(`tk.res.${r}` as MessageKey) }))}
          value={tk.resolution}
          onPick={(id) => void patch({ resolution: id as TicketPatch['resolution'] })}
          onClose={pk.close}
        />
      )}
      {pk.open?.key === 'labels' && (
        <LabelPicker
          anchor={pk.open.el}
          project={project}
          value={tk.labelIds}
          onChange={(ids) => void patch({ labelIds: ids })}
          onCreated={() => forgetProjectMeta(project.id)}
          onClose={pk.close}
          reloadMeta={async () => {
            forgetProjectMeta(project.id);
            setMeta(await loadMeta(project.id));
          }}
        />
      )}
      {openField && (
        <Picker
          anchor={pk.open!.el}
          multi={openField.kind === 'multi_select'}
          search={openField.kind === 'user'}
          options={
            openField.kind === 'user'
              ? memberOpts()
              : [
                  ...(openField.kind === 'select' ? [{ id: '', label: t('tk.none') }] : []),
                  ...openField.options.map((o) => ({
                    id: o.id,
                    label: o.label,
                    icon: <span className="tk-swatch" style={{ background: o.color }} />,
                  })),
                ]
          }
          value={
            (tk.fields[openField.id] as string | string[] | undefined) ??
            (openField.kind === 'multi_select' ? [] : '')
          }
          onPick={(id) => {
            if (openField.kind === 'multi_select') {
              const cur = (tk.fields[openField.id] as string[] | undefined) ?? [];
              void patch({
                fields: {
                  [openField.id]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
                },
              });
            } else void patch({ fields: { [openField.id]: id || null } });
          }}
          onClose={pk.close}
        />
      )}
      {askResolution && (
        <ResolutionDialog
          onCancel={() => setAskResolution(null)}
          onPick={(r) => {
            const statusId = askResolution;
            setAskResolution(null);
            void patch({ statusId, resolution: r });
          }}
        />
      )}
      {menu.node}
    </div>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tk-prop">
      <span className="k">{label}</span>
      <span className="v">{children}</span>
    </div>
  );
}

function TimeField({
  tk,
  edit,
  onSave,
}: {
  tk: TicketDTO;
  edit: boolean;
  onSave(p: TicketPatch): void;
}) {
  const { t } = useI18n();
  const pct = useMemo(
    () =>
      tk.estimateMinutes && tk.spentMinutes
        ? Math.min(100, (tk.spentMinutes / tk.estimateMinutes) * 100)
        : 0,
    [tk],
  );
  const over = !!tk.estimateMinutes && (tk.spentMinutes ?? 0) > tk.estimateMinutes;
  return (
    <span className="tk-time">
      {tk.estimateMinutes || tk.spentMinutes ? (
        <span className="tk-progress wide">
          <i className={over ? 'over' : ''} style={{ width: `${over ? 100 : pct}%` }} />
        </span>
      ) : null}
      {edit ? (
        <span className="tk-time-in">
          <input
            className="tk-inline"
            key={`s${tk.spentMinutes}`}
            defaultValue={fmtMinutes(tk.spentMinutes)}
            placeholder={t('tk.time.spent')}
            aria-label={t('tk.time.spent')}
            onBlur={(e) => {
              const m = parseMinutes(e.target.value);
              if (m !== tk.spentMinutes) onSave({ spentMinutes: m });
            }}
          />
          /
          <input
            className="tk-inline"
            key={`e${tk.estimateMinutes}`}
            defaultValue={fmtMinutes(tk.estimateMinutes)}
            placeholder={t('tk.time.estimate')}
            aria-label={t('tk.time.estimate')}
            onBlur={(e) => {
              const m = parseMinutes(e.target.value);
              if (m !== tk.estimateMinutes) onSave({ estimateMinutes: m });
            }}
          />
        </span>
      ) : (
        <span className="muted">
          {t('tk.time.summary', {
            spent: fmtMinutes(tk.spentMinutes) || '0',
            estimate: fmtMinutes(tk.estimateMinutes) || '—',
          })}
        </span>
      )}
    </span>
  );
}

/** Labels: pick existing ones or type a new name to create it. */
export function LabelPicker({
  anchor,
  project,
  value,
  onChange,
  onClose,
  onCreated,
  reloadMeta,
}: {
  anchor: HTMLElement;
  project: ProjectDTO;
  value: string[];
  onChange(ids: string[]): void;
  onClose(): void;
  onCreated?(): void;
  reloadMeta?(): Promise<void>;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState('');
  return (
    <Picker
      anchor={anchor}
      multi
      search={project.labels.length > 8}
      options={project.labels.map((l) => ({
        id: l.id,
        label: l.name,
        icon: <span className="tk-swatch" style={{ background: l.color }} />,
      }))}
      value={value}
      onPick={(id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])}
      onClose={onClose}
      footer={
        project.canEdit ? (
          <form
            className="tk-picker-new"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              const colors = [
                '#3b7dd8',
                '#1e6b2a',
                '#c2410c',
                '#7c3aed',
                '#e8a317',
                '#0e7490',
                '#be185d',
              ];
              void tapi
                .addLabel(project.id, name.trim(), colors[project.labels.length % colors.length])
                .then(
                  async (l) => {
                    setName('');
                    onCreated?.();
                    await reloadMeta?.();
                    onChange([...value, l.id]);
                  },
                  (er) => toast(errMsg(er)),
                );
            }}
          >
            <input
              value={name}
              placeholder={t('tk.label.newPh')}
              onChange={(e) => setName(e.target.value)}
              aria-label={t('tk.label.newPh')}
            />
            <button className="btn sm" disabled={!name.trim()}>
              {t('tk.label.add')}
            </button>
          </form>
        ) : null
      }
    />
  );
}

import { useEffect, useRef, useState } from 'react';
import type { ActivityDTO, CommentAnchor, CommentThreadDTO, UserDTO } from '../api/types';
import { useAgo, useT, type MessageKey } from '../i18n';
import { Icon } from './Icon';
import { Avatar } from './Menu';
import { MentionInput, type LoadPeople } from './MentionInput';

export interface Draft {
  anchor: CommentAnchor | null;
}

/** Anonymous share-link visitor commenting under a nickname. */
export interface GuestIdentity {
  name: string;
  setName(name: string): void;
}

const VERB: Record<ActivityDTO['kind'], MessageKey> = {
  created: 'activity.created',
  edited: 'activity.edited',
  commented: 'activity.commented',
  resolved: 'activity.resolved',
  shared: 'activity.shared',
  version: 'activity.version',
  restored: 'activity.restored',
  moved: 'activity.moved',
  renamed: 'activity.renamed',
};

/** Renders "@name" mentions with the mockup's mention style. */
function Body({ text }: { text: string }) {
  const parts = text.split(/(@[\p{L}\p{N}_.-]+)/u);
  return <p>{parts.map((p, i) => (p.startsWith('@') && p.length > 1 ? <span key={i} className="mention">{p}</span> : p))}</p>;
}

export function CommentsPanel({
  me,
  guest,
  threads,
  activity,
  activeId,
  draft,
  canComment,
  onActivate,
  onCreate,
  onCancelDraft,
  onReply,
  onResolve,
  onDelete,
  onClose,
  onShowInDoc,
  onActivityTab,
  loadPeople,
}: {
  /** people who can be @mentioned (signed-in commenters only) */
  loadPeople?: LoadPeople;
  me: UserDTO | null;
  /** set for anonymous visitors who may comment */
  guest: GuestIdentity | null;
  threads: CommentThreadDTO[];
  activity: ActivityDTO[] | null;
  activeId: string | null;
  draft: Draft | null;
  canComment: boolean;
  onActivate(id: string): void;
  onCreate(body: string): Promise<void>;
  onCancelDraft(): void;
  onReply(threadId: string, body: string): Promise<void>;
  onResolve(threadId: string, resolved: boolean): Promise<void>;
  onDelete(commentId: string): Promise<void>;
  onClose(): void;
  /** Phones: the panel covers the page, so a thread's quote offers a way back to its text. */
  onShowInDoc?(threadId: string): void;
  onActivityTab(): void;
}) {
  const t = useT();
  const ago = useAgo();
  const [tab, setTab] = useState<'c' | 'a'>('c');
  const [filter, setFilter] = useState<'open' | 'all' | 'mine'>('open');
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (draft || activeId) setTab('c');
  }, [draft, activeId]);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeId]);

  const mine = (th: CommentThreadDTO) =>
    me
      ? th.comments.some((c) => c.author.id === me.id || c.body.includes('@' + me.name))
      : th.comments.some((c) => c.guest && c.canDelete);
  const author = me ? { name: me.name, color: me.color } : guest ? { name: guest.name.trim() || t('comments.guest'), color: undefined } : null;
  // Guests need a nickname before they can send.
  const ready = !!me || !!guest?.name.trim();
  const nameRef = useRef<HTMLInputElement>(null);
  const needName = () => nameRef.current?.focus();
  const shown = threads.filter((th) => (filter === 'open' ? !th.resolved : filter === 'mine' ? mine(th) : true));
  const openCount = threads.filter((th) => !th.resolved).length;

  return (
    <aside className="panel" aria-label={t('comments.panel')}>
      <div className="ptabs">
        <button className={tab === 'c' ? 'on' : ''} onClick={() => setTab('c')}>
          {t('comments.tab')} <span style={{ color: 'var(--fg-3)' }}>{openCount}</span>
        </button>
        <button
          className={tab === 'a' ? 'on' : ''}
          onClick={() => {
            setTab('a');
            onActivityTab();
          }}
        >
          {t('comments.activity')}
        </button>
        <button className="ico x" aria-label={t('comments.closePanel')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {tab === 'c' ? (
        <div className="pbody">
          <div className="filter" role="group" aria-label={t('comments.filter')}>
            {(
              [
                ['open', t('comments.open')],
                ['all', t('comments.all')],
                ['mine', t('comments.mine')],
              ] as const
            ).map(([k, l]) => (
              <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
                {l}
              </button>
            ))}
          </div>
          {guest && canComment && (
            <div className="guest-name">
              <input
                ref={nameRef}
                value={guest.name}
                maxLength={40}
                placeholder={t('comments.guestName')}
                aria-label={t('comments.guestName')}
                onChange={(e) => guest.setName(e.target.value)}
              />
              <small>{t('comments.guestNameHint')}</small>
            </div>
          )}
          {draft && author && (
            <DraftCard author={author} draft={draft} ready={ready} onNeedName={needName} onCreate={onCreate} onCancel={onCancelDraft} loadPeople={loadPeople} />
          )}
          {shown.length === 0 && !draft && (
            <p style={{ color: 'var(--fg-3)', fontSize: 13, margin: '8px 2px' }}>
              {canComment ? t('comments.hint') : t('comments.none')}
            </p>
          )}
          {shown.map((th) => (
            <div
              key={th.id}
              data-thread-id={th.id}
              ref={th.id === activeId ? activeRef : undefined}
              className={'thread' + (th.id === activeId ? ' active' : '') + (th.resolved ? ' resolved' : '')}
              onClick={() => onActivate(th.id)}
            >
              {th.resolved && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-3)' }}>
                  <Icon name="check" size={13} />
                  {t('comments.resolvedBy', { name: th.resolvedBy?.name ?? '' })}
                </div>
              )}
              {th.anchor?.quote && <div className="quote">{th.anchor.quote}</div>}
              {th.anchor?.quote && onShowInDoc && (
                <button
                  className="show-in-doc phone-only"
                  onClick={(e) => {
                    e.stopPropagation();
                    onShowInDoc(th.id);
                  }}
                >
                  {t('comments.showInDoc')}
                </button>
              )}
              {th.comments.map((c) => (
                <div className="cm" key={c.id}>
                  <Avatar sm name={c.author.name} color={c.author.color} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="who">
                      {c.author.name}
                      {c.guest && <span className="guest-tag">{t('comments.guest')}</span>}
                      <time dateTime={c.createdAt}>{ago(c.createdAt)}</time>
                      {c.canDelete && (
                        <button
                          className="ico cm-del"
                          title={t('comments.delete')}
                          aria-label={t('comments.delete')}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(t('comments.confirmDelete'))) void onDelete(c.id);
                          }}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      )}
                    </div>
                    <Body text={c.body} />
                  </div>
                </div>
              ))}
              {canComment && (
                <ReplyBox thread={th} ready={ready} onNeedName={needName} onReply={onReply} onResolve={me ? onResolve : undefined} loadPeople={loadPeople} />
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="pbody">
          <div className="feed">
            {!activity && <p style={{ color: 'var(--fg-3)' }}>{t('activity.loading')}</p>}
            {activity?.length === 0 && <p style={{ color: 'var(--fg-3)' }}>{t('activity.none')}</p>}
            {activity?.map((a) => (
              <div className="ev" key={a.id}>
                <Avatar sm name={a.actor?.name ?? '?'} color={a.actor?.color} />
                <div>
                  <b>{a.actor?.name ?? t('activity.someone')}</b> {VERB[a.kind] ? t(VERB[a.kind]) : a.kind}
                  {a.detail ? ` “${a.detail}”` : ''}
                  <time dateTime={a.createdAt}>{ago(a.createdAt)}</time>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function DraftCard({
  author,
  draft,
  ready,
  onNeedName,
  onCreate,
  onCancel,
  loadPeople,
}: {
  loadPeople?: LoadPeople;
  author: { name: string; color?: string };
  draft: Draft;
  ready: boolean;
  onNeedName(): void;
  onCreate(b: string): Promise<void>;
  onCancel(): void;
}) {
  const t = useT();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!body.trim() || busy) return;
    if (!ready) return onNeedName();
    setBusy(true);
    try {
      await onCreate(body.trim());
    } finally {
      setBusy(false);
    }
  };
  const q = draft.anchor?.quote ?? '';
  return (
    <div className="thread draft active">
      {q && <div className="quote">{q.length > 60 ? q.slice(0, 60) + '…' : q}</div>}
      <div className="cm">
        <Avatar sm name={author.name} color={author.color} />
        <div className="who">
          {author.name}
          <time>{t('comments.new')}</time>
        </div>
      </div>
      <div className="reply">
        <MentionInput
          autoFocus={ready}
          placeholder={t('comments.placeholder')}
          value={body}
          onValue={setBody}
          loadPeople={loadPeople}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send();
            if (e.key === 'Escape') onCancel();
          }}
        />
        <button className="btn primary" style={{ padding: '3px 10px', fontSize: 12 }} disabled={!body.trim() || busy} onClick={send}>
          {t('comments.send')}
        </button>
      </div>
    </div>
  );
}

function ReplyBox({
  thread,
  ready,
  onNeedName,
  onReply,
  onResolve,
  loadPeople,
}: {
  loadPeople?: LoadPeople;
  thread: CommentThreadDTO;
  ready: boolean;
  onNeedName(): void;
  onReply(id: string, b: string): Promise<void>;
  /** absent for guests, who cannot resolve threads */
  onResolve?(id: string, r: boolean): Promise<void>;
}) {
  const t = useT();
  const [body, setBody] = useState('');
  const send = async () => {
    if (!body.trim()) return;
    if (!ready) return onNeedName();
    const b = body.trim();
    setBody('');
    await onReply(thread.id, b);
  };
  return (
    <div className="reply" onClick={(e) => e.stopPropagation()}>
      <MentionInput
        placeholder={t('comments.reply')}
        value={body}
        aria-label={t('comments.replyLabel')}
        onValue={setBody}
        loadPeople={loadPeople}
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void send()}
      />
      {onResolve && (
        <button
          className="ico"
          title={thread.resolved ? t('comments.reopen') : t('comments.resolve')}
          aria-label={thread.resolved ? t('comments.reopen') : t('comments.resolve')}
          onClick={() => onResolve(thread.id, !thread.resolved)}
        >
          <Icon name={thread.resolved ? 'restore' : 'check'} />
        </button>
      )}
    </div>
  );
}

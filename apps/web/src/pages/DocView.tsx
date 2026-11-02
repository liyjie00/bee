import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { BeeEditor, BeeWhiteboard, blockLink, type BeeUser, type CollabStatus, type Editor } from '@bee/editor';
import { can, parseBlockFragment } from '@bee/shared';
import { api } from '../api/http';
import type { ActivityDTO, CommentAnchor, CommentThreadDTO, DocumentDTO, UserDTO } from '../api/types';
import { CommentsPanel, type Draft } from '../components/CommentsPanel';
import { Icon } from '../components/Icon';
import { Avatar } from '../components/Menu';
import { ShareDialog, accessOf, type Access } from '../components/ShareDialog';
import { TopBar, type Crumb } from '../components/TopBar';
import { Toolbar } from '../components/Toolbar';
import { useAgo, useI18n } from '../i18n';
import { copyText, errMsg, useToast } from '../state/toast';

type Status = CollabStatus;
type Presence = BeeUser;

export const collabUrl = () => `${location.origin.replace(/^http/, 'ws')}/collab`;
const ACCESS_ICON = { private: 'lock', link: 'link', public: 'globe' } as const;
const guestColor = '#7b8375';

export function DocView({
  doc,
  me,
  crumbs,
  shareToken,
  onTitle,
  onCreateWhiteboard,
}: {
  doc: DocumentDTO;
  me: UserDTO | null;
  crumbs: Crumb[];
  shareToken?: string;
  onTitle?(title: string): void;
  onCreateWhiteboard?(): Promise<{ documentId: string }>;
}) {
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const { t, lang } = useI18n();
  const ago = useAgo();
  const editorRef = useRef<Editor | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [presence, setPresence] = useState<Presence[]>([]);
  const [threads, setThreads] = useState<CommentThreadDTO[]>([]);
  const [activity, setActivity] = useState<ActivityDTO[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [panel, setPanel] = useState(() => innerWidth > 1180);
  const [share, setShare] = useState(false);
  const [access, setAccess] = useState<Access>('private');
  const [title, setTitle] = useState(doc.title);
  const [words, setWords] = useState(0);

  const editable = can.edit(doc.role);
  const canComment = can.comment(doc.role) && !!me;
  const isBoard = doc.type === 'whiteboard';
  const user = useMemo(
    () => (me ? { id: me.id, name: me.name, color: me.color } : { id: 'guest', name: 'Guest', color: guestColor }),
    [me],
  );

  useEffect(() => setTitle(doc.title), [doc.id, doc.title]);
  useEffect(() => {
    setThreads([]);
    setActivity(null);
    setDraft(null);
    setActiveId(null);
    setStatus('connecting');
    if (isBoard) return;
    api.threads(doc.id).then(setThreads, () => {});
    if (can.manage(doc.role)) api.sharing(doc.id).then((s) => setAccess(accessOf(s)), () => {});
  }, [doc.id, doc.role, isBoard]);

  // Title: debounce PATCH while typing.
  useEffect(() => {
    if (!editable || title === doc.title) return;
    const t = setTimeout(() => {
      api.updateDocument(doc.id, { title }).then((d) => onTitle?.(d.title), (e) => toast(errMsg(e)));
    }, 500);
    return () => clearTimeout(t);
  }, [title]);

  // Word count follows the editor content.
  useEffect(() => {
    if (!editor) return;
    const count = () => setWords(countWords(editor.state.doc.textContent));
    count();
    editor.on('update', count);
    return () => {
      editor.off('update', count);
    };
  }, [editor]);

  // Block anchor links (#b-<id>): the editor scrolls to and highlights the block once synced.
  const initialBlockId = parseBlockFragment(loc.hash);

  const comments = useMemo(
    () => threads.filter((t) => t.anchor).map((t) => ({ id: t.id, anchor: t.anchor!, resolved: t.resolved })),
    [threads],
  );

  async function createThread(body: string) {
    if (!draft) return;
    try {
      const t = await api.createThread(doc.id, draft.anchor, body);
      setThreads((ts) => [t, ...ts]);
      setDraft(null);
      setActiveId(t.id);
    } catch (e) {
      toast(errMsg(e));
    }
  }
  async function reply(id: string, body: string) {
    try {
      await api.reply(id, body);
      setThreads(await api.threads(doc.id));
    } catch (e) {
      toast(errMsg(e));
    }
  }
  async function resolve(id: string, resolved: boolean) {
    try {
      const t = await api.setResolved(id, resolved);
      setThreads((ts) => ts.map((x) => (x.id === id ? { ...x, ...t } : x)));
    } catch (e) {
      toast(errMsg(e));
    }
  }

  const others = presence.filter((p) => p.id !== user.id);
  const showPanel = panel && !isBoard;

  return (
    <>
      <main className="main">
        <TopBar crumbs={crumbs}>
          <span className="saved hide-sm" title={status}>
            <i style={{ background: status === 'synced' ? '#3fa34d' : status === 'disconnected' ? 'var(--del-ink)' : 'var(--honey)' }} />
            {t(`status.${status}`)}
          </span>
          <div className="presence hide-sm" aria-label={t('doc.online')}>
            {others.slice(0, 5).map((p, i) => (
              <Avatar key={(p.id ?? '') + i} name={p.name} color={p.color} />
            ))}
            {me && <Avatar name={me.name} color={me.color} />}
          </div>
          {!shareToken && !isBoard && (
            <button className="ico" aria-label={t('doc.history')} title={t('doc.history')} onClick={() => nav(`/d/${doc.id}/history`)}>
              <Icon name="clock" />
            </button>
          )}
          {!isBoard && (
            <button className={'ico' + (showPanel ? ' on' : '')} aria-label={t('doc.comments')} title={t('doc.comments')} onClick={() => setPanel((p) => !p)}>
              <Icon name="chat" />
            </button>
          )}
          {shareToken && !me && (
            <Link className="btn" to={`/login?next=${encodeURIComponent(loc.pathname + loc.hash)}`}>
              {t('common.signIn')}
            </Link>
          )}
          {!shareToken && (
            <button className="btn primary" onClick={() => setShare(true)}>
              <Icon name={ACCESS_ICON[access]} />
              {t('doc.share')}
            </button>
          )}
        </TopBar>

        {isBoard ? (
          <section className="view" style={{ overflow: 'hidden', position: 'relative' }}>
            <div className="wb-host">
              <BeeWhiteboard key={doc.id} documentId={doc.id} collabUrl={collabUrl()} shareToken={shareToken} user={user} editable={editable} locale={lang} onStatus={setStatus} />
            </div>
          </section>
        ) : (
          <section className="view">
            {editable && <Toolbar editor={editor} onUploadImage={(f) => api.upload(doc.id, f).then((r) => r.url)} />}
            <article className="page">
              {editable ? (
                <input
                  className="doc-title-in"
                  value={title}
                  placeholder={t('common.untitled')}
                  aria-label={t('doc.title')}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const ed = editorRef.current;
                      // focus after the key event settles, otherwise the input keeps focus
                      if (ed) setTimeout(() => ed.chain().focus('start').run(), 0);
                    }
                  }}
                />
              ) : (
                <h1 className="doc-title">{doc.title || t('common.untitled')}</h1>
              )}
              <div className="doc-meta">
                <span className="tag">
                  <Icon name={ACCESS_ICON[access]} size={12} />
                  {shareToken ? t('doc.viaLink') : t(`access.${access}`)}
                </span>
                <span>
                  {t('doc.createdBy', { name: doc.owner.name })}
                  {doc.lastEditedBy ? t('doc.lastEdit', { time: ago(doc.updatedAt), name: doc.lastEditedBy.name }) : ''}
                </span>
                <span>{t('doc.words', { n: words.toLocaleString(lang) })}</span>
                {!editable && <span className="tag">{canComment ? t('doc.canComment') : t('doc.readOnly')}</span>}
              </div>
              {status === 'disconnected' && <div className="notice">{t('doc.offline')}</div>}
              <div className="prose">
                <BeeEditor
                  key={doc.id}
                  documentId={doc.id}
                  collabUrl={collabUrl()}
                  shareToken={shareToken}
                  user={user}
                  editable={editable}
                  canComment={canComment}
                  locale={lang}
                  initialBlockId={initialBlockId}
                  onBlockMissing={() => toast(t('doc.blockGone'))}
                  comments={comments}
                  activeCommentId={activeId}
                  onCommentClick={(id: string) => {
                    setActiveId(id);
                    setPanel(true);
                  }}
                  onCreateComment={(anchor: CommentAnchor) => {
                    setDraft({ anchor });
                    setActiveId(null);
                    setPanel(true);
                  }}
                  onCopyBlockLink={async (blockId: string) => {
                    const url = shareToken
                      ? `${location.origin}/s/${shareToken}#b-${blockId}`
                      : blockLink(location.origin, doc.id, blockId);
                    toast((await copyText(url)) ? t('doc.blockLinkCopied') : url);
                  }}
                  uploadImage={(file: File) => api.upload(doc.id, file).then((r) => r.url)}
                  createWhiteboard={editable ? onCreateWhiteboard : undefined}
                  onOpenWhiteboard={(id: string) => nav(shareToken ? `/s/${shareToken}/d/${id}` : `/d/${id}`)}
                  onReady={(ed: Editor) => {
                    editorRef.current = ed;
                    setEditor(ed);
                  }}
                  onStatus={setStatus}
                  onPresence={setPresence}
                />
              </div>
            </article>
          </section>
        )}
      </main>
      {showPanel && (
        <CommentsPanel
          me={me}
          threads={threads}
          activity={activity}
          activeId={activeId}
          draft={draft}
          canComment={canComment}
          onActivate={setActiveId}
          onCreate={createThread}
          onCancelDraft={() => setDraft(null)}
          onReply={reply}
          onResolve={resolve}
          onClose={() => setPanel(false)}
          onActivityTab={() => api.activity(doc.id).then(setActivity, () => setActivity([]))}
        />
      )}
      {share && <ShareDialog doc={doc} onClose={() => setShare(false)} onChange={setAccess} />}
    </>
  );
}

/** CJK characters count one each; other scripts count by whitespace-separated words. */
export function countWords(text: string): number {
  const cjk = text.match(/[㐀-鿿豈-﫿]/g)?.length ?? 0;
  const rest = text.replace(/[㐀-鿿豈-﫿]/g, ' ').trim();
  return cjk + (rest ? rest.split(/\s+/).length : 0);
}

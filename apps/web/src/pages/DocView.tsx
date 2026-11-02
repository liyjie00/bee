import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { BeeEditor, BeeWhiteboard, beeDocUrl, blockLink, type BeeUser, type LinkTarget, type CollabStatus, type Editor, type WhiteboardHandle } from '@bee/editor';
import { can, parseBlockFragment } from '@bee/shared';
import { api, guestName, HttpError } from '../api/http';
import type { ActivityDTO, CommentAnchor, CommentThreadDTO, DocumentDTO, UserDTO } from '../api/types';
import { AskAiPanel } from '../components/AskAiPanel';
import { CommentConnector } from '../components/CommentConnector';
import { CommentsPanel, type Draft, type GuestIdentity } from '../components/CommentsPanel';
import { DocOutline } from '../components/DocOutline';
import { Icon } from '../components/Icon';
import { Avatar, useMenu, type MenuEntry } from '../components/Menu';
import { ShareDialog, accessOf, type Access } from '../components/ShareDialog';
import { TopBar, type Crumb } from '../components/TopBar';
import { Toolbar } from '../components/Toolbar';
import { useAgo, useI18n } from '../i18n';
import { copyText, errMsg, useToast } from '../state/toast';
import { takeDocState } from '../lib/doc-cache';
import { collabUrl } from '../lib/collab';
import { useLists } from '../state/lists';
import { fileName, pendingBoardImports, pickFile, saveBlob } from '../lib/download';
import { useSession, useTreeOrNull } from '../state/session';

type Status = CollabStatus;
type Presence = BeeUser;

const ACCESS_ICON = { private: 'lock', link: 'link', public: 'globe' } as const;
const guestColor = '#7b8375';

/** Dev builds only: `localStorage['bee.cursorIdleMs']` shortens the idle-caret threshold for testing. */
function devCursorIdleMs(): number | undefined {
  if (!import.meta.env.DEV) return undefined;
  try {
    const ms = Number(localStorage.getItem('bee.cursorIdleMs'));
    return ms > 0 ? ms : undefined;
  } catch {
    return undefined;
  }
}

export function DocView({
  doc,
  me,
  crumbs,
  shareToken,
  onTitle,
  onCreateWhiteboard,
  onPickWhiteboard,
  whiteboardTitle,
}: {
  doc: DocumentDTO;
  me: UserDTO | null;
  crumbs: Crumb[];
  shareToken?: string;
  onTitle?(title: string): void;
  onCreateWhiteboard?(): Promise<{ documentId: string }>;
  onPickWhiteboard?(): Promise<{ documentId: string } | null>;
  whiteboardTitle?(documentId: string): string | undefined;
}) {
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const { t, lang } = useI18n();
  const ago = useAgo();
  const editorRef = useRef<Editor | null>(null);
  const viewRef = useRef<HTMLElement | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [presence, setPresence] = useState<Presence[]>([]);
  const [threads, setThreads] = useState<CommentThreadDTO[]>([]);
  const [activity, setActivity] = useState<ActivityDTO[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [panel, setPanel] = useState(() => innerWidth > 1180);
  const [ai, setAi] = useState(false);
  const openComments = () => {
    setAi(false);
    setPanel(true);
  };
  const [share, setShare] = useState(false);
  const [access, setAccess] = useState<Access>('private');
  const [title, setTitle] = useState(doc.title);
  const [words, setWords] = useState(0);
  const lists = useLists();
  const docMenu = useMenu();
  const { workspace } = useSession();
  const member = !!me && !shareToken && workspace?.id === doc.workspaceId;
  const boardRef = useRef<WhiteboardHandle | null>(null);
  const onBoardHandle = useCallback(
    (h: WhiteboardHandle | null) => {
      boardRef.current = h;
      // "New › Import .excalidraw" opened this board with a file to load.
      const file = h && pendingBoardImports.get(doc.id);
      if (h && file) {
        pendingBoardImports.delete(doc.id);
        h.importScene(file).catch((e) => toast(errMsg(e)));
      }
    },
    [doc.id],
  );
  const exportOpts = useRef({ background: true, onlySelected: false });
  const tree = useTreeOrNull();
  const searchDocs = useMemo(
    () =>
      member && workspace
        ? async (q: string): Promise<LinkTarget[]> => {
            const hint = (folderId: string | null) => (folderId ? tree?.folder(folderId)?.name : undefined);
            const docs = q ? (await api.search(workspace.id, q)).map((r) => r.document) : (lists?.recent ?? []);
            return docs.filter((d) => d.id !== doc.id).map((d) => ({ id: d.id, title: d.title, hint: hint(d.folderId) }));
          }
        : undefined,
    [member, workspace?.id, doc.id, lists?.recent, tree],
  );
  const resolveLink = useCallback(async (url: URL): Promise<string | null> => {
    const m = /^\/(?:s\/([\w-]+)(?:\/d\/([0-9a-f-]{36}))?|d\/([0-9a-f-]{36}))/i.exec(url.pathname);
    if (!m) return null;
    try {
      let id = m[3] ?? m[2];
      if (!id && m[1]) id = (await api.resolveShare(m[1])).document.id;
      if (!id) return null;
      const p = await api.linkPreview(id, parseBlockFragment(url.hash));
      const name = p.title || t('common.untitled');
      return p.section ? `${name} › ${p.section}` : name;
    } catch {
      return null; // no access: keep the address, never leak the title
    }
  }, [lang]);
  const onOpenLink = useCallback(
    (href: string) => {
      const u = beeDocUrl(href);
      if (!u || shareToken) return false;
      nav(u.pathname + u.search + u.hash);
      return true;
    },
    [shareToken],
  );
  const canStar = !!lists && !!me && !shareToken;
  const starred = !!lists?.isStarred(doc.id);
  const toggleStar = () => lists?.setStar({ ...doc, title }, !starred).catch((e) => toast(errMsg(e)));

  const loadSnapshot = useMemo(() => () => takeDocState(doc.id), [doc.id]);
  const editable = can.edit(doc.role);
  // Anonymous visitors get commenter only through a public link with guest comments on.
  const isGuest = !me && !!shareToken;
  const canComment = can.comment(doc.role) && (!!me || isGuest);
  const isBoard = doc.type === 'whiteboard';
  const [nick, setNick] = useState(guestName.get);
  const guest: GuestIdentity | null = isGuest ? { name: nick, setName: setNick } : null;
  const user = useMemo(
    () =>
      me
        ? { id: me.id, name: me.name, color: me.color }
        : { id: 'guest', name: guestName.get() || t('comments.guest'), color: guestColor },
    [me],
  );
  const loadPeople = useMemo(() => (me ? (q: string) => api.mentionable(doc.id, q) : undefined), [me, doc.id]);
  const commentError = (e: unknown) =>
    toast(e instanceof HttpError && e.status === 429 ? t('comments.rateLimited') : errMsg(e));
  /** nickname to send with a guest comment, remembered for next time */
  const guestNick = () => {
    if (!isGuest) return undefined;
    const n = nick.trim();
    guestName.set(n);
    return n;
  };

  useEffect(() => setTitle(doc.title), [doc.id, doc.title]);
  // Back from "Sign in with OpenRouter" without a popup: reopen Ask AI.
  useEffect(() => {
    const q = new URLSearchParams(loc.search);
    const r = q.get('ai');
    if (!r) return;
    setAi(true);
    toast(r === 'connected' ? t('ai.connectedToast') : t('ai.signInFailed'));
    q.delete('ai');
    nav({ search: q.toString(), hash: loc.hash }, { replace: true });
  }, [loc.search]);
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

  // From a notification (?comment=<threadId>): open that thread once the threads are in.
  const wantThread = new URLSearchParams(loc.search).get('comment');
  useEffect(() => {
    if (!wantThread || !threads.some((th) => th.id === wantThread)) return;
    setActiveId(wantThread);
    openComments();
    requestAnimationFrame(() =>
      document.querySelector(`.prose [data-comment-id="${CSS.escape(wantThread)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    );
    const q = new URLSearchParams(loc.search);
    q.delete('comment');
    nav({ search: q.toString(), hash: loc.hash }, { replace: true });
  }, [wantThread, threads]);

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
      const t = await api.createThread(doc.id, draft.anchor, body, guestNick());
      setThreads((ts) => [t, ...ts]);
      setDraft(null);
      setActiveId(t.id);
    } catch (e) {
      commentError(e);
    }
  }
  async function reply(id: string, body: string) {
    try {
      await api.reply(id, body, guestNick());
      setThreads(await api.threads(doc.id));
    } catch (e) {
      commentError(e);
    }
  }
  async function deleteComment(id: string) {
    try {
      await api.deleteComment(id);
      setThreads(await api.threads(doc.id));
      toast(t('comments.deleted'));
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

  const run = (fn: () => Promise<void>) => () => {
    fn().catch((e) => toast(errMsg(e)));
  };
  const name = title || t('common.untitled');
  const moreItems = (): MenuEntry[] => {
    const own: MenuEntry[] = member
      ? [
          {
            label: isBoard ? t('docmenu.dupBoard') : t('docmenu.dup'),
            icon: 'copy',
            onSelect: run(async () => {
              const d = await api.duplicateDocument(doc.id);
              toast(t('docmenu.duplicated', { name: d.title }));
              nav(`/d/${d.id}`);
            }),
          },
          ...(!isBoard
            ? [
                {
                  label: t('docmenu.saveTemplate'),
                  icon: 'note' as const,
                  onSelect: run(async () => {
                    const tp = await api.saveTemplate(doc.id, title || undefined);
                    toast(t('docmenu.templateSaved', { name: tp.title }));
                  }),
                },
              ]
            : []),
          '-',
        ]
      : [];
    if (isBoard) {
      const image = (type: 'png' | 'jpeg') =>
        run(async () => {
          const blob = await boardRef.current?.exportImage(type, exportOpts.current);
          if (!blob) return toast(t('docmenu.boardEmpty'));
          saveBlob(blob, fileName(name, type === 'png' ? 'png' : 'jpg'));
        });
      return [
        ...own,
        { caption: t('docmenu.exportImage') },
        { label: 'PNG', icon: 'image', hint: '.png', onSelect: image('png') },
        { label: 'JPG', icon: 'image', hint: '.jpg', onSelect: image('jpeg') },
        { label: t('docmenu.withBackground'), checked: exportOpts.current.background, onSelect: () => (exportOpts.current.background = !exportOpts.current.background) },
        { label: t('docmenu.onlySelected'), checked: exportOpts.current.onlySelected, onSelect: () => (exportOpts.current.onlySelected = !exportOpts.current.onlySelected) },
        '-',
        { caption: t('docmenu.rawFile') },
        {
          label: t('docmenu.downloadRaw'),
          icon: 'down',
          hint: '.excalidraw',
          onSelect: () => {
            const json = boardRef.current?.exportScene();
            if (json) saveBlob(new Blob([json], { type: 'application/json' }), fileName(name, 'excalidraw'));
          },
        },
        ...(editable
          ? [
              {
                label: t('docmenu.importRaw'),
                icon: 'restore' as const,
                hint: '.excalidraw',
                onSelect: run(async () => {
                  const f = await pickFile('.excalidraw,application/json');
                  if (f) await boardRef.current?.importScene(f);
                }),
              },
            ]
          : []),
      ];
    }
    return [
      ...own,
      { caption: t('docmenu.export') },
      { label: 'Markdown', icon: 'code', hint: '.md', onSelect: run(async () => saveBlob(await api.exportMarkdown(doc.id), fileName(name, 'md'))) },
      {
        label: 'Word',
        icon: 'doc',
        hint: '.docx',
        onSelect: run(async () => {
          const ed = editorRef.current;
          if (!ed) return;
          const { toDocx } = await import('../lib/docx');
          saveBlob(await toDocx(title, ed.getJSON()), fileName(name, 'docx'));
        }),
      },
      { label: t('docmenu.pdf'), icon: 'doc', hint: '⌘P', onSelect: () => window.print() },
    ];
  };

  const others = presence.filter((p) => p.id !== user.id);
  // Ask AI needs a Bee account: it runs with the user's own AI account and permissions.
  const canAi = !!me;
  const showAi = ai && canAi;
  const showPanel = panel && !isBoard && !showAi;
  const openThreads = threads.filter((th) => !th.resolved).length;

  return (
    <>
      <main className="main">
        <TopBar
          crumbs={crumbs}
          phoneMenu={[
            ...(canStar ? [{ label: starred ? t('star.remove') : t('star.add'), icon: 'star' as const, onSelect: toggleStar }] : []),
            ...(!shareToken && !isBoard ? [{ label: t('doc.history'), icon: 'clock' as const, onSelect: () => nav(`/d/${doc.id}/history`) }] : []),
            ...(status !== 'denied' ? moreItems() : []),
          ]}
        >
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
            <button className="ico hide-phone" aria-label={t('doc.history')} title={t('doc.history')} onClick={() => nav(`/d/${doc.id}/history`)}>
              <Icon name="clock" />
            </button>
          )}
          {canAi && (
            <button className={'ico ai-btn' + (showAi ? ' on' : '')} aria-label={t('ai.open')} title={t('ai.open')} onClick={() => setAi((a) => !a)}>
              <Icon name="spark" />
            </button>
          )}
          {!isBoard && (
            <button className={'ico' + (showPanel ? ' on' : '')} aria-label={t('doc.comments')} title={t('doc.comments')} onClick={() => (showPanel ? setPanel(false) : openComments())}>
              <Icon name="chat" />
              {openThreads > 0 && <span className="ico-badge">{openThreads}</span>}
            </button>
          )}
          {status !== 'denied' && (
            <button className="ico hide-phone" aria-label={t('docmenu.more')} title={t('docmenu.more')} onClick={(e) => docMenu.open(e, moreItems())}>
              <Icon name="more" />
            </button>
          )}
          {shareToken && !me && (
            <Link className="btn" to={`/login?next=${encodeURIComponent(loc.pathname + loc.hash)}`}>
              {t('common.signIn')}
            </Link>
          )}
          {!shareToken && (
            <button className="btn primary" aria-label={t('doc.share')} onClick={() => setShare(true)}>
              <Icon name={ACCESS_ICON[access]} />
              <span className="hide-sm">{t('doc.share')}</span>
            </button>
          )}
        </TopBar>

        {doc.deletedAt && (
          <div className="hbanner">
            <Icon name="trash" />
            <span>{t('doc.inTrash')}</span>
            <span className="spacer" />
            {can.manage(doc.role) && (
              <button
                className="btn primary"
                onClick={() => api.restoreDocument(doc.id).then(() => location.reload(), (e) => toast(errMsg(e)))}
              >
                <Icon name="restore" />
                {t('tree.restore')}
              </button>
            )}
          </div>
        )}
        {status === 'denied' ? (
          <div className="empty">
            <h2>{t('doc.noAccess')}</h2>
            <p style={{ margin: 0 }}>{t('doc.noAccessHint')}</p>
          </div>
        ) : isBoard ? (
          <section className="view" style={{ overflow: 'hidden', position: 'relative' }}>
            <div className="wb-host">
              <BeeWhiteboard key={doc.id} onHandle={onBoardHandle} documentId={doc.id} collabUrl={collabUrl()} shareToken={shareToken} loadSnapshot={loadSnapshot} user={user} editable={editable} locale={lang} onStatus={setStatus} />
            </div>
          </section>
        ) : (
          <div className="doc-stage">
          {editor && <DocOutline editor={editor} viewRef={viewRef} />}
          <section className="view" ref={viewRef}>
            {editable && <Toolbar editor={editor} onUploadImage={(f) => api.upload(doc.id, f).then((r) => r.url)} />}
            <article className="page">
              <div className={'doc-title-row' + (canStar ? ' has-star' : '')}>
              {canStar && (
                <button
                  className={'ico doc-star' + (starred ? ' on' : '')}
                  aria-label={starred ? t('star.remove') : t('star.add')}
                  aria-pressed={starred}
                  title={starred ? t('star.remove') : t('star.add')}
                  onClick={toggleStar}
                >
                  <Icon name="star" size={20} />
                </button>
              )}
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
              </div>
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
                  loadSnapshot={loadSnapshot}
                  user={user}
                  editable={editable}
                  canComment={canComment}
                  locale={lang}
                  initialBlockId={initialBlockId}
                  cursorIdleMs={devCursorIdleMs()}
                  onBlockMissing={() => toast(t('doc.blockGone'))}
                  comments={comments}
                  activeCommentId={activeId}
                  onCommentClick={(id: string) => {
                    setActiveId(id);
                    openComments();
                  }}
                  onCreateComment={(anchor: CommentAnchor) => {
                    setDraft({ anchor });
                    setActiveId(null);
                    openComments();
                  }}
                  onCopyBlockLink={async (blockId: string) => {
                    const url = shareToken
                      ? `${location.origin}/s/${shareToken}#b-${blockId}`
                      : blockLink(location.origin, doc.id, blockId);
                    toast((await copyText(url)) ? t('doc.blockLinkCopied') : url);
                  }}
                  uploadImage={(file: File) => api.upload(doc.id, file).then((r) => r.url)}
                  searchDocs={searchDocs}
                  resolveLink={member ? resolveLink : undefined}
                  onOpenLink={onOpenLink}
                  createWhiteboard={editable ? onCreateWhiteboard : undefined}
                  pickWhiteboard={editable ? onPickWhiteboard : undefined}
                  whiteboardTitle={whiteboardTitle}
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
          </div>
        )}
      </main>
      {showPanel && (
        <CommentsPanel
          me={me}
          guest={guest}
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
          onDelete={deleteComment}
          onClose={() => setPanel(false)}
          onShowInDoc={(id) => {
            setActiveId(id);
            setPanel(false);
            requestAnimationFrame(() =>
              document.querySelector(`.prose [data-comment-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
            );
          }}
          onActivityTab={() => api.activity(doc.id).then(setActivity, () => setActivity([]))}
          loadPeople={loadPeople}
        />
      )}
      {showPanel && !isBoard && <CommentConnector activeId={activeId} />}
      {showAi && <AskAiPanel documentId={doc.id} onClose={() => setAi(false)} />}
      {docMenu.node}
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

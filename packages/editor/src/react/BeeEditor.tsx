import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import type * as Y from 'yjs';
import { BubbleMenu } from '@tiptap/react/menus';
import { NodeSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from 'react';
import { buildExtensions } from './extensions.js';
import { presentUsers, useCollabConnection, type BeeUser, type CollabConnection, type CollabStatus, type LoadSnapshot } from './collab.js';
import { createAnchor, type CommentAnchor, type CommentHighlight } from './comments.js';
import { blockAtCoords, blockLink, scrollToBlock } from './blocks.js';
import { insertImages, type UploadImage } from './image-upload.js';
import { MessagesContext, resolveMessages, type Locale, type Messages } from './i18n.js';
import { BeeEditorContext, type BeeEditorContextValue } from './context.js';
import { SheetDocContext } from './sheet/SheetView.js';
import type { SlashHost } from './SlashMenu.js';
import { TableToolbar } from './TableToolbar.js';
import type { Theme } from './theme.js';

export interface BeeEditorProps {
  documentId: string;
  /** e.g. `${location.origin.replace(/^http/, 'ws')}/collab` */
  collabUrl: string;
  /** Token of a public share link; omitted for signed-in access via cookie. */
  shareToken?: string;
  /** Stored Yjs state fetched over HTTP, rendered before the collab sync completes. */
  loadSnapshot?: LoadSnapshot;
  user: BeeUser;
  /** owner / editor */
  editable: boolean;
  /** owner / editor / commenter */
  canComment: boolean;
  locale?: Locale;
  /** Theme for embeds (whiteboards, diagrams); defaults to `<html data-theme>`, then the OS. */
  theme?: Theme;
  messages?: Partial<Messages>;
  placeholder?: string;
  comments?: CommentHighlight[];
  activeCommentId?: string | null;
  onCommentClick?: (id: string) => void;
  /** Called with the anchor of the current selection when "Comment" is pressed. */
  onCreateComment?: (anchor: CommentAnchor) => void;
  /** Uploads an image and resolves to its URL. Enables paste/drop/slash image insertion. */
  uploadImage?: UploadImage;
  onUploadError?: (err: unknown) => void;
  /** Creates a whiteboard document and resolves to its id. Enables the whiteboard block. */
  createWhiteboard?: () => Promise<{ documentId: string }>;
  onOpenWhiteboard?: (documentId: string) => void;
  /**
   * Lets the user pick an existing whiteboard and resolves to its id (null when cancelled); it is
   * embedded read-only and live. Enables the "existing whiteboard" block.
   */
  pickWhiteboard?: () => Promise<{ documentId: string } | null>;
  /** Title shown on a linked whiteboard's header. */
  whiteboardTitle?: (documentId: string) => string | undefined;
  /** Overrides copying the block link to the clipboard. */
  onCopyBlockLink?: (blockId: string, url: string) => void;
  /** Block to scroll to once the document has synced (from `#b-<blockId>`). */
  initialBlockId?: string | null;
  /** Called when `initialBlockId` is not in the document. */
  onBlockMissing?: (blockId: string) => void;
  onReady?: (editor: Editor) => void;
  onStatus?: (status: CollabStatus) => void;
  onPresence?: (users: BeeUser[]) => void;
  /** Hide collaborators' carets after this many ms without movement (default 10 minutes). */
  cursorIdleMs?: number;
  className?: string;
}

/** The collaborative Bee document editor. */
export function BeeEditor(props: BeeEditorProps) {
  const statusRef = useRef(props.onStatus);
  statusRef.current = props.onStatus;
  // Tracked per Y.Doc: a connection's first events can arrive before the render that shows it.
  const [syncedDoc, setSyncedDoc] = useState<Y.Doc | null>(null);
  const [snapshotDoc, setSnapshotDoc] = useState<Y.Doc | null>(null);
  const onStatus = useCallback((s: CollabStatus, ydoc: Y.Doc) => {
    if (s === 'synced') setSyncedDoc(ydoc);
    statusRef.current?.(s);
  }, []);
  const conn = useCollabConnection(props.documentId, props.collabUrl, props.shareToken, onStatus, props.loadSnapshot, setSnapshotDoc);
  const synced = !!conn && syncedDoc === conn.ydoc;
  // Content is real once either the HTTP snapshot or the first sync has arrived; until then the
  // document would look empty, so it is neither shown as such nor editable.
  const ready = synced || (!!conn && snapshotDoc === conn.ydoc);

  const messages = useMemo(() => resolveMessages(props.locale, props.messages), [props.locale, props.messages]);
  return (
    <MessagesContext.Provider value={messages}>
      {conn ? (
        <EditorInner
          {...props}
          key={`${conn.ydoc.guid}:${props.editable}`}
          conn={conn}
          synced={synced}
          ready={ready}
          messages={messages}
        />
      ) : (
        <div className={`bee-editor is-loading ${props.className ?? ''}`} />
      )}
    </MessagesContext.Provider>
  );
}

interface InnerProps extends Omit<BeeEditorProps, 'messages'> {
  conn: CollabConnection;
  synced: boolean;
  ready: boolean;
  messages: Messages;
}

function EditorInner(props: InnerProps) {
  const { conn, synced, ready, messages: t, editable, canComment } = props;
  const latest = useRef(props);
  latest.current = props;
  const fileInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);

  const slash = useMemo<SlashHost>(
    () => ({
      messages: () => latest.current.messages,
      canPickImage: () => !!latest.current.uploadImage,
      pickImage: () => fileInput.current?.click(),
      canCreateWhiteboard: () => !!latest.current.createWhiteboard,
      createWhiteboard: () => {
        const editor = editorRef.current;
        const create = latest.current.createWhiteboard;
        if (!editor || !create) return;
        void create().then(({ documentId }) => {
          if (!editor.isDestroyed) editor.chain().focus().insertWhiteboard({ documentId }).run();
        });
      },
      canLinkWhiteboard: () => !!latest.current.pickWhiteboard,
      linkWhiteboard: () => {
        const editor = editorRef.current;
        const pick = latest.current.pickWhiteboard;
        if (!editor || !pick) return;
        // Remember where to insert: the picker takes focus away from the editor.
        const at = editor.state.selection.from;
        void pick().then((r) => {
          if (!r || editor.isDestroyed) return;
          const pos = Math.min(at, editor.state.doc.content.size);
          editor.chain().focus(pos).insertWhiteboard({ documentId: r.documentId, linked: true }).run();
        });
      },
    }),
    [],
  );

  const extensions = useMemo(
    () =>
      buildExtensions({
        ydoc: conn.ydoc,
        provider: conn.provider,
        user: props.user,
        editable,
        placeholder: editable ? (props.placeholder ?? t.placeholder) : undefined,
        slash,
        uploadImage: props.uploadImage ? (file) => latest.current.uploadImage!(file) : undefined,
        onUploadError: (err) => latest.current.onUploadError?.(err),
        onCommentClick: (id) => latest.current.onCommentClick?.(id),
        cursorIdleMs: props.cursorIdleMs,
        shareToken: props.shareToken,
      }),
    // The editor is rebuilt per connection / editability (see the key in BeeEditor).
    [],
  );

  const editor = useEditor({
    extensions,
    editable: editable && ready,
    immediatelyRender: false,
    editorProps: { attributes: { class: 'bee-prose', spellcheck: 'true' } },
  });
  editorRef.current = editor;

  useEffect(() => {
    if (editor) latest.current.onReady?.(editor);
  }, [editor]);

  useEffect(() => {
    if (editor && !editor.isDestroyed && editor.isEditable !== (editable && ready)) editor.setEditable(editable && ready);
  }, [editor, editable, ready]);

  // Keep the caret label in sync with the user.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.updateUser?.(props.user);
  }, [editor, props.user]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.setComments(props.comments ?? [], props.activeCommentId ?? null);
  }, [editor, props.comments, props.activeCommentId, ready, synced]);

  // Presence list.
  useEffect(() => {
    const awareness = conn.provider.awareness;
    if (!awareness) return;
    const update = () => latest.current.onPresence?.(presentUsers(conn.provider));
    awareness.on('change', update);
    update();
    return () => awareness.off('change', update);
  }, [conn]);

  // Scroll to the linked block once content has arrived.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const blockId = props.initialBlockId;
    if (!editor || !synced || !blockId || scrolledFor.current === blockId) return;
    scrolledFor.current = blockId;
    // Let the synced content render first.
    setTimeout(() => {
      if (!editor.isDestroyed && !scrollToBlock(editor, blockId)) latest.current.onBlockMissing?.(blockId);
    }, 50);
  }, [editor, synced, props.initialBlockId]);

  const ctx = useMemo<BeeEditorContextValue>(
    () => ({
      documentId: props.documentId,
      collabUrl: props.collabUrl,
      shareToken: props.shareToken,
      user: props.user,
      editable,
      locale: props.locale ?? 'en',
      theme: props.theme,
      onOpenWhiteboard: props.onOpenWhiteboard,
      whiteboardTitle: props.whiteboardTitle,
    }),
    [props.documentId, props.collabUrl, props.shareToken, props.user, editable, props.locale, props.theme, props.onOpenWhiteboard, props.whiteboardTitle],
  );

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (editor && props.uploadImage) void insertImages(editor, files, props.uploadImage, undefined, props.onUploadError);
  };

  return (
    <BeeEditorContext.Provider value={ctx}>
      <SheetDocContext.Provider value={conn.ydoc}>
      <div className={`bee-editor${ready ? '' : ' is-loading'} ${props.className ?? ''}`} aria-busy={!ready}>
        {editor && <SelectionBubble editor={editor} editable={editable} canComment={canComment} messages={t} onComment={props.onCreateComment} />}
        {editor && editable && <TableToolbar editor={editor} messages={t} />}
        {editor && <BlockLinkButton editor={editor} messages={t} documentId={props.documentId} shareToken={props.shareToken} onCopy={props.onCopyBlockLink} />}
        <EditorContent editor={editor} className="bee-editor-content" />
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={onFile} />
      </div>
      </SheetDocContext.Provider>
    </BeeEditorContext.Provider>
  );
}

function SelectionBubble({
  editor,
  editable,
  canComment,
  messages: t,
  onComment,
}: {
  editor: Editor;
  editable: boolean;
  canComment: boolean;
  messages: Messages;
  onComment?: (anchor: CommentAnchor) => void;
}) {
  const showComment = canComment && !!onComment;
  const [coarse] = useState(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const href = window.prompt(t.linkPrompt, prev ?? 'https://');
    if (href === null) return;
    if (href === '') editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  };
  const btn = (active: boolean, label: string, onClick: () => void, content: React.ReactNode) => (
    <button
      type="button"
      className={active ? 'is-active' : undefined}
      title={label}
      aria-label={label}
      onMouseDown={(e: MouseEvent) => e.preventDefault()}
      onClick={onClick}
    >
      {content}
    </button>
  );

  return (
    <BubbleMenu
      editor={editor}
      className="bee-bubble"
      // Touch screens put their own copy/paste menu above the selection: show ours below it.
      options={coarse ? { placement: 'bottom', offset: 28 } : undefined}
      shouldShow={({ editor: ed, state, from, to }) => {
        if (from === to || !(editable || showComment)) return false;
        if (state.selection instanceof NodeSelection) return false;
        // Selected table cells get the table toolbar instead.
        if (state.selection instanceof CellSelection) return false;
        if (state.selection.$from.parent.type.name === 'codeBlock') return false;
        return ed.view.hasFocus() || !editable;
      }}
    >
      {editable && (
        <>
          {btn(editor.isActive('bold'), t.bold, () => editor.chain().focus().toggleBold().run(), <b>B</b>)}
          {btn(editor.isActive('italic'), t.italic, () => editor.chain().focus().toggleItalic().run(), <i>I</i>)}
          {btn(editor.isActive('strike'), t.strike, () => editor.chain().focus().toggleStrike().run(), <s>S</s>)}
          {btn(editor.isActive('code'), t.code, () => editor.chain().focus().toggleCode().run(), <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}><path d="M5 4.5 1.5 8 5 11.5M11 4.5l3.5 3.5-3.5 3.5M9.2 3 6.8 13" /></svg>)}
          {btn(editor.isActive('link'), t.link, setLink, <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>)}
        </>
      )}
      {editable && showComment && <span className="bee-bubble-sep" />}
      {showComment && (
        <button
          type="button"
          className="bee-bubble-comment"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const anchor = createAnchor(editor);
            if (!anchor) return;
            // Collapse the selection so the bubble hides while the comment is written in the panel.
            editor.commands.setTextSelection(editor.state.selection.to);
            onComment!(anchor);
          }}
        >
          💬 {t.comment}
        </button>
      )}
    </BubbleMenu>
  );
}

function BlockLinkButton({
  editor,
  messages: t,
  documentId,
  shareToken,
  onCopy,
}: {
  editor: Editor;
  messages: Messages;
  documentId: string;
  shareToken?: string;
  onCopy?: (blockId: string, url: string) => void;
}) {
  const [target, setTarget] = useState<{ blockId: string; top: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const root = editor.view.dom as HTMLElement;
    const wrapper = root.closest('.bee-editor') as HTMLElement | null;
    if (!wrapper) return;
    const onMove = (e: globalThis.MouseEvent) => {
      if ((e.target as HTMLElement).closest('.bee-block-link')) {
        // Reaching the button crosses the gap left of the text, which may have started a hide timer.
        clearTimeout(hideTimer.current);
        return;
      }
      const content = root.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX, content.left + 8), content.right - 8);
      const hit = blockAtCoords(editor.view, x, e.clientY);
      clearTimeout(hideTimer.current);
      if (!hit) {
        hideTimer.current = setTimeout(() => setTarget(null), 300);
        return;
      }
      const rect = hit.dom.getBoundingClientRect();
      const base = wrapper.getBoundingClientRect();
      setTarget((prev) => (prev?.blockId === hit.blockId ? prev : { blockId: hit.blockId, top: rect.top - base.top + Math.min(rect.height, 28) / 2 }));
      setCopied(false);
    };
    const onLeave = () => {
      hideTimer.current = setTimeout(() => setTarget(null), 300);
    };
    wrapper.addEventListener('mousemove', onMove);
    wrapper.addEventListener('mouseleave', onLeave);
    return () => {
      wrapper.removeEventListener('mousemove', onMove);
      wrapper.removeEventListener('mouseleave', onLeave);
      clearTimeout(hideTimer.current);
    };
  }, [editor]);

  if (!target) return null;
  const copy = async () => {
    const url = blockLink(window.location.origin, documentId, target.blockId, shareToken);
    if (onCopy) onCopy(target.blockId, url);
    else await navigator.clipboard?.writeText(url);
    setCopied(true);
  };
  return (
    <button
      type="button"
      className={`bee-block-link${copied ? ' is-copied' : ''}`}
      style={{ top: target.top }}
      title={copied ? t.copied : t.copyBlockLink}
      aria-label={t.copyBlockLink}
      onMouseEnter={() => clearTimeout(hideTimer.current)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={copy}
    >
      {copied ? '✓' : '#'}
    </button>
  );
}

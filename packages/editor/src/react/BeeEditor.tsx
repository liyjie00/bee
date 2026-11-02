import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { NodeSelection } from '@tiptap/pm/state';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from 'react';
import { buildExtensions } from './extensions.js';
import { presentUsers, useCollabConnection, type BeeUser, type CollabConnection, type CollabStatus } from './collab.js';
import { createAnchor, type CommentAnchor, type CommentHighlight } from './comments.js';
import { blockAtCoords, blockLink, scrollToBlock } from './blocks.js';
import { insertImages, type UploadImage } from './image-upload.js';
import { MessagesContext, resolveMessages, type Locale, type Messages } from './i18n.js';
import { BeeEditorContext, type BeeEditorContextValue } from './context.js';
import type { SlashHost } from './SlashMenu.js';
import type { Theme } from './theme.js';

export interface BeeEditorProps {
  documentId: string;
  /** e.g. `${location.origin.replace(/^http/, 'ws')}/collab` */
  collabUrl: string;
  /** Token of a public share link; omitted for signed-in access via cookie. */
  shareToken?: string;
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
  const [synced, setSynced] = useState(false);
  const onStatus = useCallback((s: CollabStatus) => {
    if (s === 'synced') setSynced(true);
    statusRef.current?.(s);
  }, []);
  const conn = useCollabConnection(props.documentId, props.collabUrl, props.shareToken, onStatus);
  useEffect(() => setSynced(false), [conn]);

  const messages = useMemo(() => resolveMessages(props.locale, props.messages), [props.locale, props.messages]);
  return (
    <MessagesContext.Provider value={messages}>
      {conn ? (
        <EditorInner
          {...props}
          key={`${conn.ydoc.guid}:${props.editable}`}
          conn={conn}
          synced={synced}
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
  messages: Messages;
}

function EditorInner(props: InnerProps) {
  const { conn, synced, messages: t, editable, canComment } = props;
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
      }),
    // The editor is rebuilt per connection / editability (see the key in BeeEditor).
    [],
  );

  const editor = useEditor({
    extensions,
    editable,
    immediatelyRender: false,
    editorProps: { attributes: { class: 'bee-prose', spellcheck: 'true' } },
  });
  editorRef.current = editor;

  useEffect(() => {
    if (editor) latest.current.onReady?.(editor);
  }, [editor]);

  // Keep the caret label in sync with the user.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.updateUser?.(props.user);
  }, [editor, props.user]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.setComments(props.comments ?? [], props.activeCommentId ?? null);
  }, [editor, props.comments, props.activeCommentId, synced]);

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
    }),
    [props.documentId, props.collabUrl, props.shareToken, props.user, editable, props.locale, props.theme, props.onOpenWhiteboard],
  );

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (editor && props.uploadImage) void insertImages(editor, files, props.uploadImage, undefined, props.onUploadError);
  };

  return (
    <BeeEditorContext.Provider value={ctx}>
      <div className={`bee-editor ${props.className ?? ''}`}>
        {editor && <SelectionBubble editor={editor} editable={editable} canComment={canComment} messages={t} onComment={props.onCreateComment} />}
        {editor && <BlockLinkButton editor={editor} messages={t} documentId={props.documentId} shareToken={props.shareToken} onCopy={props.onCopyBlockLink} />}
        <EditorContent editor={editor} className="bee-editor-content" />
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={onFile} />
      </div>
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
      shouldShow={({ editor: ed, state, from, to }) => {
        if (from === to || !(editable || showComment)) return false;
        if (state.selection instanceof NodeSelection) return false;
        if (state.selection.$from.parent.type.name === 'codeBlock') return false;
        return ed.view.hasFocus() || !editable;
      }}
    >
      {editable && (
        <>
          {btn(editor.isActive('bold'), t.bold, () => editor.chain().focus().toggleBold().run(), <b>B</b>)}
          {btn(editor.isActive('italic'), t.italic, () => editor.chain().focus().toggleItalic().run(), <i>I</i>)}
          {btn(editor.isActive('strike'), t.strike, () => editor.chain().focus().toggleStrike().run(), <s>S</s>)}
          {btn(editor.isActive('code'), t.code, () => editor.chain().focus().toggleCode().run(), <code>{'`'}</code>)}
          {btn(editor.isActive('link'), t.link, setLink, <span>↗</span>)}
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
            if (anchor) onComment!(anchor);
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
      if ((e.target as HTMLElement).closest('.bee-block-link')) return;
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
      onMouseDown={(e) => e.preventDefault()}
      onClick={copy}
    >
      {copied ? '✓' : '#'}
    </button>
  );
}

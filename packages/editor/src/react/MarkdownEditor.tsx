import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { buildExtensions } from './extensions.js';
import { MessagesContext, resolveMessages, type Locale, type Messages } from './i18n.js';
import { BeeEditorContext, type BeeEditorContextValue } from './context.js';
import type { SlashHost } from './SlashMenu.js';
import { insertImages, type UploadImage } from './image-upload.js';
import { LinkPopover, type LinkHost, type LinkPopoverState, type LinkTarget } from './links.js';
import { Lightbox, type LightboxContent } from './Lightbox.js';
import { jsonToMarkdown } from '../markdown/to-markdown.js';
import { markdownToJSON } from '../markdown/from-markdown.js';
import type { JSONNode } from '../markdown/types.js';
import type { Theme } from './theme.js';

export interface BeeMarkdownEditorProps {
  /** Markdown shown when the editor mounts (later changes are ignored unless `resetKey` changes). */
  value: string;
  /** Re-reads `value` when this changes (e.g. someone else saved a newer version). */
  resetKey?: string | number;
  editable: boolean;
  /** Called with the new Markdown, at most every `debounceMs` (default 600) and on blur. */
  onChange?: (markdown: string) => void;
  debounceMs?: number;
  placeholder?: string;
  locale?: Locale;
  theme?: Theme;
  messages?: Partial<Messages>;
  uploadImage?: UploadImage;
  onUploadError?: (err: unknown) => void;
  searchDocs?: (q: string) => Promise<LinkTarget[]>;
  resolveLink?: (url: URL) => Promise<string | null>;
  onOpenLink?: (href: string) => boolean;
  onReady?: (editor: Editor) => void;
  className?: string;
}

const NO_USER = { id: null, name: '', color: '#888888' };

/**
 * A standalone rich-text editor that reads and writes Markdown (no collaboration), used for
 * ticket descriptions. Same schema, code blocks, math, images and links as documents.
 */
export function BeeMarkdownEditor(props: BeeMarkdownEditorProps) {
  const messages = useMemo(
    () => resolveMessages(props.locale, props.messages),
    [props.locale, props.messages],
  );
  return (
    <MessagesContext.Provider value={messages}>
      <Inner {...props} key={`${props.resetKey ?? ''}:${props.editable}`} messages={messages} />
    </MessagesContext.Provider>
  );
}

function Inner(props: Omit<BeeMarkdownEditorProps, 'messages'> & { messages: Messages }) {
  const latest = useRef(props);
  latest.current = props;
  const fileInput = useRef<HTMLInputElement>(null);
  const [lightbox, setLightbox] = useState<LightboxContent | null>(null);
  const [linkState, setLinkState] = useState<LinkPopoverState | null>(null);
  const lastSent = useRef(props.value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const links = useMemo<LinkHost>(
    () => ({
      open: (st) => setLinkState(st),
      resolve: (url) => latest.current.resolveLink?.(url) ?? Promise.resolve(null),
    }),
    [],
  );
  const slash = useMemo<SlashHost>(
    () => ({
      messages: () => latest.current.messages,
      newItems: () => [],
      onUsed: () => {},
      canPickImage: () => !!latest.current.uploadImage,
      pickImage: () => fileInput.current?.click(),
      canCreateWhiteboard: () => false,
      createWhiteboard: () => {},
      canLinkWhiteboard: () => false,
      linkWhiteboard: () => {},
    }),
    [],
  );
  const extensions = useMemo(
    () =>
      buildExtensions({
        links,
        editable: props.editable,
        placeholder: props.editable ? props.placeholder : undefined,
        slash,
        uploadImage: props.uploadImage ? (file) => latest.current.uploadImage!(file) : undefined,
        onUploadError: (err) => latest.current.onUploadError?.(err),
        openLightbox: setLightbox,
      }),
    [],
  );

  const flush = (editor: Editor) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (editor.isDestroyed) return;
    const md = jsonToMarkdown(editor.getJSON() as JSONNode).trim();
    if (md === lastSent.current.trim()) return;
    lastSent.current = md;
    latest.current.onChange?.(md);
  };

  const editor = useEditor({
    extensions,
    editable: props.editable,
    immediatelyRender: false,
    content: props.value.trim() ? markdownToJSON(props.value) : undefined,
    editorProps: { attributes: { class: 'bee-prose', spellcheck: 'true' } },
    onUpdate: ({ editor: e }) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => flush(e), latest.current.debounceMs ?? 600);
    },
    onBlur: ({ editor: e }) => flush(e),
  });

  useEffect(() => {
    if (editor) latest.current.onReady?.(editor);
    return () => {
      if (editor && timer.current) flush(editor);
    };
  }, [editor]);

  const ctx = useMemo<BeeEditorContextValue>(
    () => ({
      documentId: '',
      collabUrl: '',
      user: NO_USER,
      editable: props.editable,
      locale: props.locale ?? 'en',
      theme: props.theme,
      openLightbox: setLightbox,
    }),
    [props.editable, props.locale, props.theme],
  );

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (editor && props.uploadImage)
      void insertImages(editor, files, props.uploadImage, undefined, props.onUploadError);
  };

  return (
    <BeeEditorContext.Provider value={ctx}>
      <div className={`bee-editor bee-md-editor ${props.className ?? ''}`}>
        {editor && props.editable && (
          <LinkPopover
            editor={editor}
            messages={props.messages}
            state={linkState}
            setState={setLinkState}
            searchDocs={props.searchDocs}
            onOpenLink={props.onOpenLink}
          />
        )}
        <EditorContent editor={editor} className="bee-editor-content" />
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={onFile} />
        {lightbox && <Lightbox content={lightbox} onClose={() => setLightbox(null)} />}
      </div>
    </BeeEditorContext.Provider>
  );
}

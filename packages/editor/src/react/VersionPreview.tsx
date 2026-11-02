import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useMemo } from 'react';
import { buildExtensions } from './extensions.js';
import { yUpdateToJSON } from '../markdown/index.js';
import { MessagesContext, resolveMessages, type Locale, type Messages } from './i18n.js';

export interface BeeVersionPreviewProps {
  /** A version snapshot (standard Yjs update). */
  update: Uint8Array;
  locale?: Locale;
  messages?: Partial<Messages>;
  className?: string;
}

/** Read-only rendering of a version snapshot. */
export function BeeVersionPreview({ update, locale, messages, className }: BeeVersionPreviewProps) {
  const content = useMemo(() => yUpdateToJSON(update), [update]);
  const extensions = useMemo(() => buildExtensions({ editable: false }), []);
  const editor = useEditor(
    { extensions, content, editable: false, immediatelyRender: false, editorProps: { attributes: { class: 'bee-prose' } } },
    [content],
  );
  const t = useMemo(() => resolveMessages(locale, messages), [locale, messages]);
  return (
    <MessagesContext.Provider value={t}>
      <div className={`bee-editor bee-version-preview ${className ?? ''}`}>
        <EditorContent editor={editor} className="bee-editor-content" />
      </div>
    </MessagesContext.Provider>
  );
}

/**
 * Replaces the live document with a snapshot, as a normal collaborative edit. The server-side
 * restore (api -> collab) is preferred; this is for clients that restore locally.
 */
export function restoreVersion(editor: Editor, update: Uint8Array): boolean {
  return editor.commands.setContent(yUpdateToJSON(update));
}

import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { BeeWhiteboard } from './Whiteboard.js';
import { useBeeEditorContext } from './context.js';
import { useMessages } from './i18n.js';

/** Embedded whiteboard: a live view of a separate whiteboard document. */
export function WhiteboardView({ node, selected }: ReactNodeViewProps) {
  const ctx = useBeeEditorContext();
  const t = useMessages();
  const documentId = node.attrs.documentId as string | null;
  const height = Number(node.attrs.height) || 420;

  return (
    <NodeViewWrapper className={`bee-embed bee-embed-whiteboard${selected ? ' is-selected' : ''}`} data-drag-handle>
      <div className="bee-embed-header" contentEditable={false}>
        <span className="bee-embed-title">{t.whiteboardTitle}</span>
        {documentId && ctx?.onOpenWhiteboard && (
          <button type="button" className="bee-embed-action" onClick={() => ctx.onOpenWhiteboard!(documentId)}>
            {t.openWhiteboard}
          </button>
        )}
      </div>
      <div className="bee-embed-body" contentEditable={false} style={{ height }}>
        {documentId && ctx ? (
          <BeeWhiteboard
            documentId={documentId}
            collabUrl={ctx.collabUrl}
            shareToken={ctx.shareToken}
            user={ctx.user}
            editable={ctx.editable}
            locale={ctx.locale}
            theme={ctx.theme}
            embedded
          />
        ) : (
          <div className="bee-whiteboard-loading">{t.whiteboardMissing}</div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

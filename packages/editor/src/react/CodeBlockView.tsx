import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { MermaidPreview } from './Mermaid.js';
import { useMessages } from './i18n.js';
import { useBeeEditorContext } from './context.js';

const LANGUAGES: [string, string][] = [
  // '' and 'mermaid' are labelled from messages.
  ['bash', 'Bash'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['csharp', 'C#'],
  ['css', 'CSS'],
  ['diff', 'Diff'],
  ['go', 'Go'],
  ['java', 'Java'],
  ['javascript', 'JavaScript'],
  ['json', 'JSON'],
  ['kotlin', 'Kotlin'],
  ['markdown', 'Markdown'],
  ['php', 'PHP'],
  ['python', 'Python'],
  ['ruby', 'Ruby'],
  ['rust', 'Rust'],
  ['sql', 'SQL'],
  ['swift', 'Swift'],
  ['typescript', 'TypeScript'],
  ['xml', 'HTML/XML'],
  ['yaml', 'YAML'],
];

const MIN_DIAGRAM_WIDTH = 15;

/** Code block with language picker, copy button, line-number gutter and Mermaid preview. */
export function CodeBlockView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const language = (node.attrs.language as string | null) ?? '';
  const text = node.textContent;
  const lines = Math.max(1, text.split('\n').length);
  const isMermaid = language === 'mermaid';
  const [showSource, setShowSource] = useState(!text);
  const [copied, setCopied] = useState(false);
  const t = useMessages();
  const options: [string, string][] = [['', t.plainText], ['mermaid', t.mermaidLabel], ...LANGUAGES];
  const known = options.some(([v]) => v === language);
  // From the editor context, not editor.isEditable: the editor starts read-only until the document
  // syncs, and this node view is not re-rendered when it turns editable.
  const ctx = useBeeEditorContext();
  const editable = ctx ? ctx.editable : editor.isEditable;
  const saved = Number(node.attrs.diagramWidth) || null;
  // Width while dragging the handle; written to the node on release.
  const [draft, setDraft] = useState<number | null>(null);
  const diagramWidth = draft ?? saved;
  const frame = useRef<HTMLDivElement>(null);

  // Drag the corner to set the diagram's width (a percentage of the block); the diagram stays centred,
  // so it grows on both sides. Double click goes back to the natural size.
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = frame.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const cs = getComputedStyle(box);
    const total = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) || el.offsetWidth;
    const start = { x: e.clientX, w: el.offsetWidth };
    let last = diagramWidth;
    const move = (ev: PointerEvent) => {
      const w = start.w + 2 * (ev.clientX - start.x);
      last = Math.round(Math.min(100, Math.max(MIN_DIAGRAM_WIDTH, (w / total) * 100)));
      setDraft(last);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      if (last !== saved) updateAttributes({ diagramWidth: last });
      setDraft(null);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const copy = async () => {
    await navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <NodeViewWrapper className={`bee-code${isMermaid ? ' bee-code-mermaid' : ''}`} data-language={language}>
      <div className="bee-code-header" contentEditable={false}>
        {editable ? (
          <select
            className="bee-code-lang"
            value={language}
            onChange={(e) => updateAttributes({ language: e.target.value || null })}
            aria-label={t.codeLanguage}
          >
            {!known && <option value={language}>{language}</option>}
            {options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        ) : (
          <span className="bee-code-lang">{options.find(([v]) => v === language)?.[1] ?? language}</span>
        )}
        <span className="bee-code-actions">
          {isMermaid && (
            <button type="button" onClick={() => setShowSource((s) => !s)}>
              {showSource ? t.hideSource : t.editSource}
            </button>
          )}
          <button type="button" onClick={copy}>
            {copied ? t.copied : t.copy}
          </button>
        </span>
      </div>
      <div className="bee-code-body" hidden={isMermaid && !showSource}>
        <div className="bee-code-gutter" contentEditable={false} aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
        <pre spellCheck={false}>
          <NodeViewContent<'code'> as="code" />
        </pre>
      </div>
      {isMermaid && (
        <div className="bee-code-preview" contentEditable={false}>
          <div
            ref={frame}
            className={`bee-mermaid-frame${diagramWidth ? ' is-sized' : ''}${draft != null ? ' is-resizing' : ''}`}
            style={diagramWidth ? { width: `${diagramWidth}%` } : undefined}
          >
            <MermaidPreview code={text} />
            {editable && text.trim() && (
              <div
                className="bee-mermaid-resize"
                title={t.diagramResize}
                onPointerDown={startResize}
                onDoubleClick={() => updateAttributes({ diagramWidth: null })}
              />
            )}
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}

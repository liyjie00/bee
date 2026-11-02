import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useMessages } from './i18n.js';

type Katex = typeof import('katex').default;
let katexPromise: Promise<Katex> | null = null;
let katexLoaded: Katex | null = null;

function loadKatex(): Promise<Katex> {
  katexPromise ??= import('katex').then((m) => (katexLoaded = m.default));
  return katexPromise;
}

type Rendered = { html: string; error: null } | { html: null; error: string };

function renderLatex(katex: Katex, latex: string, displayMode: boolean): Rendered {
  try {
    // trust: false keeps \href, \includegraphics and raw HTML out; KaTeX escapes everything else.
    const html = katex.renderToString(latex, { displayMode, throwOnError: true, strict: 'ignore', trust: false, maxExpand: 1000, maxSize: 50 });
    return { html, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { html: null, error: message.replace(/^KaTeX parse error:\s*/, '') };
  }
}

function useKatex(): Katex | null {
  const [katex, setKatex] = useState(katexLoaded);
  useEffect(() => {
    if (!katex) void loadKatex().then(setKatex);
  }, [katex]);
  return katex;
}

/** A formula typeset by KaTeX (lazy-loaded); its source in red when it does not parse. */
export function MathRender({ latex, display, detail = display, onClick }: { latex: string; display: boolean; detail?: boolean; onClick?: () => void }) {
  const katex = useKatex();
  const t = useMessages();
  const Tag = display ? 'div' : 'span';
  const props = onClick ? { onClick } : {};
  if (!latex.trim()) return <Tag className="bee-math-empty" {...props}>{t.mathEmpty}</Tag>;
  if (!katex) return <Tag className="bee-math-source" {...props}>{latex}</Tag>;
  const out = renderLatex(katex, latex, display);
  if (out.error !== null) {
    return (
      <Tag className="bee-math-error" title={t.mathError + out.error} {...props}>
        <code>{latex}</code>
        {detail && <small>{t.mathError + out.error}</small>}
      </Tag>
    );
  }
  return <Tag className="bee-math-katex" {...props} dangerouslySetInnerHTML={{ __html: out.html }} />;
}

/** Snippets for touch screens, where `\`, `{` and `^` are buried in the keyboard. Caret goes to `|`. */
const QUICK_KEYS = ['\\frac{|}{}', '\\sqrt{|}', '^{|}', '_{|}', '{|}', '\\|', '\\alpha', '\\sum_{|}^{}', '\\int_{|}^{}'];

function QuickKeys({ field, onInsert }: { field: RefObject<HTMLInputElement | HTMLTextAreaElement | null>; onInsert: (value: string) => void }) {
  const insert = (snippet: string) => {
    const el = field.current;
    if (!el) return;
    const caret = snippet.includes('|') ? snippet.indexOf('|') : snippet.length;
    const text = snippet.replace('|', '');
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    onInsert(el.value.slice(0, start) + text + el.value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + caret, start + caret);
    });
  };
  return (
    <div className="bee-math-keys">
      {QUICK_KEYS.map((k) => (
        <button type="button" key={k} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(k)}>
          {k.replace('|', '').replace(/\{\}/g, '{ }')}
        </button>
      ))}
    </div>
  );
}

/** Editing state shared by both views: a local draft, committed on Done / click away, dropped on Esc. */
function useMathEditing({ node, editor, getPos, updateAttributes, deleteNode }: ReactNodeViewProps) {
  const latex = String(node.attrs.latex ?? '');
  const editable = editor.isEditable;
  // A formula just inserted empty (slash menu, $$ Enter) opens straight away.
  const [editing, setEditing] = useState(editable && !latex);
  const [draft, setDraft] = useState(latex);
  const wrapper = useRef<HTMLElement | null>(null);

  // Editors start read-only and turn editable later, so check on click rather than at render.
  const open = () => {
    if (!editor.isEditable) return;
    setDraft(latex);
    setEditing(true);
  };

  const close = (commit: boolean, refocus = true) => {
    setEditing(false);
    const pos = getPos();
    const value = commit ? draft.trim() : latex;
    if (!value) {
      deleteNode();
      if (refocus) editor.commands.focus();
      return;
    }
    if (value !== latex) updateAttributes({ latex: value });
    if (!refocus || typeof pos !== 'number') return;
    const after = pos + node.nodeSize;
    const chain = editor.chain();
    if (node.isBlock && !editor.state.doc.resolve(Math.min(after, editor.state.doc.content.size)).nodeAfter) {
      chain.insertContentAt(after, { type: 'paragraph' });
    }
    chain.focus(node.isBlock ? after + 1 : after).run();
  };

  // Clicking anywhere outside the editor commits, like clicking away from a link editor.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) closeRef.current(true, false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [editing]);

  return { latex, editing, draft, setDraft, open, close, wrapper };
}

export function InlineMathView(props: ReactNodeViewProps) {
  const t = useMessages();
  const { latex, editing, draft, setDraft, open, close, wrapper } = useMathEditing(props);
  const input = useRef<HTMLInputElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<{ shift: number; maxWidth: number } | null>(null);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  // Keep the popover inside the editor column instead of overflowing it to the right.
  useLayoutEffect(() => {
    const el = pop.current;
    if (!editing || !el || getComputedStyle(el).position === 'fixed') return setPlace(null);
    const bounds = props.editor.view.dom.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const width = Math.min(rect.width, bounds.width);
    const overflow = rect.left + width - bounds.right;
    setPlace({ shift: overflow > 0 ? Math.min(overflow, rect.left - bounds.left) : 0, maxWidth: bounds.width });
  }, [editing, props.editor]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(false);
    }
  };

  return (
    <NodeViewWrapper
      as="span"
      ref={wrapper}
      className={`bee-math-inline${props.selected ? ' is-selected' : ''}${editing ? ' is-editing' : ''}`}
    >
      <MathRender latex={editing ? draft : latex} display={false} onClick={open} />
      {editing && (
        <span ref={pop} className="bee-math-pop" contentEditable={false} style={place ? { marginLeft: -place.shift, maxWidth: place.maxWidth } : undefined}>
          <span className="bee-math-label">{t.mathInlineLabel}</span>
          <input
            ref={input}
            className="bee-math-input"
            value={draft}
            placeholder={t.mathPlaceholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={t.mathInlineLabel}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="bee-math-preview">
            <span className="bee-math-label">{t.mathPreview}</span>
            <MathRender latex={draft} display={false} detail />
          </span>
          <QuickKeys field={input} onInsert={setDraft} />
          <span className="bee-math-foot">
            <span>{t.mathInlineKeys}</span>
            <button type="button" className="bee-math-done" onClick={() => close(true)}>
              {t.mathDone}
            </button>
          </span>
        </span>
      )}
    </NodeViewWrapper>
  );
}

export function BlockMathView(props: ReactNodeViewProps) {
  const t = useMessages();
  const { latex, editing, draft, setDraft, open, close, wrapper } = useMathEditing(props);
  const area = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const el = area.current;
    if (!editing || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard?.writeText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <NodeViewWrapper ref={wrapper} className={`bee-math-block${props.selected ? ' is-selected' : ''}${editing ? ' is-editing' : ''}`}>
      <div className="bee-math-display" contentEditable={false}>
        <MathRender latex={editing ? draft : latex} display onClick={open} />
      </div>
      {editing && (
        <div className="bee-math-editor" contentEditable={false}>
          <div className="bee-math-head">
            <span className="bee-math-label">{t.mathBlockLabel}</span>
            <span className="bee-math-tools">
              <button type="button" onClick={copy}>
                {copied ? t.copied : t.mathCopy}
              </button>
              <button type="button" aria-label={t.mathDelete} title={t.mathDelete} onClick={() => props.deleteNode()}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                </svg>
              </button>
            </span>
          </div>
          <textarea
            ref={area}
            className="bee-math-textarea"
            value={draft}
            rows={Math.min(12, Math.max(2, draft.split('\n').length))}
            placeholder={t.mathPlaceholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={t.mathBlockLabel}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="bee-math-preview">
            <MathRender latex={draft} display />
          </div>
          <QuickKeys field={area} onInsert={setDraft} />
          <div className="bee-math-foot">
            <span>{t.mathBlockKeys}</span>
            <button type="button" className="bee-math-done" onClick={() => close(true)}>
              {t.mathDone}
            </button>
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}

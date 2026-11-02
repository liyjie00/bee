import { Extension, getMarkRange, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Messages } from './i18n.js';

/** A Bee document offered in the link popover. */
export interface LinkTarget {
  id: string;
  title: string;
  /** e.g. the folder it is in */
  hint?: string;
}

/** What the link popover shows: an editor for a new or existing link, a link's actions, or the paste choice. */
export type LinkPopoverState =
  | { mode: 'edit'; from: number; to: number; href: string }
  | { mode: 'view'; from: number; to: number; href: string }
  | { mode: 'pasted'; from: number; to: number; href: string; label: string };

export interface LinkHost {
  open(state: LinkPopoverState): void;
  /** Title (and section) for a pasted Bee link; null keeps the URL. */
  resolve?: (url: URL) => Promise<string | null>;
}

/** Bee document URLs on this site: /d/<id>, /s/<token>, /s/<token>/d/<id>, optionally with #b-<block>. */
export function beeDocUrl(href: string): URL | null {
  try {
    const u = new URL(href, location.href);
    if (u.origin !== location.origin) return null;
    return /^\/(d\/[0-9a-f-]{36}|s\/[\w-]+(\/d\/[0-9a-f-]{36})?)\/?$/i.test(u.pathname) ? u : null;
  } catch {
    return null;
  }
}

const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const looksLikeUrl = (s: string) => URL_RE.test(s.trim()) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s.trim());
const normalize = (s: string) => {
  const v = s.trim();
  if (/^(https?:|mailto:|\/)/i.test(v)) return v;
  return 'https://' + v;
};

function linkDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const link = node.marks.find((m) => m.type.name === 'link');
    if (link && beeDocUrl(String(link.attrs.href ?? ''))) decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'bee-doc-link' }));
  });
  return DecorationSet.create(doc, decos);
}

const key = new PluginKey<DecorationSet>('beeLinks');

/** Link popover triggers (click, ⌘K, paste of a Bee link) and the Bee icon on links to Bee docs. */
export const BeeLinks = Extension.create<{ host: LinkHost | null; editable: boolean }>({
  name: 'beeLinks',
  // Before the Link extension, so a click on a link in an editable doc opens the popover instead.
  priority: 1000,
  addOptions: () => ({ host: null, editable: false }),

  addKeyboardShortcuts() {
    return {
      'Mod-k': () => {
        if (!this.options.editable || !this.options.host) return false;
        openLinkEditor(this.editor);
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const { host, editable } = this.options;
    const editor = this.editor;
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => linkDecorations(state.doc),
          apply: (tr, old) => (tr.docChanged ? linkDecorations(tr.doc) : old),
        },
        props: {
          decorations: (state) => key.getState(state),
          handleClick(view, pos, event) {
            if (!editable || !host || event.button !== 0) return false;
            const link = view.state.schema.marks.link;
            if (!link) return false;
            const $pos = view.state.doc.resolve(pos);
            const range = getMarkRange($pos, link);
            if (!range) return false;
            const mark = $pos.marks().find((m) => m.type === link) ?? view.state.doc.nodeAt(range.from)?.marks.find((m) => m.type === link);
            const href = String(mark?.attrs.href ?? '');
            if (event.metaKey || event.ctrlKey) {
              window.open(href, '_blank', 'noopener');
              return true;
            }
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
            host.open({ mode: 'view', from: range.from, to: range.to, href });
            return true; // instead of the Link extension opening it
          },
          handlePaste(view, event) {
            if (!editable || !host?.resolve) return false;
            const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
            const url = text && !/\s/.test(text) ? beeDocUrl(text) : null;
            const { from, to, $from } = view.state.selection;
            if (!url || from !== to || $from.parent.type.name === 'codeBlock') return false;
            const link = view.state.schema.marks.link!;
            const href = url.href;
            view.dispatch(view.state.tr.insert(from, view.state.schema.text(href, [link.create({ href })])).scrollIntoView());
            const resolve = host.resolve;
            void resolve(url).then((label) => {
              if (!label || editor.isDestroyed) return;
              const st = editor.state;
              const end = from + href.length;
              if (end > st.doc.content.size || st.doc.textBetween(from, end) !== href) return;
              editor.view.dispatch(st.tr.replaceWith(from, end, st.schema.text(label, [link.create({ href })])));
              host.open({ mode: 'pasted', from, to: from + label.length, href, label });
            });
            return true;
          },
        },
      }),
    ];
  },
});

const OPEN_EVENT = 'bee:link-editor';

/** Opens the link popover for the selection (toolbar button, bubble menu, ⌘K). */
export function openLinkEditor(editor: Editor) {
  editor.view.dom.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

function rangeForEditing(editor: Editor): { from: number; to: number; href: string } {
  const { state } = editor;
  const link = state.schema.marks.link!;
  const { from, to, $from } = state.selection;
  const range = getMarkRange($from, link);
  if (range && (from === to || (from >= range.from && to <= range.to))) {
    const mark = state.doc.nodeAt(range.from)?.marks.find((m) => m.type === link);
    return { ...range, href: String(mark?.attrs.href ?? '') };
  }
  return { from, to, href: '' };
}

function apply(editor: Editor, from: number, to: number, href: string, label: string) {
  const link = editor.schema.marks.link!;
  const chain = editor.chain().focus();
  if (from === to) {
    chain.insertContentAt(from, { type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] }).run();
    return;
  }
  chain
    .command(({ tr }) => {
      tr.removeMark(from, to, link).addMark(from, to, link.create({ href }));
      return true;
    })
    .setTextSelection(to)
    .run();
}

const BeeMark = () => (
  <svg className="bee-link-icon" width="14" height="14" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill="#e8a317" />
    <path d="M10 9v14M10 16a6 6 0 1 0 6-6" stroke="#2a1c00" strokeWidth="3" fill="none" strokeLinecap="round" />
  </svg>
);

/** The in-app replacement for prompt(): edit a link, act on one, or undo a pasted Bee link's title. */
export function LinkPopover({
  editor,
  messages: t,
  state,
  setState,
  searchDocs,
  onOpenLink,
}: {
  editor: Editor;
  messages: Messages;
  state: LinkPopoverState | null;
  setState(s: LinkPopoverState | null): void;
  searchDocs?: (q: string) => Promise<LinkTarget[]>;
  /** Opens a Bee link inside the app; returns false to open it in a new tab. */
  onOpenLink?: (href: string) => boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [q, setQ] = useState('');
  const [docs, setDocs] = useState<LinkTarget[]>([]);
  const [hl, setHl] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const dom = editor.view.dom;
    const onOpen = () => {
      const r = rangeForEditing(editor);
      setState({ mode: 'edit', ...r });
    };
    dom.addEventListener(OPEN_EVENT, onOpen);
    return () => dom.removeEventListener(OPEN_EVENT, onOpen);
  }, [editor]);

  // The view popover follows the caret: it closes once the caret leaves the link.
  useEffect(() => {
    if (state?.mode !== 'view' && state?.mode !== 'pasted') return;
    const check = () => {
      const { from } = editor.state.selection;
      if (from < state.from || from > state.to) setState(null);
    };
    editor.on('selectionUpdate', check);
    return () => {
      editor.off('selectionUpdate', check);
    };
  }, [editor, state]);

  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setCopied(false);
    if (state?.mode !== 'edit') return;
    setQ(state.href);
    // After the click or key that opened it has settled, or the editor keeps focus.
    const raf = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [state?.mode, state?.from, state?.href]);

  useLayoutEffect(() => {
    if (!state) return setPos(null);
    try {
      const c = editor.view.coordsAtPos(Math.min(state.from, editor.state.doc.content.size));
      const w = box.current?.offsetWidth ?? 380;
      setPos({ left: Math.max(8, Math.min(c.left, innerWidth - w - 8)), top: c.bottom + 8 });
    } catch {
      setPos(null);
    }
  }, [state, editor]);

  useEffect(() => {
    if (!state) return;
    const down = (e: MouseEvent) => {
      if (box.current?.contains(e.target as Node)) return;
      // A click on another link is handled by the click plugin.
      if (state.mode === 'edit') setState(null);
    };
    const scroll = () => setState(null);
    document.addEventListener('mousedown', down);
    const scroller = editor.view.dom.closest('.view') ?? window;
    scroller.addEventListener('scroll', scroll, { passive: true });
    return () => {
      document.removeEventListener('mousedown', down);
      scroller.removeEventListener('scroll', scroll);
    };
  }, [state, editor]);

  const isUrl = looksLikeUrl(q);
  useEffect(() => {
    if (state?.mode !== 'edit' || !searchDocs || isUrl) return setDocs([]);
    let live = true;
    const timer = setTimeout(() => {
      searchDocs(q.trim()).then((d) => {
        if (live) {
          setDocs(d.slice(0, 6));
          setHl(0);
        }
      }, () => {});
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, state?.mode, isUrl, searchDocs]);

  if (!state) return null;
  const close = () => {
    setState(null);
    editor.commands.focus();
  };
  const choose = (target?: LinkTarget) => {
    if (target) {
      apply(editor, state.from, state.to, `${location.origin}/d/${target.id}`, target.title || t.untitled);
    } else {
      const v = q.trim();
      if (!v) {
        if (state.href) editor.chain().focus().setTextSelection({ from: state.from, to: state.to }).unsetLink().run();
        return setState(null);
      }
      const href = normalize(v);
      apply(editor, state.from, state.to, href, v);
    }
    setState(null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' && docs.length) {
      e.preventDefault();
      setHl((i) => (i + 1) % docs.length);
    } else if (e.key === 'ArrowUp' && docs.length) {
      e.preventDefault();
      setHl((i) => (i + docs.length - 1) % docs.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(isUrl || !docs.length ? undefined : docs[hl]);
    }
  };
  const openHref = () => {
    if (!onOpenLink?.(state.href)) window.open(state.href, '_blank', 'noopener');
  };
  const style = pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' as const };

  if (state.mode === 'pasted') {
    return (
      <div ref={box} className="bee-link-pop bee-link-pasted" style={style} role="menu" aria-label={t.linkPasteAs}>
        <div className="bee-link-cap">{t.linkPasteAs}</div>
        <button type="button" role="menuitem" className="is-active" onClick={() => setState(null)}>
          {t.linkPasteTitle}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            const link = editor.schema.marks.link!;
            editor
              .chain()
              .focus()
              .command(({ tr }) => {
                tr.replaceWith(state.from, state.to, editor.schema.text(state.href, [link.create({ href: state.href })]));
                return true;
              })
              .run();
            setState(null);
          }}
        >
          {t.linkPasteUrl}
        </button>
      </div>
    );
  }
  if (state.mode === 'view') {
    const bee = !!beeDocUrl(state.href);
    const label = bee ? editor.state.doc.textBetween(state.from, state.to) : state.href;
    return (
      <div ref={box} className="bee-link-pop bee-link-view" style={style} role="dialog" aria-label={t.link}>
        {bee && <BeeMark />}
        <a href={state.href} target="_blank" rel="noopener noreferrer" onClick={(e) => (e.preventDefault(), openHref())} title={state.href}>
          {label}
        </a>
        <button type="button" onClick={() => setState({ ...state, mode: 'edit' })}>
          {t.linkEdit}
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(state.href).then(() => setCopied(true), () => {});
          }}
        >
          {copied ? t.copied : t.copy}
        </button>
        <button
          type="button"
          className="is-danger"
          onClick={() => {
            editor.chain().focus().setTextSelection({ from: state.from, to: state.to }).unsetLink().setTextSelection(state.to).run();
            setState(null);
          }}
        >
          {t.linkRemove}
        </button>
      </div>
    );
  }
  return (
    <div ref={box} className="bee-link-pop" style={style} role="dialog" aria-label={t.link}>
      <div className="bee-link-row">
        <input
          ref={input}
          autoFocus
          value={q}
          placeholder={searchDocs ? t.linkPlaceholder : t.linkPrompt}
          aria-label={t.linkPlaceholder}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <button type="button" className="bee-link-ok" onClick={() => choose(isUrl || !docs.length ? undefined : docs[hl])}>
          {t.linkApply}
        </button>
      </div>
      {isUrl && (
        <button type="button" className="bee-link-opt is-active" onClick={() => choose()}>
          <span className="bee-link-url">{t.linkTo.replace('{url}', q.trim())}</span>
        </button>
      )}
      {!isUrl && docs.length > 0 && (
        <>
          <div className="bee-link-cap">{q.trim() ? t.linkDocs : t.linkRecent}</div>
          {docs.map((d, i) => (
            <button key={d.id} type="button" className={'bee-link-opt' + (i === hl ? ' is-active' : '')} onMouseEnter={() => setHl(i)} onClick={() => choose(d)}>
              <BeeMark />
              <span className="bee-link-title">{d.title || t.untitled}</span>
              {d.hint && <small>{d.hint}</small>}
            </button>
          ))}
        </>
      )}
      {!isUrl && q.trim() && searchDocs && docs.length === 0 && <div className="bee-link-none">{t.linkNoDocs}</div>}
      <div className="bee-link-hint">{t.linkHint}</div>
    </div>
  );
}

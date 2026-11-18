import { Extension, type Editor, type Range } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { placeMenu } from './SlashMenu.js';

/** A ticket as the editor shows it (status dot, key, title). */
export interface TicketHit {
  id: string;
  key: string;
  title: string;
  statusName: string;
  statusColor: string;
  category: 'todo' | 'doing' | 'done';
}

/** Host-provided ticket lookups; ticket references are ordinary links to /t/<id>. */
export interface TicketHost {
  search(query: string): Promise<TicketHit[]>;
  /** Current status of tickets by id (missing ones are not visible to the reader). */
  resolve(ids: string[]): Promise<TicketHit[]>;
  /** Creates a ticket titled `title`; null when cancelled. Enables "new ticket" in the # menu. */
  create?(title: string): Promise<TicketHit | null>;
  labels: {
    heading: string;
    empty: string;
    create: (title: string) => string;
    fromSelection: string;
  };
}

const TICKET_PATH = /^\/t\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** The ticket id a link points to, if it is a Bee ticket link. */
export function ticketIdOf(href: string): string | null {
  try {
    const u = new URL(href, location.href);
    if (u.origin !== location.origin) return null;
    return TICKET_PATH.exec(u.pathname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export const ticketHref = (id: string) => `/t/${id}`;

/** Replaces `range` with a link to the ticket, followed by a space. */
export function insertTicketLink(editor: Editor, range: Range, t: TicketHit) {
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      {
        type: 'text',
        text: `${t.key} ${t.title}`,
        marks: [{ type: 'link', attrs: { href: ticketHref(t.id) } }],
      },
      { type: 'text', text: ' ' },
    ])
    .run();
}

const chipsKey = new PluginKey<DecorationSet>('beeTicketChips');
const menuKey = new PluginKey('beeTicketMenu');

function dot(t: TicketHit | undefined): HTMLElement {
  const el = document.createElement('span');
  el.className = 'bee-ticket-dot' + (t ? ` is-${t.category}` : ' is-unknown');
  if (t) {
    el.style.setProperty('--tc', t.statusColor);
    el.title = `${t.key} · ${t.statusName}`;
  }
  el.contentEditable = 'false';
  return el;
}

function chipDecorations(
  doc: PMNode,
  known: Map<string, TicketHit>,
  missing: Set<string>,
): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const link = node.marks.find((m) => m.type.name === 'link');
    const id = link ? ticketIdOf(String(link.attrs.href ?? '')) : null;
    if (!id) return;
    const t = known.get(id);
    if (!t) missing.add(id);
    const prev = doc.resolve(pos).nodeBefore;
    const continues =
      prev?.isText &&
      prev.marks.some(
        (m) => m.type.name === 'link' && ticketIdOf(String(m.attrs.href ?? '')) === id,
      );
    decos.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        class: 'bee-ticket-link' + (t?.category === 'done' ? ' is-done' : ''),
        'data-ticket': id,
      }),
    );
    if (!continues)
      decos.push(
        Decoration.widget(pos, () => dot(t), {
          side: -1,
          key: `t-${id}-${t?.category ?? 'x'}-${t?.statusColor ?? ''}`,
        }),
      );
  });
  return DecorationSet.create(doc, decos);
}

interface MenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}
type Item = TicketHit | { create: string };
interface MenuProps extends SuggestionProps<Item, Item> {
  labels: TicketHost['labels'];
}

const TicketMenu = forwardRef<MenuHandle, MenuProps>(function TicketMenu(
  { items, command, labels },
  ref,
) {
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === 'ArrowDown') {
        setIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        setIndex((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const it = items[index];
        if (it) command(it);
        return true;
      }
      return false;
    },
  }));
  return (
    <div className="bee-slash bee-ticket-menu" role="listbox" aria-label={labels.heading}>
      <div className="bee-slash-heading">{labels.heading}</div>
      {items.length === 0 && <div className="bee-slash-empty">{labels.empty}</div>}
      {items.map((it, i) => (
        <button
          type="button"
          role="option"
          aria-selected={i === index}
          key={'create' in it ? 'new' : it.id}
          className={i === index ? 'is-active' : undefined}
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            command(it);
          }}
        >
          {'create' in it ? (
            <span className="bee-slash-text">{labels.create(it.create)}</span>
          ) : (
            <>
              <span
                className="bee-ticket-dot"
                style={{ ['--tc' as string]: it.statusColor }}
                data-cat={it.category}
              />
              <span className="bee-ticket-key">{it.key}</span>
              <span className="bee-slash-text">
                {it.title}
                <small>{it.statusName}</small>
              </span>
            </>
          )}
        </button>
      ))}
    </div>
  );
});

function place(el: HTMLElement, clientRect: (() => DOMRect | null) | null | undefined) {
  const apply = () => {
    const rect = clientRect?.();
    if (!rect) return;
    const menu = el.firstElementChild as HTMLElement | null;
    if (menu) menu.style.maxHeight = '';
    const p = placeMenu(
      rect,
      menu?.offsetHeight || 300,
      { width: window.innerWidth, height: window.innerHeight },
      340,
    );
    Object.assign(el.style, {
      position: 'fixed',
      zIndex: '50',
      left: `${p.left}px`,
      top: `${p.top}px`,
    });
    if (menu) menu.style.maxHeight = `${p.maxHeight}px`;
  };
  apply();
  requestAnimationFrame(apply);
}

/**
 * Ticket references in documents: links to /t/<id> show a live status dot, and typing "#" offers
 * tickets to insert (or a new one to create).
 */
export const TicketRefs = Extension.create<{ host: TicketHost | null; editable: boolean }>({
  name: 'beeTickets',
  addOptions() {
    return { host: null, editable: false };
  },
  addProseMirrorPlugins() {
    const host = this.options.host;
    if (!host) return [];
    const known = new Map<string, TicketHit>();
    const asked = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let viewRef: {
      dispatch: (tr: import('@tiptap/pm/state').Transaction) => void;
      state: import('@tiptap/pm/state').EditorState;
      isDestroyed?: boolean;
    } | null = null;
    const fetchMissing = (ids: Set<string>) => {
      const need = [...ids].filter((id) => !asked.has(id));
      if (!need.length) return;
      for (const id of need) asked.add(id);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void host.resolve([...asked].filter((id) => !known.has(id))).then(
          (list) => {
            for (const t of list) known.set(t.id, t);
            if (viewRef && !viewRef.isDestroyed)
              viewRef.dispatch(viewRef.state.tr.setMeta(chipsKey, 'refresh'));
          },
          () => {},
        );
      }, 50);
    };
    // Statuses change: refresh every 30 seconds.
    const refresh = setInterval(() => {
      if (!known.size || document.hidden) return;
      void host.resolve([...known.keys()]).then(
        (list) => {
          let changed = false;
          for (const t of list) {
            const old = known.get(t.id);
            if (
              !old ||
              old.statusColor !== t.statusColor ||
              old.category !== t.category ||
              old.statusName !== t.statusName
            )
              changed = true;
            known.set(t.id, t);
          }
          if (changed && viewRef && !viewRef.isDestroyed)
            viewRef.dispatch(viewRef.state.tr.setMeta(chipsKey, 'refresh'));
        },
        () => {},
      );
    }, 30_000);

    const chips = new Plugin<DecorationSet>({
      key: chipsKey,
      state: {
        init: (_c, state) => {
          const missing = new Set<string>();
          const set = chipDecorations(state.doc, known, missing);
          queueMicrotask(() => fetchMissing(missing));
          return set;
        },
        apply: (tr, old) => {
          if (!tr.docChanged && !tr.getMeta(chipsKey)) return old;
          const missing = new Set<string>();
          const set = chipDecorations(tr.doc, known, missing);
          if (missing.size) queueMicrotask(() => fetchMissing(missing));
          return set;
        },
      },
      props: { decorations: (state) => chipsKey.getState(state) },
      view: (view) => {
        viewRef = view as never;
        return {
          destroy: () => {
            viewRef = null;
            clearInterval(refresh);
            if (timer) clearTimeout(timer);
          },
        };
      },
    });
    if (!this.options.editable) return [chips];

    const menu = Suggestion<Item, Item>({
      editor: this.editor,
      pluginKey: menuKey,
      char: '#',
      allowSpaces: true,
      startOfLine: false,
      allow: ({ state, range }) => {
        const $from = state.doc.resolve(range.from);
        if ($from.parent.type.name === 'codeBlock') return false;
        // Only after a space: not inside words (C#, URLs), and not at the start of a block, where
        // "# " makes a heading.
        const before = state.doc.textBetween(Math.max($from.start(), range.from - 1), range.from);
        return before !== '' && /\s/.test(before);
      },
      items: async ({ query }) => {
        const q = query.trim();
        if (q.length > 80) return [];
        const hits = await host.search(q).catch(() => []);
        const items: Item[] = hits.slice(0, 8);
        if (host.create && q.length >= 2) items.push({ create: q });
        return items;
      },
      command: ({ editor, range, props }) => {
        if ('create' in props) {
          const create = host.create!;
          editor.chain().focus().deleteRange(range).run();
          const at = editor.state.selection.from;
          void create(props.create).then((t) => {
            if (t && !editor.isDestroyed) insertTicketLink(editor, { from: at, to: at }, t);
          });
          return;
        }
        known.set(props.id, props);
        insertTicketLink(editor, range, props);
      },
      render: () => {
        let r: ReactRenderer<MenuHandle, MenuProps> | null = null;
        const wrap = (p: SuggestionProps<Item, Item>): MenuProps => ({ ...p, labels: host.labels });
        const close = () => {
          r?.destroy();
          r?.element.remove();
          r = null;
        };
        return {
          onStart: (p) => {
            r = new ReactRenderer(TicketMenu, { props: wrap(p), editor: p.editor });
            document.body.appendChild(r.element);
            place(r.element as HTMLElement, p.clientRect);
          },
          onUpdate: (p) => {
            r?.updateProps(wrap(p));
            if (r) place(r.element as HTMLElement, p.clientRect);
          },
          onKeyDown: (p) => {
            if (p.event.key === 'Escape') {
              close();
              return true;
            }
            return r?.ref?.onKeyDown(p) ?? false;
          },
          onExit: close,
        };
      },
    });
    return [chips, menu];
  },
});

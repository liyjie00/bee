import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import type { Messages } from './i18n.js';
import { MessagesContext } from './i18n.js';

/** Read lazily so the menu always reflects the host's current props. */
export interface SlashHost {
  messages: () => Messages;
  canPickImage: () => boolean;
  pickImage: () => void;
  canCreateWhiteboard: () => boolean;
  createWhiteboard: () => void;
  canLinkWhiteboard: () => boolean;
  linkWhiteboard: () => void;
}

export interface SlashItem {
  id: string;
  title: string;
  hint: string;
  icon: string;
  keywords: string;
  run: (editor: Editor, range: Range) => void;
}

function buildItems(host: SlashHost): SlashItem[] {
  const t = host.messages();
  const chain = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);
  const items: (SlashItem | null)[] = [
    { id: 'text', title: t.text, hint: t.textHint, icon: '¶', keywords: 'text paragraph p 正文', run: (e, r) => chain(e, r).setParagraph().run() },
    { id: 'h1', title: t.heading1, hint: t.headingHint, icon: 'H1', keywords: 'h1 heading title 标题', run: (e, r) => chain(e, r).setHeading({ level: 1 }).run() },
    { id: 'h2', title: t.heading2, hint: t.headingHint, icon: 'H2', keywords: 'h2 heading 标题', run: (e, r) => chain(e, r).setHeading({ level: 2 }).run() },
    { id: 'h3', title: t.heading3, hint: t.headingHint, icon: 'H3', keywords: 'h3 heading 标题', run: (e, r) => chain(e, r).setHeading({ level: 3 }).run() },
    { id: 'bullet', title: t.bulletList, hint: t.bulletListHint, icon: '•', keywords: 'bullet list ul 列表', run: (e, r) => chain(e, r).toggleBulletList().run() },
    { id: 'ordered', title: t.orderedList, hint: t.orderedListHint, icon: '1.', keywords: 'ordered numbered list ol 有序', run: (e, r) => chain(e, r).toggleOrderedList().run() },
    { id: 'task', title: t.taskList, hint: t.taskListHint, icon: '☐', keywords: 'todo task check 待办 清单', run: (e, r) => chain(e, r).toggleTaskList().run() },
    { id: 'quote', title: t.quote, hint: t.quoteHint, icon: '❝', keywords: 'quote blockquote 引用', run: (e, r) => chain(e, r).toggleBlockquote().run() },
    { id: 'code', title: t.codeBlock, hint: t.codeBlockHint, icon: '</>', keywords: 'code codeblock pre 代码', run: (e, r) => chain(e, r).setCodeBlock().run() },
    { id: 'mermaid', title: t.mermaid, hint: t.mermaidHint, icon: '⤳', keywords: 'mermaid diagram flowchart chart 流程图 图', run: (e, r) => chain(e, r).setCodeBlock({ language: 'mermaid' }).run() },
    { id: 'table', title: t.table, hint: t.tableHint, icon: '▦', keywords: 'table grid 表格', run: (e, r) => chain(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    host.canPickImage()
      ? { id: 'image', title: t.image, hint: t.imageHint, icon: '▣', keywords: 'image picture photo img 图片', run: (e, r) => { chain(e, r).run(); host.pickImage(); } }
      : null,
    host.canCreateWhiteboard()
      ? { id: 'whiteboard', title: t.whiteboard, hint: t.whiteboardHint, icon: '✎', keywords: 'whiteboard excalidraw draw board canvas 白板 画板', run: (e, r) => { chain(e, r).run(); host.createWhiteboard(); } }
      : null,
    host.canLinkWhiteboard()
      ? { id: 'linkWhiteboard', title: t.linkWhiteboard, hint: t.linkWhiteboardHint, icon: '⧉', keywords: 'whiteboard existing link embed insert excalidraw diagram board 白板 已有 插入 嵌入 画板 图', run: (e, r) => { chain(e, r).run(); host.linkWhiteboard(); } }
      : null,
    { id: 'divider', title: t.divider, hint: t.dividerHint, icon: '—', keywords: 'divider hr rule line 分割线', run: (e, r) => chain(e, r).setHorizontalRule().run() },
  ];
  return items.filter((i): i is SlashItem => i !== null);
}

export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) => i.title.toLowerCase().includes(q) || i.keywords.toLowerCase().includes(q));
}

interface MenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

interface MenuProps extends SuggestionProps<SlashItem, SlashItem> {
  messages: Messages;
}

const SlashMenuList = forwardRef<MenuHandle, MenuProps>(function SlashMenuList({ items, command, messages }, ref) {
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
      if (event.key === 'Enter') {
        const item = items[index];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  return (
    <div className="bee-slash" role="listbox" aria-label={messages.slashHeading}>
      <div className="bee-slash-heading">{messages.slashHeading}</div>
      {items.length === 0 && <div className="bee-slash-empty">{messages.slashEmpty}</div>}
      {items.map((item, i) => (
        <button
          type="button"
          role="option"
          aria-selected={i === index}
          key={item.id}
          className={i === index ? 'is-active' : undefined}
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            command(item);
          }}
        >
          <span className="bee-slash-icon">{item.icon}</span>
          <span className="bee-slash-text">
            {item.title}
            <small>{item.hint}</small>
          </span>
        </button>
      ))}
    </div>
  );
});

function place(el: HTMLElement, rect: DOMRect | null | undefined) {
  if (!rect) return;
  const menuHeight = el.offsetHeight || 320;
  const below = rect.bottom + 6 + menuHeight < window.innerHeight;
  el.style.position = 'fixed';
  el.style.zIndex = '50';
  el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 296))}px`;
  el.style.top = below ? `${rect.bottom + 6}px` : `${Math.max(8, rect.top - menuHeight - 6)}px`;
}

export const slashPluginKey = new PluginKey('beeSlash');

/** "/" insert menu built on @tiptap/suggestion. */
export const SlashCommand = Extension.create<{ host: SlashHost | null }>({
  name: 'beeSlash',

  addOptions() {
    return { host: null };
  },

  addProseMirrorPlugins() {
    const host = this.options.host;
    if (!host) return [];
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: slashPluginKey,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          return $from.parent.type.name !== 'codeBlock';
        },
        items: ({ query }) => filterSlashItems(buildItems(host), query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let renderer: ReactRenderer<MenuHandle, MenuProps> | null = null;
          const wrap = (props: SuggestionProps<SlashItem, SlashItem>): MenuProps => ({ ...props, messages: host.messages() });
          return {
            onStart: (props) => {
              renderer = new ReactRenderer(
                forwardRef<MenuHandle, MenuProps>((p, ref) => (
                  <MessagesContext.Provider value={p.messages}>
                    <SlashMenuList {...p} ref={ref} />
                  </MessagesContext.Provider>
                )),
                { props: wrap(props), editor: props.editor },
              );
              document.body.appendChild(renderer.element);
              place(renderer.element as HTMLElement, props.clientRect?.());
            },
            onUpdate: (props) => {
              renderer?.updateProps(wrap(props));
              if (renderer) place(renderer.element as HTMLElement, props.clientRect?.());
            },
            onKeyDown: (props) => {
              if (props.event.key === 'Escape') {
                renderer?.destroy();
                renderer?.element.remove();
                renderer = null;
                return true;
              }
              return renderer?.ref?.onKeyDown(props) ?? false;
            },
            onExit: () => {
              renderer?.destroy();
              renderer?.element.remove();
              renderer = null;
            },
          };
        },
      }),
    ];
  },
});

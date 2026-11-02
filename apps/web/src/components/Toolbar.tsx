import { useEffect, useReducer, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { openLinkEditor } from '@bee/editor';
import { Icon, type IconName } from './Icon';
import { useT } from '../i18n';
import { PHONE_QUERY, useKeyboardInset, useMediaQuery } from '../lib/media';

/* Commands come from the extensions @bee/editor registers (StarterKit, task list, table, image). */
type Fn = (...args: never[]) => Chain;
interface Chain {
  run(): boolean;
  setParagraph: Fn; setHeading(a: { level: number }): Chain;
  toggleBold: Fn; toggleItalic: Fn; toggleUnderline: Fn; toggleStrike: Fn; toggleCode: Fn;
  unsetLink: Fn; extendMarkRange(m: string): Chain; setLink(a: { href: string }): Chain;
  toggleTaskList: Fn; toggleBulletList: Fn; toggleCodeBlock: Fn;
  setImage(a: { src: string; alt?: string }): Chain;
  insertTable(a: { rows: number; cols: number; withHeaderRow: boolean }): Chain;
  undo: Fn; redo: Fn;
}

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

export function Toolbar({ editor, onUploadImage }: { editor: Editor | null; onUploadImage(f: File): Promise<string> }) {
  const t = useT();
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!editor) return;
    editor.on('transaction', rerender);
    return () => {
      editor.off('transaction', rerender);
    };
  }, [editor]);

  // Phones: the toolbar docks on top of the on-screen keyboard while the text is being edited.
  const phone = useMediaQuery(PHONE_QUERY);
  const bar = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editor || !phone) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const focus = () => {
      clearTimeout(timer);
      setEditing(true);
    };
    // A tap on the bar (the style picker) briefly takes focus from the editor: keep the bar up.
    const blur = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setEditing(editor.isFocused || !!bar.current?.contains(document.activeElement)), 150);
    };
    setEditing(editor.isFocused);
    editor.on('focus', focus);
    editor.on('blur', blur);
    return () => {
      clearTimeout(timer);
      editor.off('focus', focus);
      editor.off('blur', blur);
    };
  }, [editor, phone]);
  const docked = phone && editing;
  const keyboard = useKeyboardInset(docked);

  const run = (fn: (c: Chain) => Chain) => {
    if (!editor) return;
    fn(editor.chain().focus() as unknown as Chain).run();
  };
  const active = (name: string, attrs?: Record<string, unknown>) => !!editor?.isActive(name, attrs);
  const level = HEADING_LEVELS.find((l) => active('heading', { level: l }));
  const style = level ? `h${level}` : 'p';

  const btn = (label: string, on: boolean, act: () => void, content: React.ReactNode) => (
    <button className={'ico' + (on ? ' on' : '')} title={label} aria-label={label} aria-pressed={on} onMouseDown={(e) => e.preventDefault()} onClick={act} disabled={!editor}>
      {content}
    </button>
  );
  const ib = (label: string, icon: IconName, on: boolean, act: () => void) => btn(label, on, act, <Icon name={icon} />);

  const link = () => editor && openLinkEditor(editor);
  const image = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const src = await onUploadImage(f);
      run((c) => c.setImage({ src, alt: f.name }));
    };
    input.click();
  };

  if (phone && !editing) return null;
  const svg = (d: string) => (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );

  return (
    <div
      ref={bar}
      className={'toolbar' + (docked ? ' docked' : '')}
      style={docked ? { bottom: keyboard } : undefined}
      role="toolbar"
      aria-label={t('toolbar.label')}
      onBlur={docked ? () => setTimeout(() => setEditing(!!editor?.isFocused || !!bar.current?.contains(document.activeElement)), 150) : undefined}
    >
      {docked && (
        <>
          {btn(t('toolbar.undo'), false, () => run((c) => c.undo()), svg('M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11'))}
          {btn(t('toolbar.redo'), false, () => run((c) => c.redo()), svg('m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13'))}
          <span className="sep" />
        </>
      )}
      <select
        aria-label={t('toolbar.style')}
        value={style}
        disabled={!editor}
        onChange={(e) => {
          const v = e.target.value;
          run((c) => (v === 'p' ? c.setParagraph() : c.setHeading({ level: Number(v.slice(1)) })));
        }}
      >
        <option value="p">{t('toolbar.body')}</option>
        {HEADING_LEVELS.map((l) => (
          <option key={l} value={`h${l}`}>{t(`toolbar.h${l}`)}</option>
        ))}
      </select>
      <span className="sep" />
      {btn(t('toolbar.bold'), active('bold'), () => run((c) => c.toggleBold()), <b>B</b>)}
      {btn(t('toolbar.italic'), active('italic'), () => run((c) => c.toggleItalic()), <i>I</i>)}
      {btn(t('toolbar.underline'), active('underline'), () => run((c) => c.toggleUnderline()), <u>U</u>)}
      {btn(t('toolbar.strike'), active('strike'), () => run((c) => c.toggleStrike()), <s>S</s>)}
      {btn(t('toolbar.code'), active('code'), () => run((c) => c.toggleCode()), <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}><path d="M5 4.5 1.5 8 5 11.5M11 4.5l3.5 3.5-3.5 3.5M9.2 3 6.8 13" /></svg>)}
      <span className="sep" />
      {ib(t('toolbar.link'), 'link', active('link'), link)}
      {ib(t('toolbar.checklist'), 'check', active('taskList'), () => run((c) => c.toggleTaskList()))}
      {ib(t('toolbar.list'), 'list', active('bulletList'), () => run((c) => c.toggleBulletList()))}
      <span className="sep" />
      {ib(t('toolbar.image'), 'image', false, image)}
      {ib(t('toolbar.codeBlock'), 'code', active('codeBlock'), () => run((c) => c.toggleCodeBlock()))}
      {ib(t('toolbar.table'), 'sheet', active('table'), () => run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true })))}
      <span className="sep" />
      <span className="hint hide-sm" title={t('toolbar.hint')}>
        {t('toolbar.hint')}
      </span>
      {docked && (
        <button className="ico done" title={t('toolbar.done')} aria-label={t('toolbar.done')} onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.commands.blur()}>
          {svg('m6 9 6 6 6-6')}
        </button>
      )}
    </div>
  );
}

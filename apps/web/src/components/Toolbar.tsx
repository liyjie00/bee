import { useEffect, useReducer } from 'react';
import type { Editor } from '@tiptap/core';
import { Icon, type IconName } from './Icon';
import { useT } from '../i18n';

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
}

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

  const run = (fn: (c: Chain) => Chain) => {
    if (!editor) return;
    fn(editor.chain().focus() as unknown as Chain).run();
  };
  const active = (name: string, attrs?: Record<string, unknown>) => !!editor?.isActive(name, attrs);
  const style = active('heading', { level: 1 }) ? 'h1' : active('heading', { level: 2 }) ? 'h2' : active('heading', { level: 3 }) ? 'h3' : 'p';

  const btn = (label: string, on: boolean, act: () => void, content: React.ReactNode) => (
    <button className={'ico' + (on ? ' on' : '')} title={label} aria-label={label} aria-pressed={on} onMouseDown={(e) => e.preventDefault()} onClick={act} disabled={!editor}>
      {content}
    </button>
  );
  const ib = (label: string, icon: IconName, on: boolean, act: () => void) => btn(label, on, act, <Icon name={icon} />);

  const link = () => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = prompt(t('toolbar.linkPrompt'), prev ?? 'https://');
    if (url === null) return;
    if (!url) run((c) => c.unsetLink());
    else run((c) => c.extendMarkRange('link').setLink({ href: url }));
  };
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

  return (
    <div className="toolbar" role="toolbar" aria-label={t('toolbar.label')}>
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
        <option value="h1">{t('toolbar.h1')}</option>
        <option value="h2">{t('toolbar.h2')}</option>
        <option value="h3">{t('toolbar.h3')}</option>
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
    </div>
  );
}

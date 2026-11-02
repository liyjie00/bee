import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/http';
import type { DocumentType } from '../api/types';
import { useSession, useTree } from '../state/session';
import { errMsg, useToast } from '../state/toast';
import { Icon } from './Icon';
import { ContextMenu, type MenuEntry } from './Menu';
import { TemplatesDialog } from './TemplatesDialog';
import { useT } from '../i18n';
import { pendingBoardImports, pickFile } from '../lib/download';

const ACCEPT = {
  md: '.md,.markdown,.txt,text/markdown,text/plain',
  docx: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: '.html,.htm,text/html',
  excalidraw: '.excalidraw,application/json',
};

/** Creating docs in a folder: blank, from a template, or by importing a file. */
export function useCreate(folderId: string | null, after?: () => void) {
  const { workspace } = useSession();
  const { reload } = useTree();
  const nav = useNavigate();
  const toast = useToast();
  const t = useT();
  const [templates, setTemplates] = useState(false);
  const ws = workspace?.id ?? '';

  const open = async (id: string) => {
    await reload();
    nav(`/d/${id}`);
    after?.();
  };
  async function create(type: DocumentType, extra?: { title?: string; markdown?: string }) {
    try {
      const d = await api.createDocument({ workspaceId: ws, folderId, type, title: extra?.title ?? (type === 'whiteboard' ? t('tree.newBoardTitle') : ''), markdown: extra?.markdown });
      await open(d.id);
    } catch (e) {
      toast(errMsg(e));
    }
  }
  async function importFrom(kind: keyof typeof ACCEPT) {
    const f = await pickFile(ACCEPT[kind]);
    if (!f) return;
    try {
      if (kind === 'excalidraw') {
        const d = await api.createDocument({ workspaceId: ws, folderId, type: 'whiteboard', title: f.name.replace(/\.(excalidraw|json)$/i, '') });
        pendingBoardImports.set(d.id, f);
        return await open(d.id);
      }
      const { importFile } = await import('../lib/importDoc');
      const im = await importFile(f);
      if (!im.images.size) {
        const d = await api.createDocument({ workspaceId: ws, folderId, type: 'doc', title: im.title, markdown: im.markdown });
        return await open(d.id);
      }
      // Word files carry their images: upload them to the new doc, then fill it in.
      const d = await api.createDocument({ workspaceId: ws, folderId, type: 'doc', title: im.title });
      let md = im.markdown;
      for (const [src, blob] of im.images) {
        const ext = blob.type.split('/')[1] ?? 'png';
        const up = await api.upload(d.id, new File([blob], `image.${ext}`, { type: blob.type }));
        md = md.split(src).join(up.url);
      }
      await api.editMarkdown(d.id, md.replace(/^#\s+.+\n+/, ''));
      await open(d.id);
    } catch (e) {
      toast(errMsg(e));
    }
  }
  /** `basics: false` leaves out blank doc and whiteboard, for menus next to their own buttons. */
  const items = (opts: { folder?: () => void; basics?: boolean } = {}): MenuEntry[] => [
    ...(opts.basics === false ? [] : [{ label: t('new.doc'), icon: 'doc' as const, onSelect: () => create('doc') }]),
    { label: t('new.fromTemplate'), icon: 'note', onSelect: () => setTemplates(true) },
    ...(opts.basics === false ? [] : [{ label: t('new.board'), icon: 'board' as const, onSelect: () => create('whiteboard') }]),
    ...(opts.folder ? [{ label: t('new.folder'), icon: 'folder' as const, onSelect: opts.folder }] : []),
    '-',
    { caption: t('new.import') },
    { label: 'Markdown', icon: 'code', hint: '.md', onSelect: () => importFrom('md') },
    { label: 'Word', icon: 'doc', hint: '.docx', onSelect: () => importFrom('docx') },
    { label: t('new.html'), icon: 'globe', hint: '.html', onSelect: () => importFrom('html') },
    { label: t('new.excalidraw'), icon: 'board', hint: '.excalidraw', onSelect: () => importFrom('excalidraw') },
  ];
  const dialog = templates ? (
    <TemplatesDialog onClose={() => setTemplates(false)} onUse={(title, markdown) => create('doc', { title: title === 'Untitled' ? '' : title, markdown })} />
  ) : null;
  return { create, items, dialog, openTemplates: () => setTemplates(true) };
}

/** "New" button + dropdown: document, template, whiteboard, folder, imports. */
export function NewMenu({ folderId }: { folderId: string | null }) {
  const { workspace } = useSession();
  const { reload } = useTree();
  const toast = useToast();
  const t = useT();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const { items, dialog } = useCreate(folderId);

  async function folder() {
    try {
      await api.createFolder({ workspaceId: workspace?.id ?? '', parentId: folderId, name: t('tree.newFolderName') });
      await reload();
    } catch (e) {
      toast(errMsg(e));
    }
  }
  return (
    <>
      <button
        className="btn primary"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPos({ x: r.right - 210, y: r.bottom + 6 });
        }}
      >
        <Icon name="plus" />
        {t('new.button')}
      </button>
      {pos && <ContextMenu {...pos} onClose={() => setPos(null)} items={items({ folder })} />}
      {dialog}
    </>
  );
}

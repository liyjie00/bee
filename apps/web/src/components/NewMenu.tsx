import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/http';
import type { DocumentType } from '../api/types';
import { useSession, useTree } from '../state/session';
import { errMsg, useToast } from '../state/toast';
import { Icon } from './Icon';
import { ContextMenu } from './Menu';
import { useT } from '../i18n';

/** "New" button + dropdown: document, whiteboard, folder, Markdown import. */
export function NewMenu({ folderId }: { folderId: string | null }) {
  const { workspace } = useSession();
  const { reload } = useTree();
  const nav = useNavigate();
  const toast = useToast();
  const t = useT();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ws = workspace?.id ?? '';

  async function create(type: DocumentType, extra?: { title?: string; markdown?: string }) {
    try {
      const d = await api.createDocument({ workspaceId: ws, folderId, type, title: extra?.title ?? (type === 'whiteboard' ? t('tree.newBoardTitle') : ''), markdown: extra?.markdown });
      await reload();
      nav(`/d/${d.id}`);
    } catch (e) {
      toast(errMsg(e));
    }
  }
  function importMd() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,text/markdown,text/plain';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const markdown = await f.text();
      const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? f.name.replace(/\.(md|markdown|txt)$/i, '');
      await create('doc', { title, markdown });
    };
    input.click();
  }
  async function folder() {
    try {
      await api.createFolder({ workspaceId: ws, parentId: folderId, name: t('tree.newFolderName') });
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
          setPos({ x: r.right - 190, y: r.bottom + 6 });
        }}
      >
        <Icon name="plus" />
        {t('new.button')}
      </button>
      {pos && (
        <ContextMenu
          {...pos}
          onClose={() => setPos(null)}
          items={[
            { label: t('new.doc'), icon: 'doc', onSelect: () => create('doc') },
            { label: t('new.board'), icon: 'board', onSelect: () => create('whiteboard') },
            { label: t('new.folder'), icon: 'folder', onSelect: folder },
            '-',
            { label: t('new.importMd'), icon: 'code', onSelect: importMd },
          ]}
        />
      )}
    </>
  );
}

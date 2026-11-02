import { useEffect, useMemo, useState } from 'react';
import type { DocumentDTO } from '../api/types';
import { useTree } from '../state/session';
import { Icon } from './Icon';
import { useT } from '../i18n';

/** Picks one of the workspace's standalone whiteboards to embed in a document. */
export function WhiteboardPicker({ excludeId, onPick, onClose }: { excludeId: string; onPick(doc: DocumentDTO): void; onClose(): void }) {
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const tree = useTree();
  const t = useT();

  const boards = useMemo(() => {
    const lower = q.trim().toLowerCase();
    return tree.tree.documents
      .filter((d) => d.type === 'whiteboard' && d.id !== excludeId)
      .filter((d) => !lower || (d.title || t('common.untitled')).toLowerCase().includes(lower))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [tree.tree.documents, q, excludeId]);
  useEffect(() => setHl(0), [boards]);

  const pick = (d: DocumentDTO | undefined) => d && onPick(d);
  return (
    <div className="search-pop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-box" role="dialog" aria-label={t('wbpick.label')}>
        <input
          autoFocus
          placeholder={t('wbpick.placeholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') setHl((i) => Math.min(i + 1, boards.length - 1));
            if (e.key === 'ArrowUp') setHl((i) => Math.max(i - 1, 0));
            if (e.key === 'Enter') pick(boards[hl]);
          }}
        />
        <div className="res">
          {boards.length === 0 && <p style={{ color: 'var(--fg-3)', padding: '0.5rem 0.625rem', margin: 0 }}>{t('wbpick.none')}</p>}
          {boards.map((d, i) => (
            <button key={d.id} className={i === hl ? 'hl' : ''} onMouseEnter={() => setHl(i)} onClick={() => pick(d)}>
              <Icon name="board" />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title || t('common.untitled')}</span>
              <small>{tree.path(d.folderId).map((f) => f.name).join(' / ')}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

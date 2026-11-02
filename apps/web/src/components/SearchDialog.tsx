import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/http';
import type { SearchHit } from '../api/types';
import { useTree } from '../state/session';
import { Icon, docIcon } from './Icon';
import { useT } from '../i18n';

export function SearchDialog({ workspaceId, onClose }: { workspaceId: string; onClose(): void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hl, setHl] = useState(0);
  const { tree } = useTree();
  const nav = useNavigate();
  const t = useT();

  useEffect(() => {
    const s = q.trim();
    if (!s) {
      // empty query: most recently edited documents from the tree
      setHits(
        [...tree.documents]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 8)
          .map((document) => ({ document, snippet: '' })),
      );
      return;
    }
    const t = setTimeout(() => {
      api
        .search(workspaceId, s)
        .then((r) => setHits(r))
        .catch(() => {
          const lower = s.toLowerCase();
          setHits(tree.documents.filter((d) => d.title.toLowerCase().includes(lower)).map((document) => ({ document, snippet: '' })));
        });
    }, 180);
    return () => clearTimeout(t);
  }, [q, workspaceId, tree.documents]);
  useEffect(() => setHl(0), [hits]);

  const go = (h: SearchHit | undefined) => {
    if (!h) return;
    onClose();
    nav(`/d/${h.document.id}`);
  };
  return (
    <div className="search-pop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-box" role="dialog" aria-label={t('search.label')}>
        <input
          autoFocus
          placeholder={t('search.placeholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') setHl((i) => Math.min(i + 1, hits.length - 1));
            if (e.key === 'ArrowUp') setHl((i) => Math.max(i - 1, 0));
            if (e.key === 'Enter') go(hits[hl]);
          }}
        />
        <div className="res">
          {hits.length === 0 && <p style={{ color: 'var(--fg-3)', padding: '8px 10px', margin: 0 }}>{t('search.none')}</p>}
          {hits.map((h, i) => (
            <button key={h.document.id} className={i === hl ? 'hl' : ''} onMouseEnter={() => setHl(i)} onClick={() => go(h)}>
              <Icon name={docIcon(h.document.type)} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block' }}>{h.document.title || t('common.untitled')}</span>
                {h.snippet && (
                  <span style={{ display: 'block', color: 'var(--fg-3)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {h.snippet}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

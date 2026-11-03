import { useEffect, useState } from 'react';
import { api } from '../api/http';
import { teams } from '../api/teams';
import type { FolderDTO, WorkspaceDTO } from '../api/types';
import { useSession } from '../state/session';
import { errMsg } from '../state/toast';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { SpaceTile, useSpaceName } from './Spaces';

type Target = { workspaceId: string; folderId: string | null };

/**
 * Moves a document or folder into another space (or another folder there). Teams the user can
 * only view are left out, since they cannot add things there.
 */
export function MoveToSpaceDialog({
  item,
  onClose,
  onMoved,
}: {
  item: { kind: 'doc' | 'folder'; id: string; name: string; workspaceId: string; folderId: string | null };
  onClose(): void;
  onMoved(to: Target): void;
}) {
  const t = useT();
  const spaceName = useSpaceName();
  const { session } = useSession();
  const spaces = (session?.workspaces ?? []).filter((w) => w.kind !== 'team' || w.role !== 'viewer');
  const [folders, setFolders] = useState<Record<string, FolderDTO[]>>({});
  const [target, setTarget] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    for (const w of spaces)
      api.tree(w.id).then(
        (tr) => setFolders((f) => ({ ...f, [w.id]: tr.folders.filter((x) => x.role === 'owner' || x.role === 'editor') })),
        () => {},
      );
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  const blocked = (w: string, list: FolderDTO[]) => {
    const out = new Set<string>();
    if (item.kind !== 'folder' || w !== item.workspaceId) return out;
    const walk = (id: string) => {
      out.add(id);
      list.filter((f) => f.parentId === id).forEach((c) => walk(c.id));
    };
    walk(item.id);
    return out;
  };
  const here = (x: Target) => x.workspaceId === item.workspaceId && x.folderId === item.folderId;
  const same = (a: Target | null, b: Target) => !!a && a.workspaceId === b.workspaceId && a.folderId === b.folderId;
  const destSpace = target && spaces.find((w) => w.id === target.workspaceId);
  const destName = target?.folderId
    ? folders[target.workspaceId]?.find((f) => f.id === target.folderId)?.name
    : destSpace && spaceName(destSpace);

  async function move() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      if (item.kind === 'doc') await teams.moveDocument(item.id, target.workspaceId, target.folderId);
      else if (target.workspaceId === item.workspaceId) await api.updateFolder(item.id, { parentId: target.folderId });
      else await teams.moveFolder(item.id, target.workspaceId, target.folderId);
      onMoved(target);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  const option = (x: Target, depth: number, label: string, icon: 'folder' | null, w?: WorkspaceDTO) => {
    const disabled = here(x);
    return (
      <button
        key={`${x.workspaceId}:${x.folderId}`}
        role="radio"
        aria-checked={same(target, x)}
        className={'move-opt' + (same(target, x) ? ' on' : '')}
        style={{ paddingLeft: `${0.625 + depth * 1.125}rem` }}
        disabled={disabled}
        onClick={() => setTarget(x)}
      >
        {w ? <SpaceTile space={w} size="sm" /> : icon && <Icon name={icon} />}
        <span className="nm">{label}</span>
        {disabled && <small>{t('move.current')}</small>}
        {same(target, x) && <Icon name="check" className="tick" />}
      </button>
    );
  };
  const tree = (w: WorkspaceDTO) => {
    const list = folders[w.id] ?? [];
    const skip = blocked(w.id, list);
    const out: JSX.Element[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const f of list.filter((x) => x.parentId === parent && !skip.has(x.id)).sort((a, b) => a.sort - b.sort))
        if (depth < 6) {
          out.push(option({ workspaceId: w.id, folderId: f.id }, depth, f.name, 'folder'));
          walk(f.id, depth + 1);
        }
    };
    walk(null, 1);
    return out;
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="moveTitle">
        <div className="mh">
          <h3 id="moveTitle">{t('move.title', { name: item.name || t('common.untitled') })}</h3>
          <button className="ico" aria-label={t('common.close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="mb">
          <div className="move-list" role="radiogroup" aria-label={t('move.title', { name: item.name })}>
            {spaces.map((w) => (
              <div key={w.id}>
                {option({ workspaceId: w.id, folderId: null }, 0, spaceName(w), null, w)}
                {tree(w)}
              </div>
            ))}
          </div>
          {destSpace && destSpace.id !== item.workspaceId && (
            <div className="move-note">
              <Icon name="users" />
              <span>
                {destSpace.kind === 'team'
                  ? t('move.toTeam', { name: destSpace.name, n: destSpace.memberCount })
                  : t('move.toPersonal')}
              </span>
            </div>
          )}
          {error && <div className="err" role="alert">{error}</div>}
        </div>
        <div className="mf">
          <span />
          <span style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button className="btn primary" disabled={!target || busy} onClick={move}>
              {target ? t('move.submitTo', { name: destName ?? '' }) : t('move.submit')}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

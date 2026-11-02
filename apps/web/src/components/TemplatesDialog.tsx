import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/http';
import type { TemplateDTO } from '../api/types';
import { renderChatMarkdown } from '../lib/chatMarkdown';
import { BUILTIN_TEMPLATES } from '../lib/templates';
import { useAgo, useT } from '../i18n';
import { useSession } from '../state/session';
import { errMsg, useToast } from '../state/toast';
import { Icon } from './Icon';

interface Choice {
  key: string;
  title: string;
  description: string;
  markdown: string;
  mine?: TemplateDTO;
}

/** "New from template": Bee's built-in templates and the workspace's saved ones. */
export function TemplatesDialog({ onUse, onClose }: { onUse(title: string, markdown: string): Promise<void>; onClose(): void }) {
  const t = useT();
  const ago = useAgo();
  const toast = useToast();
  const { workspace } = useSession();
  const [tab, setTab] = useState<'bee' | 'mine'>('bee');
  const [mine, setMine] = useState<TemplateDTO[] | null>(null);
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (workspace) api.templates(workspace.id).then(setMine, () => setMine([]));
  }, [workspace?.id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const list: Choice[] = useMemo(
    () =>
      tab === 'bee'
        ? BUILTIN_TEMPLATES.map((b) => ({ key: b.id, title: b.title, description: b.description, markdown: b.markdown }))
        : (mine ?? []).map((m) => ({
            key: m.id,
            title: m.title,
            description: t('tpl.savedBy', { name: m.createdBy?.name ?? '', time: ago(m.createdAt) }),
            markdown: m.markdown,
            mine: m,
          })),
    [tab, mine],
  );
  const sel = list[Math.min(pick, list.length - 1)];
  const preview = useMemo(() => (sel ? renderChatMarkdown(sel.markdown) : ''), [sel?.key, sel?.markdown]);

  const use = async () => {
    if (!sel || busy) return;
    setBusy(true);
    try {
      await onUse(sel.title, sel.markdown);
      onClose();
    } catch (e) {
      toast(errMsg(e));
      setBusy(false);
    }
  };
  const remove = async (m: TemplateDTO) => {
    if (!confirm(t('tpl.confirmDelete', { name: m.title }))) return;
    try {
      await api.deleteTemplate(m.id);
      setMine((cur) => cur?.filter((x) => x.id !== m.id) ?? null);
      setPick(0);
    } catch (e) {
      toast(errMsg(e));
    }
  };

  // Portal: the sidebar (a transformed drawer on phones) would otherwise contain the fixed overlay.
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tpl" role="dialog" aria-label={t('tpl.title')}>
        <nav className="tpl-nav">
          <h2>{t('tpl.title')}</h2>
          <button className={tab === 'bee' ? 'on' : ''} onClick={() => (setTab('bee'), setPick(0))}>
            {t('tpl.bee')} <span>{BUILTIN_TEMPLATES.length}</span>
          </button>
          <button className={tab === 'mine' ? 'on' : ''} onClick={() => (setTab('mine'), setPick(0))}>
            {t('tpl.mine')} <span>{mine?.length ?? ''}</span>
          </button>
          <div className="spacer" />
          <p>{t('tpl.hint')}</p>
        </nav>
        <section className="tpl-grid">
          <div className="tpl-head">
            <b>{tab === 'bee' ? t('tpl.bee') : t('tpl.mine')}</b>
            <button className="ico" aria-label={t('common.close')} onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
          {tab === 'mine' && mine?.length === 0 && <p className="tpl-empty">{t('tpl.mineEmpty')}</p>}
          <div className="tpl-cards">
            {list.map((c, i) => (
              <button key={c.key} className={'tpl-card' + (c === sel ? ' on' : '')} onClick={() => setPick(i)} onDoubleClick={use}>
                <span className="tpl-thumb" aria-hidden="true">
                  <b>{c.title}</b>
                  <i style={{ width: '80%' }} />
                  <i style={{ width: '60%' }} />
                  <i style={{ width: '70%' }} />
                </span>
                <span className="tpl-meta">
                  <span>{c.title}</span>
                  <small>{c.description}</small>
                </span>
              </button>
            ))}
          </div>
        </section>
        <aside className="tpl-side">
          <div className="tpl-preview">
            <div className="tpl-cap">{t('tpl.preview')}</div>
            {sel && (
              <>
                <h3>{sel.title}</h3>
                <div className="tpl-md" dangerouslySetInnerHTML={{ __html: preview }} />
              </>
            )}
          </div>
          <div className="tpl-actions">
            {sel?.mine?.canDelete && (
              <button className="btn danger-text" onClick={() => remove(sel.mine!)}>
                {t('tpl.delete')}
              </button>
            )}
            <div className="spacer" />
            <button className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button className="btn primary" disabled={!sel || busy} onClick={use}>
              {t('tpl.use')}
            </button>
          </div>
        </aside>
      </div>
    </div>,
    document.body,
  );
}

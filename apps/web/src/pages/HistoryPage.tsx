import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { can } from '@bee/shared';
import { api } from '../api/http';
import type { DocumentDTO, VersionContent, VersionDTO } from '../api/types';
import { Icon } from '../components/Icon';
import { Avatar } from '../components/Menu';
import { TopBar } from '../components/TopBar';
import { diffDocs, diffStats, toBlocks, type DiffBlock } from '../lib/prosemirror';
import { dayLabel, hm } from '../lib/time';
import { useI18n, type MessageKey } from '../i18n';
import { useTree } from '../state/session';
import { errMsg, useToast } from '../state/toast';

const KIND_KEY: Record<VersionDTO['kind'], MessageKey> = { auto: 'history.auto', manual: 'history.manual', restore: 'history.restore' };

function Rendered({ blocks }: { blocks: DiffBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        const inner = b.pieces.map((p, j) =>
          p.op === 'ins' ? <ins key={j}>{p.text}</ins> : p.op === 'del' ? <del key={j}>{p.text}</del> : <Fragment key={j}>{p.text}</Fragment>,
        );
        if (b.kind === 'h1') return <h1 key={i}>{inner}</h1>;
        if (b.kind === 'h2') return <h2 key={i}>{inner}</h2>;
        if (b.kind === 'h3') return <h3 key={i}>{inner}</h3>;
        if (b.kind === 'h4') return <h4 key={i}>{inner}</h4>;
        if (b.kind === 'h5') return <h5 key={i}>{inner}</h5>;
        if (b.kind === 'h6') return <h6 key={i}>{inner}</h6>;
        if (b.kind === 'hr') return <hr key={i} />;
        if (b.kind === 'code') return <pre key={i}><code>{inner}</code></pre>;
        if (b.kind === 'quote') return <blockquote key={i}>{inner}</blockquote>;
        if (b.kind === 'li') return <ul key={i} style={{ margin: '0 0 0.375rem' }}><li>{inner}</li></ul>;
        if (b.kind === 'task')
          return (
            <ul key={i} className="checks" style={{ margin: '0 0 2px' }}>
              <li className={b.checked ? 'done' : ''}>
                <span className="box">{b.checked && <Icon name="check" size={11} />}</span>
                <span>{inner}</span>
              </li>
            </ul>
          );
        if (b.kind === 'embed') return <p key={i} style={{ color: 'var(--fg-3)' }}>{inner}</p>;
        return <p key={i} className="diff-block">{inner}</p>;
      })}
    </>
  );
}

const asSame = (content: unknown): DiffBlock[] =>
  toBlocks(content).map((b) => ({ kind: b.kind, checked: b.checked, op: 'same', pieces: [{ text: b.text, op: 'same' }] }));

export function HistoryPage() {
  const { docId = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const tree = useTree();
  const { t, lang } = useI18n();
  const kindText = (k: VersionDTO['kind']) => t(KIND_KEY[k]);
  // Older restore points were saved with an English "Before restoring <ISO time>" label.
  const verLabel = (v: Pick<VersionDTO, 'kind' | 'label'>) =>
    v.label && !(v.kind === 'restore' && v.label.startsWith('Before restoring ')) ? v.label : kindText(v.kind);
  const [doc, setDoc] = useState<DocumentDTO | null>(null);
  const [versions, setVersions] = useState<VersionDTO[] | null>(null);
  // Narrow screens: the version list is an overlay opened from the top bar.
  const [listOpen, setListOpen] = useState(false);
  // In-page instead of prompt()/confirm(): embedded browsers often block native dialogs, and the buttons did nothing.
  const [naming, setNaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, VersionContent>>({});
  const [current, setCurrent] = useState<VersionContent | null>(null);
  const [highlight, setHighlight] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [d, vs] = await Promise.all([api.getDocument(docId), api.versions(docId)]);
    setDoc(d);
    const sorted = [...vs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    setVersions(sorted);
    return sorted;
  };
  useEffect(() => {
    setSel(null);
    setContents({});
    load().then(
      (vs) => setSel((s) => s ?? vs[0]?.id ?? null),
      (e) => setError(errMsg(e)),
    );
    // live content: the API serves it as version "current"; fall back to the newest snapshot
    api.versionContent(docId, 'current').then(setCurrent, () => setCurrent(null));
  }, [docId]);

  // fetch content for the selection (and up to 30 versions for the +/− stats)
  useEffect(() => {
    if (!versions) return;
    const want = versions.slice(0, 30).map((v) => v.id);
    if (sel && !want.includes(sel)) want.push(sel);
    for (const id of want)
      if (!contents[id])
        api.versionContent(docId, id).then(
          (c) => setContents((m) => ({ ...m, [id]: c })),
          () => {},
        );
  }, [versions, sel, docId]);

  const head = current ?? (versions?.[0] ? contents[versions[0].id] : undefined) ?? null;
  const selected = sel ? contents[sel] : undefined;
  const isHead = !current && sel === versions?.[0]?.id;
  const blocks = useMemo(() => {
    if (!selected) return null;
    if (!highlight || !head || isHead) return asSame(selected.content);
    // what changed from this version to the current one
    return diffDocs(selected.content, head.content);
  }, [selected, head, highlight, isHead]);

  const stats = (v: VersionDTO, i: number) => {
    const prev = versions?.[i + 1];
    const a = prev ? contents[prev.id] : undefined;
    const b = contents[v.id];
    if (!b || (prev && !a)) return null;
    return diffStats(diffDocs(a?.content ?? null, b.content));
  };

  async function nameCurrent(label: string) {
    if (!label.trim()) return;
    setNaming(null);
    try {
      const v = await api.createVersion(docId, label.trim());
      const vs = await load();
      setSel(v.id ?? vs[0]?.id ?? null);
      toast(t('history.named'));
    } catch (e) {
      toast(errMsg(e));
    }
  }
  async function restore() {
    if (!sel || !selected) return;
    setConfirming(false);
    setBusy(true);
    try {
      await api.restoreVersion(docId, sel);
      toast(t('common.restored'));
      nav(`/d/${docId}`);
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const title = tree.doc(docId)?.title ?? doc?.title ?? '';
  const crumbs = [
    ...tree.path(doc?.folderId).map((f) => ({ label: f.name, to: `/f/${f.id}` })),
    { label: title || t('common.untitled'), to: `/d/${docId}` },
    { label: t('history.title') },
  ];
  const selVer = versions?.find((v) => v.id === sel);
  let lastDay = '';

  return (
    <main className="main">
      <TopBar crumbs={crumbs}>
        <button className={'ico narrow-only' + (listOpen ? ' on' : '')} aria-label={t('history.list')} title={t('history.list')} onClick={() => setListOpen((o) => !o)}>
          <Icon name="list" />
        </button>
        <button className="ico on" aria-label={t('history.close')} title={t('history.back')} onClick={() => nav(`/d/${docId}`)}>
          <Icon name="clock" />
        </button>
      </TopBar>
      <section className="view" style={{ overflow: 'hidden' }}>
        {error ? (
          <div className="empty">
            <h2>{t('history.loadFailed')}</h2>
            <p>{error}</p>
          </div>
        ) : (
          <div className="hist">
            <div style={{ overflow: 'auto', minWidth: 0 }}>
              <div className="hbanner">
                <Icon name="clock" />
                <span>
                  {selVer ? (
                    <>
                      {t('history.viewing')} <b>“{verLabel(selVer)}”</b> · {dayLabel(t, selVer.createdAt, lang)} {hm(new Date(selVer.createdAt))}
                      {highlight && !isHead ? t('history.vsCurrent') : ''}
                    </>
                  ) : (
                    t('history.none')
                  )}
                </span>
                <span className="spacer" />
                {confirming && selVer ? (
                  <>
                    <span role="alert">{t('history.restoreConfirm', { label: verLabel(selVer) })}</span>
                    <button className="btn" onClick={() => setConfirming(false)}>
                      {t('common.cancel')}
                    </button>
                    <button className="btn primary" disabled={busy || !selected} onClick={restore} autoFocus>
                      <Icon name="restore" />
                      {t('history.restoreThis')}
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn" onClick={() => nav(`/d/${docId}`)}>
                      {t('history.backToCurrent')}
                    </button>
                    {doc && can.edit(doc.role) && selVer && (
                      <button className="btn primary" disabled={busy || !selected} onClick={() => setConfirming(true)}>
                        <Icon name="restore" />
                        {t('history.restoreThis')}
                      </button>
                    )}
                  </>
                )}
              </div>
              <article className="page">
                <h1 className="doc-title">{title || t('common.untitled')}</h1>
                <div className="prose">{blocks ? <Rendered blocks={blocks} /> : selVer ? <p className="ph">{t('app.loading')}</p> : null}</div>
              </article>
            </div>
            <aside className={'vlist' + (listOpen ? ' open' : '')} aria-label={t('history.list')}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.25rem 0.375rem' }}>
                <b style={{ fontSize: '0.875rem' }}>{t('history.title')}</b>
                <span className="spacer" />
                {doc && can.edit(doc.role) && (
                  <button className="btn" style={{ fontSize: '0.75rem', padding: '0.1875rem 0.5rem' }} onClick={() => setNaming((n) => (n === null ? '' : null))}>
                    <Icon name="plus" />
                    {t('history.nameCurrent')}
                  </button>
                )}
                <button className="ico narrow-only" aria-label={t('common.close')} onClick={() => setListOpen(false)}>
                  <Icon name="x" />
                </button>
              </div>
              {naming !== null && (
                <form
                  className="name-ver"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void nameCurrent(naming);
                  }}
                >
                  <input
                    className="field-in"
                    autoFocus
                    value={naming}
                    placeholder={t('history.namePrompt')}
                    aria-label={t('history.namePrompt')}
                    maxLength={200}
                    onChange={(e) => setNaming(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && setNaming(null)}
                  />
                  <button className="btn primary" type="submit" disabled={!naming.trim()}>
                    {t('history.nameCurrent')}
                  </button>
                </form>
              )}
              <button className="toggle" style={{ padding: '0.5rem 0.375rem 0', fontSize: '0.75rem' }} onClick={() => setHighlight((h) => !h)} aria-pressed={highlight}>
                <span className={'sw' + (highlight ? ' on' : '')} />
                {t('history.highlight')}
              </button>
              {versions?.length === 0 && <p style={{ color: 'var(--fg-3)', fontSize: '0.8125rem', padding: '0.5rem 0.375rem' }}>{t('history.empty')}</p>}
              {versions?.map((v, i) => {
                const day = dayLabel(t, v.createdAt, lang);
                const showDay = day !== lastDay;
                lastDay = day;
                const st = stats(v, i);
                return (
                  <Fragment key={v.id}>
                    {showDay && <div className="vday">{day}</div>}
                    <button className={'ver' + (v.kind === 'manual' ? ' named' : '') + (v.id === sel ? ' on' : '')} onClick={() => {
                        setSel(v.id);
                        setListOpen(false);
                      }}>
                      <span className="dot" />
                      <span>
                        <b>{verLabel(v)}</b>
                        <small>
                          {v.authors[0] && <Avatar sm name={v.authors[0].name} color={v.authors[0].color} url={v.authors[0].avatarUrl} />}
                          {v.authors.map((a) => a.name).join(', ') || t('history.system')} · {hm(new Date(v.createdAt))}
                          {st && (st.added || st.removed) ? (
                            <span className="stat">
                              <span className="p">+{st.added}</span> <span className="m">−{st.removed}</span>
                            </span>
                          ) : null}
                        </small>
                      </span>
                    </button>
                  </Fragment>
                );
              })}
            </aside>
          </div>
        )}
      </section>
    </main>
  );
}

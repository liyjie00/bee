import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, HttpError } from '../api/http';
import { prefetchDoc } from '../lib/doc-cache';
import type { DocumentDTO } from '../api/types';
import { TopBar } from '../components/TopBar';
import { WhiteboardPicker } from '../components/WhiteboardPicker';
import { errMsg, useToast } from '../state/toast';
import { useSession, useTree } from '../state/session';
import { DocView } from './DocView';
import { useT } from '../i18n';

export function DocPage() {
  const { docId = '' } = useParams();
  const { session, workspace } = useSession();
  const tree = useTree();
  const t = useT();
  const [fetched, setDoc] = useState<DocumentDTO | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const pickResolve = useRef<((r: { documentId: string } | null) => void) | null>(null);
  const endPick = (r: { documentId: string } | null) => {
    pickResolve.current?.(r);
    pickResolve.current = null;
    setPicking(false);
  };

  // Content starts loading in parallel with the metadata, and before the editor's effects run
  // (child effects run first), so the editor picks it up as its snapshot.
  useMemo(() => prefetchDoc(docId), [docId]);
  useEffect(() => {
    setDoc(null);
    setError(null);
    api.getDocument(docId).then(setDoc, (e) =>
      setError({ status: e instanceof HttpError ? e.status : 0, message: e instanceof Error ? e.message : String(e) }),
    );
  }, [docId]);

  if (error)
    return (
      <main className="main">
        <TopBar crumbs={[{ label: t('kind.doc') }]} />
        <div className="empty">
          <h2>{error.status === 404 || error.status === 403 ? t('doc.noAccess') : t('doc.loadFailed')}</h2>
          <p style={{ margin: 0 }}>{error.status === 404 || error.status === 403 ? t('doc.noAccessHint') : error.message}</p>
        </div>
      </main>
    );
  // The tree already has this document's metadata: render from it while the fetch refreshes it.
  const doc = fetched ?? (error ? null : (tree.doc(docId) ?? null));
  if (!doc)
    return (
      <main className="main">
        <TopBar crumbs={[{ label: '…' }]} />
        <div className="empty">{t('app.loading')}</div>
      </main>
    );

  const live = tree.doc(doc.id);
  const title = live?.title ?? doc.title;
  const crumbs = [...tree.path(doc.folderId).map((f) => ({ label: f.name, to: `/f/${f.id}` })), { label: title || t('common.untitled') }];
  return (
    <>
    <DocView
      doc={{ ...doc, title }}
      me={session?.user ?? null}
      crumbs={crumbs}
      onTitle={(t) => tree.patchDoc(doc.id, { title: t })}
      onCreateWhiteboard={async () => {
        const d = await api.createDocument({ workspaceId: workspace?.id ?? doc.workspaceId, folderId: doc.folderId, parentDocumentId: doc.id, type: 'whiteboard', title: t('tree.newBoardTitle') });
        return { documentId: d.id };
      }}
      onPickWhiteboard={() =>
        new Promise((resolve) => {
          pickResolve.current?.(null);
          pickResolve.current = resolve;
          setPicking(true);
        })
      }
      whiteboardTitle={(id) => tree.doc(id)?.title || undefined}
    />
    {picking && (
      <WhiteboardPicker
        excludeId={doc.id}
        onClose={() => endPick(null)}
        onPick={(board) => {
          api.embedDocument(doc.id, board.id).then(
            () => endPick({ documentId: board.id }),
            (e) => {
              toast(errMsg(e));
              endPick(null);
            },
          );
        }}
      />
    )}
    </>
  );
}

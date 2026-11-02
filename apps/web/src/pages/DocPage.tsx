import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, HttpError } from '../api/http';
import type { DocumentDTO } from '../api/types';
import { TopBar } from '../components/TopBar';
import { useSession, useTree } from '../state/session';
import { DocView } from './DocView';
import { useT } from '../i18n';

export function DocPage() {
  const { docId = '' } = useParams();
  const { session, workspace } = useSession();
  const tree = useTree();
  const t = useT();
  const [doc, setDoc] = useState<DocumentDTO | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

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
    <DocView
      doc={{ ...doc, title }}
      me={session?.user ?? null}
      crumbs={crumbs}
      onTitle={(t) => tree.patchDoc(doc.id, { title: t })}
      onCreateWhiteboard={async () => {
        const d = await api.createDocument({ workspaceId: workspace?.id ?? doc.workspaceId, folderId: doc.folderId, parentDocumentId: doc.id, type: 'whiteboard', title: t('tree.newBoardTitle') });
        return { documentId: d.id };
      }}
    />
  );
}

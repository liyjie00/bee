import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, HttpError } from '../api/http';
import type { SharedDocDTO } from '../api/types';
import { BeeMark } from '../components/Logo';
import { useSession } from '../state/session';
import { DocView } from './DocView';
import { useT } from '../i18n';

/** /s/:token — a document opened through a share link, signed in or anonymous. */
export function SharePage() {
  const { token = '', docId } = useParams();
  const { session, loading } = useSession();
  const [shared, setShared] = useState<SharedDocDTO | null>(null);
  const [error, setError] = useState<'needLogin' | 'noAccess' | 'invalid' | null>(null);
  const navigate = useNavigate();
  const t = useT();

  useEffect(() => {
    if (loading) return;
    setError(null);
    api.shareToken = token;
    // /s/:token/d/:docId opens a document embedded in the shared one (e.g. a whiteboard)
    const load = docId
      ? api.getDocument(docId).then((document) => ({ document, role: document.role }))
      : api.resolveShare(token);
    // private links answer 400 login_required to signed-out visitors, embedded docs 401
    const needsLogin = (e: unknown) =>
      !session && e instanceof HttpError && (e.status === 401 || e.code === 'login_required');
    load.then(setShared, (e) => {
      // sharing was turned off: signed-in people can request access on the document itself
      if (e instanceof HttpError && e.code === 'link_disabled') {
        const id = e.detail.documentId;
        if (session && typeof id === 'string') navigate(`/d/${id}`, { replace: true });
        else setError('noAccess');
      } else setError(needsLogin(e) ? 'needLogin' : 'invalid');
    });
    return () => {
      api.shareToken = null;
    };
  }, [token, docId, loading, session]);

  if (error)
    return (
      <div className="auth">
        <div className="auth-card" style={{ textAlign: 'center', alignItems: 'center' }}>
          <BeeMark size={40} />
          <h1 style={{ justifyContent: 'center' }}>{t(`share.${error}`)}</h1>
          <p style={{ margin: 0, color: 'var(--fg-3)' }}>
            {t(`share.${error}Hint`)}
          </p>
          <Link className="btn primary" to={`/login?next=${encodeURIComponent(location.pathname + location.hash)}`}>
            {t('common.signIn')}
          </Link>
        </div>
      </div>
    );
  if (!shared) return <div className="empty">{t('app.loading')}</div>;
  return (
    <div className="app" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
      <DocView
        doc={{ ...shared.document, role: shared.role }}
        me={session?.user ?? null}
        shareToken={token}
        crumbs={[{ label: 'bee', to: docId ? `/s/${token}` : undefined }, { label: shared.document.title || t('common.untitled') }]}
        onCreateWhiteboard={async () => {
          const d = await api.createDocument({
            workspaceId: shared.document.workspaceId,
            folderId: shared.document.folderId,
            parentDocumentId: shared.document.id,
            type: 'whiteboard',
            title: t('tree.newBoardTitle'),
          });
          return { documentId: d.id };
        }}
      />
    </div>
  );
}

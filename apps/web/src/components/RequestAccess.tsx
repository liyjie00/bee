import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/http';
import type { AccessRequestDTO, GrantableRole } from '../api/types';
import { useT, type MessageKey } from '../i18n';
import { useSession } from '../state/session';
import { errMsg, useToast } from '../state/toast';
import { Icon } from './Icon';

const ROLES: GrantableRole[] = ['viewer', 'commenter', 'editor'];

/** Shown instead of a doc the signed-in user cannot open: ask its editors for access. */
export function RequestAccess({ docId, onGranted }: { docId: string; onGranted(): void }) {
  const t = useT();
  const toast = useToast();
  const { session } = useSession();
  const [req, setReq] = useState<AccessRequestDTO | null | undefined>(undefined);
  const [role, setRole] = useState<GrantableRole>('editor');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.myAccessRequest(docId).then(setReq, () => setReq(null));
  }, [docId]);
  // While a request is pending, check now and then whether it was granted.
  useEffect(() => {
    if (req?.status !== 'pending') return;
    const timer = setInterval(() => {
      api.myAccessRequest(docId).then((r) => {
        if (r?.status === 'granted') onGranted();
        else setReq(r);
      }, () => {});
    }, 20_000);
    return () => clearInterval(timer);
  }, [req?.status, docId]);

  const send = async () => {
    setBusy(true);
    try {
      setReq(await api.requestAccess(docId, role, message.trim() || undefined));
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  if (req === undefined) return <div className="empty">{t('app.loading')}</div>;
  const pending = req?.status === 'pending';
  return (
    <div className="req-access">
      <Icon name="lock" size={36} />
      {pending ? (
        <>
          <h2>{t('access.sentTitle')}</h2>
          <p>{t('access.sentHint')}</p>
          <div className="req-actions">
            <button className="btn" onClick={() => setReq(null)}>
              {t('access.again')}
            </button>
            <Link className="btn" to="/">
              {t('access.home')}
            </Link>
          </div>
        </>
      ) : (
        <>
          <h2>{t('access.title')}</h2>
          <p>{req?.status === 'declined' ? t('access.declinedHint') : t('access.hint')}</p>
          <label>
            <span>{t('access.role')}</span>
            <select value={role} onChange={(e) => setRole(e.target.value as GrantableRole)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`role.${r}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('access.message')}</span>
            <textarea rows={3} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <div className="req-actions">
            <button className="btn primary" disabled={busy} onClick={send}>
              {t('access.request')}
            </button>
            <Link className="btn" to="/">
              {t('access.home')}
            </Link>
          </div>
          {session && <small>{t('access.as', { email: session.user.email })}</small>}
        </>
      )}
    </div>
  );
}

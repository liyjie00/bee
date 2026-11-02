import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/http';
import { useSession } from '../state/session';
import { errMsg } from '../state/toast';
import { useT } from '../i18n';

/** First stop after signing up with Google: choose a username and a password. */
export function WelcomePage() {
  const { session, loading, setSession } = useSession();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const t = useT();
  const [name, setName] = useState(session?.user.name ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get('next') || '/';
  if (loading) return null;
  if (!session) return <Navigate to="/login" replace />;
  if (!session.user.setupRequired) return <Navigate to={next} replace />;
  const user = session.user;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError(t('welcome.nameRequired'));
    if (password.length < 8) return setError(t('login.passwordTooShort'));
    if (password !== confirm) return setError(t('welcome.mismatch'));
    setBusy(true);
    try {
      const s = await api.setupAccount(name.trim(), password);
      setSession(s);
      nav(next, { replace: true });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function switchAccount() {
    await api.logout().catch(() => {});
    setSession(null);
    nav('/login', { replace: true });
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="welcome-title">{t('welcome.title')}</h1>
        <p style={{ margin: 0, color: 'var(--fg-3)', fontSize: 13.5 }}>{t('welcome.lead')}</p>
        <div className="welcome-who">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />
          ) : (
            <span style={{ background: user.color }}>{(user.name || user.email)[0]!.toUpperCase()}</span>
          )}
          <div>
            <small>{t('welcome.verified')}</small>
            <b>{user.email}</b>
          </div>
        </div>
        <label>
          {t('welcome.name')}
          <input className="field-in" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" autoFocus />
          <span className="hint">{t('welcome.nameHint')}</span>
        </label>
        {/* lets password managers save the new password under this email */}
        <input type="email" value={user.email} autoComplete="username" readOnly hidden />
        <label>
          {t('welcome.password')}
          <input
            className="field-in"
            type="password"
            required
            value={password}
            placeholder={t('welcome.passwordPlaceholder')}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label>
          {t('welcome.confirm')}
          <input className="field-in" type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
        {error && <div className="err" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? t('login.wait') : t('welcome.submit')}
        </button>
        <div className="auth-switch">
          <button type="button" onClick={switchAccount}>
            {t('welcome.switch')}
          </button>
        </div>
      </form>
    </div>
  );
}

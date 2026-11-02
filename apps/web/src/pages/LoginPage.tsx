import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/http';
import { BeeLogo } from '../components/Logo';
import { useSession } from '../state/session';
import { errMsg } from '../state/toast';
import { useT } from '../i18n';

export function LoginPage() {
  const { session, setSession } = useSession();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const t = useT();
  const [mode, setMode] = useState<'login' | 'register'>(params.get('mode') === 'register' ? 'register' : 'login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get('next') || '/';
  // OAuth consent pages are served by the api, outside the SPA, so they need a full page load.
  const external = next.startsWith('/oauth/');
  if (session && external) {
    window.location.replace(next);
    return null;
  }
  if (session) return <Navigate to={next} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === 'register' && password.length < 8) return setError(t('login.passwordTooShort'));
    setBusy(true);
    try {
      const s = mode === 'login' ? await api.login(email, password) : await api.register(name.trim() || email.split('@')[0]!, email, password);
      if (external) return window.location.replace(next);
      setSession(s);
      nav(next, { replace: true });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1 aria-label="bee">
          <BeeLogo height={40} />
        </h1>
        <p style={{ margin: 0, color: 'var(--fg-3)' }}>{mode === 'login' ? t('login.title') : t('login.registerTitle')}</p>
        {mode === 'register' && (
          <label>
            {t('login.name')}
            <input className="field-in" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
        )}
        <label>
          {t('login.email')}
          <input className="field-in" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
        </label>
        <label>
          {t('login.password')}
          <input
            className="field-in"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>
        {error && <div className="err" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? t('login.wait') : mode === 'login' ? t('login.signIn') : t('login.register')}
        </button>
        <div className="switch">
          {mode === 'login' ? t('login.noAccount') : t('login.haveAccount')}
          <button type="button" onClick={() => (setMode(mode === 'login' ? 'register' : 'login'), setError(null))}>
            {mode === 'login' ? t('login.toRegister') : t('login.signIn')}
          </button>
        </div>
      </form>
    </div>
  );
}

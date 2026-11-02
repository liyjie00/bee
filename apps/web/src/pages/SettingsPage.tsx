import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/http';
import { DOC_FONTS, DOC_FONT_SIZES, type UserPrefs } from '@bee/shared';
import type { ApiTokenDTO, ConnectedAppDTO } from '../api/types';
import { Icon } from '../components/Icon';
import { TopBar } from '../components/TopBar';
import { applyDocPrefs } from '../lib/docPrefs';
import { useSession } from '../state/session';
import { copyText, errMsg, useToast } from '../state/toast';
import { useAgo, useT } from '../i18n';

function CopyField({ value }: { value: string }) {
  const t = useT();
  const toast = useToast();
  return (
    <div className="copy-field">
      <code>{value}</code>
      <button className="btn" onClick={async () => toast((await copyText(value)) ? t('settings.copied') : t('common.copyFailed'))}>
        <Icon name="copy" />
        {t('settings.copy')}
      </button>
    </div>
  );
}

/** Document font size and font style, saved on the account. */
function ReadingSection() {
  const t = useT();
  const toast = useToast();
  const { session, setSession } = useSession();
  const prefs = session?.user.prefs ?? {};
  const size = prefs.docFontSize ?? 'medium';
  const font = prefs.docFont ?? 'sans';

  async function save(patch: UserPrefs) {
    applyDocPrefs({ ...prefs, ...patch });
    try {
      setSession(await api.updateMe({ prefs: patch }));
    } catch (e) {
      applyDocPrefs(prefs);
      toast(errMsg(e));
    }
  }

  return (
    <section>
      <h2>{t('settings.readingTitle')}</h2>
      <p className="lead">{t('settings.readingLead')}</p>
      <div className="pref-row">
        <span className="lbl">{t('settings.fontSize')}</span>
        <div className="seg" role="group" aria-label={t('settings.fontSize')}>
          {DOC_FONT_SIZES.map((s) => (
            <button key={s} className={s === size ? 'on' : ''} aria-pressed={s === size} onClick={() => save({ docFontSize: s })}>
              {t(`settings.fontSize.${s}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="pref-row">
        <span className="lbl">{t('settings.font')}</span>
        <div className="seg" role="group" aria-label={t('settings.font')}>
          {DOC_FONTS.map((f) => (
            <button key={f} className={f === font ? 'on' : ''} aria-pressed={f === font} onClick={() => save({ docFont: f })}>
              {t(`settings.font.${f}`)}
            </button>
          ))}
        </div>
      </div>
      <p className="bee-prose pref-preview">{t('settings.preview')}</p>
    </section>
  );
}

/** Account settings: document text, connecting Claude (MCP), connected OAuth apps and personal API tokens. */
export function SettingsPage() {
  const t = useT();
  const ago = useAgo();
  const toast = useToast();
  const [tokens, setTokens] = useState<ApiTokenDTO[] | null>(null);
  const [apps, setApps] = useState<ConnectedAppDTO[] | null>(null);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mcpUrl = `${window.location.origin}/mcp`;

  const load = () => {
    api.tokens().then(setTokens, (e) => toast(errMsg(e)));
    api.connectedApps().then(setApps, (e) => toast(errMsg(e)));
  };
  useEffect(load, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await api.createToken(name.trim());
      setSecret(r.secret);
      setName('');
      load();
    } catch (err) {
      toast(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  const used = (iso: string | null) => (iso ? t('settings.lastUsed', { when: ago(iso) }) : t('settings.neverUsed'));

  return (
    <main className="main">
      <TopBar crumbs={[{ label: t('settings.title') }]} />
      <div className="page settings">
        <h1>{t('settings.title')}</h1>

        <ReadingSection />

        <section>
          <h2>{t('settings.claudeTitle')}</h2>
          <p className="lead">{t('settings.claudeLead')}</p>
          <label className="lbl">{t('settings.mcpUrl')}</label>
          <CopyField value={mcpUrl} />
          <p className="lead" style={{ marginTop: 14 }}>{t('settings.claudeCode')}</p>
          <CopyField value={`claude mcp add --transport http bee ${mcpUrl} --header "Authorization: Bearer <token>"`} />
        </section>

        <section>
          <h2>{t('settings.appsTitle')}</h2>
          {apps && apps.length === 0 && <p className="lead">{t('settings.appsEmpty')}</p>}
          <ul className="rows">
            {apps?.map((a) => (
              <li key={a.id}>
                <div>
                  <b>{a.name}</b>
                  <span>
                    {t('settings.connected', { when: ago(a.createdAt) })} · {used(a.lastUsedAt)}
                  </span>
                </div>
                <button
                  className="btn"
                  onClick={async () => {
                    await api.revokeApp(a.id).then(() => toast(t('settings.revoked')), (e) => toast(errMsg(e)));
                    load();
                  }}
                >
                  {t('settings.revoke')}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>{t('settings.tokensTitle')}</h2>
          <p className="lead">{t('settings.tokensLead')}</p>
          <form className="token-form" onSubmit={create}>
            <input
              className="field-in"
              aria-label={t('settings.tokenName')}
              placeholder={t('settings.tokenNamePlaceholder')}
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="btn primary" type="submit" disabled={busy || !name.trim()}>
              {t('settings.createToken')}
            </button>
          </form>
          {secret && (
            <div className="secret" role="status">
              <p>{t('settings.tokenCreated')}</p>
              <CopyField value={secret} />
            </div>
          )}
          {tokens && tokens.length === 0 && <p className="lead">{t('settings.tokensEmpty')}</p>}
          <ul className="rows">
            {tokens?.map((k) => (
              <li key={k.id}>
                <div>
                  <b>{k.name}</b>
                  <span>
                    <code>{k.prefix}…</code> · {t('settings.created', { when: ago(k.createdAt) })} · {used(k.lastUsedAt)}
                  </span>
                </div>
                <button
                  className="btn"
                  onClick={async () => {
                    await api.deleteToken(k.id).then(() => toast(t('settings.revoked')), (e) => toast(errMsg(e)));
                    load();
                  }}
                >
                  {t('settings.revoke')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}

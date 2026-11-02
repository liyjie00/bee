import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BeeLogo } from '../components/Logo';
import { useI18n, type MessageKey } from '../i18n';
import { copyText } from '../state/toast';

const LOGIN = '/login';
const REGISTER = '/login?mode=register';
const CONTACT = 'contactus@bee.zippyzoo.dev';
const SOURCE = 'https://github.com/liyjie00/bee';

/** Stroke icons for the feature cards (24×24). */
const FEATURES: { title: MessageKey; body: MessageKey; d: string; isNew?: boolean }[] = [
  { title: 'land.f1', body: 'land.f1d', d: 'M4 6h16v12H4zM7 15V9l2.5 3L12 9v6M15 12l2 3 2-3M17 9v6' },
  { title: 'land.f2', body: 'land.f2d', d: 'M12 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0M3 19c0-3 3-5 6-5s6 2 6 5M19.5 9a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0M15 14.5c3 0 5.5 1.5 5.5 4' },
  { title: 'land.f3', body: 'land.f3d', d: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2' },
  { title: 'land.f4', body: 'land.f4d', d: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5' },
  { title: 'land.f5', body: 'land.f5d', d: 'M3 7h7l2 2h9v10H3z' },
  { title: 'land.f6', body: 'land.f6d', d: 'M4 18c3-6 5-9 8-9s3 5 8-3M4 4h4v4H4zM16 16h4v4h-4z' },
  { title: 'land.f7', body: 'land.f7d', d: 'M3 4h18v16H3zM3 10h18M3 15h18M9 4v16M15 4v16', isNew: true },
  { title: 'land.f8', body: 'land.f8d', d: 'M5 5h9M5 5l6 7-6 7h9M15 13l5 6M20 13l-5 6', isNew: true },
];

const MCP_CAN: MessageKey[] = ['land.mcpCan1', 'land.mcpCan2', 'land.mcpCan3', 'land.mcpCan4'];

function Check() {
  return (
    <svg className="i land-check" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

/** What signed-out visitors see at the site root: what Bee is, and the way in. */
export function LandingPage() {
  const { t, lang, setLang } = useI18n();
  const switchLang = () => setLang(lang === 'en' ? 'zh-CN' : 'en');
  return (
    <div className="landing">
      <header className="land-top">
        <div className="land-wrap land-bar">
          <a href="#top" className="land-logo" aria-label="Bee">
            <BeeLogo height={28} />
          </a>
          <nav className="land-nav hide-phone" aria-label={t('land.nav')}>
            <a href="#features">{t('land.navFeatures')}</a>
            <a href="#share">{t('land.navShare')}</a>
            <a href="#mcp">{t('land.navAi')}</a>
          </nav>
          <div className="spacer" />
          <button className="land-lang hide-phone" onClick={switchLang} aria-label={t('lang.label')}>
            {t('lang.switch')}
          </button>
          <Link className="land-signin" to={LOGIN}>
            {t('land.signIn')}
          </Link>
          <Link className="land-btn dark" to={REGISTER}>
            {t('land.signUp')}
          </Link>
        </div>
      </header>

      <section id="top" className="land-wrap land-hero">
        <div className="land-hero-text">
          <a className="land-news" href="#mcp">
            <span>{t('land.newPill')}</span>
            {t('land.newPillText')}
            <span aria-hidden="true">→</span>
          </a>
          <h1>
            {t('land.title1')}
            <br />
            {t('land.title2')}
          </h1>
          <p className="land-lead">{t('land.sub')}</p>
          <div className="land-ctas">
            <Link className="land-btn honey big" to={REGISTER}>
              {t('land.start')}
            </Link>
            <Link className="land-btn ghost big" to={LOGIN}>
              {t('land.haveAccount')}
            </Link>
          </div>
          <p className="land-fine">{t('land.fine')}</p>
        </div>

        <div className="land-demo" aria-hidden="true">
          <div className="land-demo-top">
            <span className="hide-phone">{t('land.demoFolder')}</span>
            <span className="hide-phone">/</span>
            <b>{t('land.demoTitle')}</b>
            <span className="spacer" />
            <span className="land-saved">
              <i />
              {t('land.demoSaved')}
            </span>
            <span className="land-avs">
              <span className="av" style={{ background: 'var(--p1)' }}>{[...t('land.demoLin')][0]}</span>
              <span className="av" style={{ background: 'var(--p2)' }}>{[...t('land.demoChen')][0]}</span>
              <span className="av" style={{ background: 'var(--p3)' }}>J</span>
            </span>
            <span className="land-demo-share">{t('land.demoShare')}</span>
          </div>
          <div className="land-demo-body">
            <div className="land-demo-doc">
              <div className="land-demo-title">{t('land.demoTitle')}</div>
              <p>
                {t('land.demoBody1')}
                <mark>{t('land.demoHi')}</mark>
                {t('land.demoBody2')}
              </p>
              <div className="land-demo-h">{t('land.demoMilestones')}</div>
              <div className="land-task">
                <span className="box on" />
                {t('land.demoM1')}
                <span className="mono">11/08</span>
              </div>
              <div className="land-task">
                <span className="box" />
                {t('land.demoM2')}
                <span className="land-caret">
                  <span>{t('land.demoLin')}</span>
                </span>
              </div>
              <div className="land-ln" style={{ width: '92%' }} />
              <div className="land-ln" style={{ width: '76%' }} />
            </div>
            <div className="land-demo-side hide-phone">
              <div className="land-demo-cap">{t('land.demoComments')}</div>
              <div className="land-cmt hot">
                <b>{t('land.demoChen')}</b>
                <span>
                  <em>@{t('land.demoLin')}</em>
                  {t('land.demoC1')}
                </span>
              </div>
              <div className="land-cmt">{t('land.demoC2')}</div>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="land-wrap land-sec">
        <div className="land-sec-head">
          <h2>{t('land.featTitle')}</h2>
          <p>{t('land.featSub')}</p>
        </div>
        <div className="land-feats">
          {FEATURES.map((f) => (
            <div key={f.title} className="land-feat">
              {f.isNew && <span className="land-new">{t('land.badgeNew')}</span>}
              <span className="land-ic">
                <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
                  <path d={f.d} />
                </svg>
              </span>
              <h3>{t(f.title)}</h3>
              <p>{t(f.body)}</p>
            </div>
          ))}
        </div>
      </section>

      <McpSection />

      <section id="share" className="land-sec">
        <div className="land-wrap land-split">
          <div className="land-split-text">
            <h2>{t('land.shareTitle')}</h2>
            <p>{t('land.shareSub')}</p>
            <ul className="land-checks">
              <li>
                <Check />
                {t('land.share1')}
              </li>
              <li>
                <Check />
                {t('land.share2')}
              </li>
              <li>
                <Check />
                {t('land.share3')}
              </li>
            </ul>
          </div>
          <div className="land-share" aria-hidden="true">
            <b>{t('land.shareDialog')}</b>
            <div className="land-invite">
              <span>{t('land.shareInvite')}</span>
              <span className="land-demo-share">{t('land.shareInviteBtn')}</span>
            </div>
            <div className="land-person">
              <span className="av" style={{ background: 'var(--p1)' }}>{[...t('land.demoLin')][0]}</span>
              <span className="spacer">{t('land.demoLin')}</span>
              <span className="muted">{t('role.editor')}</span>
            </div>
            <div className="land-person">
              <span className="av" style={{ background: 'var(--p2)' }}>{[...t('land.demoChen')][0]}</span>
              <span className="spacer">{t('land.demoChen')}</span>
              <span className="muted">{t('role.commenter')}</span>
            </div>
            <div className="land-linkrow">
              <svg className="i" viewBox="0 0 24 24">
                <use href="#i-globe" />
              </svg>
              <span className="spacer">{t('land.shareLink')}</span>
              <span className="land-toggle" />
            </div>
            <span className="land-url mono">bee.zippyzoo.dev/s/k7Qm2xPa</span>
          </div>
        </div>
      </section>

      <section id="ai" className="land-wrap land-split land-sec">
        <div className="land-split-text">
          <h2>{t('land.aiTitle')}</h2>
          <p>{t('land.aiSub')}</p>
          <p className="land-fine">{t('land.aiFine')}</p>
        </div>
        <div className="land-chat" aria-hidden="true">
          <div className="land-ask">{t('land.aiAsk')}</div>
          <div className="land-answer">
            <span className="land-ai">AI</span>
            <div>
              {t('land.aiAnswer')}
              <br />
              <span className="land-diff">{t('land.aiDiff')}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="land-wrap land-sec">
        <div className="land-cta">
          <h2>{t('land.ctaTitle')}</h2>
          <p>{t('land.ctaSub')}</p>
          <div className="land-ctas">
            <Link className="land-btn dark big" to={REGISTER}>
              {t('land.signUp')}
            </Link>
            <Link className="land-signin big" to={LOGIN}>
              {t('land.signIn')}
            </Link>
          </div>
        </div>
      </section>

      <footer className="land-foot">
        <div className="land-wrap land-bar">
          <BeeLogo height={20} />
          <span>{t('land.footer')}</span>
          <div className="spacer" />
          <a href={SOURCE} target="_blank" rel="noreferrer">
            {t('land.source')}
          </a>
          <a href={`mailto:${CONTACT}`}>
            {t('land.contact')} {CONTACT}
          </a>
          <Link to={LOGIN}>{t('land.signIn')}</Link>
          <Link to={REGISTER}>{t('land.signUp')}</Link>
          <button className="land-lang" onClick={switchLang} aria-label={t('lang.label')}>
            {t('lang.switch')}
          </button>
        </div>
      </footer>
    </div>
  );
}

/** MCP: what an agent can do in Bee, how to connect one, and a picture of it editing a doc. */
function McpSection() {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/mcp`;
  const copy = async () => {
    if (await copyText(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <section id="mcp" className="land-band">
      <div className="land-wrap land-split">
        <div className="land-split-text">
          <span className="land-eyebrow">{t('land.mcpTag')}</span>
          <h2>{t('land.mcpTitle')}</h2>
          <p>{t('land.mcpSub')}</p>
          <ol className="land-steps">
            <li>
              <span>{t('land.mcpStep1')}</span>
              <span className="land-copy">
                <code className="mono">{url}</code>
                <button onClick={copy}>{copied ? t('land.mcpCopied') : t('land.mcpCopy')}</button>
              </span>
            </li>
            <li>{t('land.mcpStep2')}</li>
            <li>{t('land.mcpStep3')}</li>
          </ol>
          <ul className="land-chips">
            {MCP_CAN.map((k) => (
              <li key={k}>{t(k)}</li>
            ))}
          </ul>
          <p className="land-fine">{t('land.mcpFine')}</p>
        </div>
        <div className="land-agent" aria-hidden="true">
          <div className="land-chat">
            <div className="land-ask">{t('land.mcpAsk')}</div>
            <span className="land-call mono">Bee · {t('land.mcpCall1')}</span>
            <span className="land-call mono">Bee · {t('land.mcpCall2')}</span>
            <span className="land-call mono hot">Bee · {t('land.mcpCall3')}</span>
            <div className="land-answer">
              <span className="land-ai">AI</span>
              <div>{t('land.mcpAnswer')}</div>
            </div>
          </div>
          <div className="land-agent-doc">
            <div className="land-saved">
              <i />
              {t('land.mcpDocMeta')}
            </div>
            <b>{t('land.demoMilestones').replace(/^#+\s*/, '')}</b>
            <div className="land-task">
              <span className="box on" />
              {t('land.demoM1')}
              <span className="mono">11/08</span>
            </div>
            <div className="land-add">{t('land.mcpAdd1')}</div>
            <div className="land-add">{t('land.mcpAdd2')}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

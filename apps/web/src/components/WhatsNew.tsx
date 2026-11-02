import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { useI18n } from '../i18n';
import { FEATURES, useWhatsNew } from '../lib/whatsNew';

/** Top-bar "What's new" button with an unseen dot, and the changelog popover it opens. */
export function WhatsNewButton() {
  const { t, lang } = useI18n();
  const wn = useWhatsNew();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!wn.open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) wn.setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && wn.setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [wn.open]);

  const day = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString(lang, { month: 'long', day: 'numeric' });

  return (
    <div className="wn-anchor" ref={ref}>
      <button
        className={'ico wn-btn' + (wn.open ? ' on' : '')}
        aria-label={t('wn.title')}
        aria-expanded={wn.open}
        title={t('wn.title')}
        onClick={() => wn.setOpen(!wn.open)}
      >
        <Icon name="megaphone" />
        <span className="hide-phone">{t('wn.title')}</span>
        {wn.unseen && <span className="wn-dot" />}
      </button>
      {wn.open && (
        <div className="wn-pop" role="dialog" aria-label={t('wn.title')}>
          <div className="wn-pop-h">
            <b>{t('wn.title')}</b>
            <button className="ico" aria-label={t('common.close')} onClick={() => wn.setOpen(false)}>
              <Icon name="x" />
            </button>
          </div>
          <div className="wn-pop-list">
            {FEATURES.map((f) => (
              <div key={f.id} className="wn-entry">
                <span className="wn-date">{day(f.date)}</span>
                <h4>{t(f.title)}</h4>
                <p>{t(f.body)}</p>
                {f.cta && (
                  <Link to={f.cta.to} onClick={() => wn.setOpen(false)}>
                    {t(f.cta.label)} →
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

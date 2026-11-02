import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useShell } from './Shell';
import { Icon } from './Icon';
import { useTheme } from '../lib/theme';
import { useI18n } from '../i18n';
import { useMenu, type MenuEntry } from './Menu';
import { BugReportDialog } from './BugReportDialog';
import { useSession } from '../state/session';

export interface Crumb {
  label: string;
  to?: string;
}

/** phoneMenu: page actions that move into the ⋯ menu on phones (their own buttons carry .hide-phone). */
export function TopBar({ crumbs, children, phoneMenu = [] }: { crumbs: Crumb[]; children?: ReactNode; phoneMenu?: MenuEntry[] }) {
  const { openSidebar } = useShell();
  const [theme, toggleTheme] = useTheme();
  const { t, lang, setLang } = useI18n();
  const menu = useMenu();
  const [bugOpen, setBugOpen] = useState(false);
  const { session } = useSession();
  const switchLang = () => setLang(lang === 'en' ? 'zh-CN' : 'en');
  return (
    <header className="top">
      {openSidebar && (
        <button className="ico menu-btn" aria-label={t('nav.openSidebar')} onClick={openSidebar}>
          <Icon name="menu" />
        </button>
      )}
      <nav className="crumb" aria-label={t('nav.location')}>
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i === 0 && <Icon name="folder" />}
            {i > 0 && <Icon name="chev" size={12} />}
            {i === crumbs.length - 1 ? (
              <b>{c.label}</b>
            ) : c.to ? (
              <Link to={c.to} style={{ textDecoration: 'none' }}>
                {c.label}
              </Link>
            ) : (
              <span>{c.label}</span>
            )}
          </Fragment>
        ))}
      </nav>
      <div className="spacer" />
      {children}
      <button
        className="ico mono hide-phone"
        style={{ fontSize: '0.75rem', fontFamily: 'var(--f-body)' }}
        aria-label={t('lang.label')}
        title={t('lang.label')}
        onClick={switchLang}
      >
        {t('lang.switch')}
      </button>
      <button className="ico hide-phone" aria-label={t('theme.toggle')} title={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')} onClick={toggleTheme}>
        {theme === 'dark' ? (
          <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
        ) : (
          <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
        )}
      </button>
      <button
        className="ico phone-only"
        aria-label={t('common.more')}
        onClick={(e) =>
          menu.open(e, [
            ...phoneMenu,
            ...(phoneMenu.length ? (['-'] as const) : []),
            { label: t('lang.label') + ' · ' + t('lang.switch'), icon: 'globe', onSelect: switchLang },
            { label: theme === 'dark' ? t('theme.toLight') : t('theme.toDark'), icon: theme === 'dark' ? 'sun' : 'moon', onSelect: toggleTheme },
            ...(session ? [{ label: t('bug.nav'), icon: 'bug' as const, onSelect: () => setBugOpen(true) }] : []),
          ])
        }
      >
        <Icon name="more" />
      </button>
      {menu.node}
      {bugOpen && <BugReportDialog onClose={() => setBugOpen(false)} />}
    </header>
  );
}

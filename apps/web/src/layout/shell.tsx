import { NavLink, Outlet, useNavigate } from 'react-router';
import { hasRole, useMe, useSession } from '../auth/session.tsx';
import { useI18n } from '../i18n/i18n.tsx';
import { LOCALES, type Locale } from '../i18n/strings.ts';

export function Shell() {
  const me = useMe();
  const { logout } = useSession();
  const { t, locale, setLocale } = useI18n();
  const navigate = useNavigate();
  const canPower = hasRole(me, ['school_admin', 'it_support']);
  return (
    <div className="shell">
      <header className="topbar">
        <strong>{t('app.title')}</strong>
        <nav>
          <NavLink to="/rooms">{t('nav.rooms')}</NavLink>
          {canPower && <NavLink to="/power">{t('nav.power')}</NavLink>}
        </nav>
        <span className="spacer" />
        <label className="locale">
          {t('locale.label')}
          <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <span className="who">{me.user.displayName}</span>
        <button
          type="button"
          className="link"
          onClick={async () => {
            await logout();
            navigate('/login', { replace: true });
          }}
        >
          {t('nav.logout')}
        </button>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

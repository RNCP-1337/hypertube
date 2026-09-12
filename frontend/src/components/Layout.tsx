import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { LANGUAGES, setLanguage } from '../i18n';
import { api } from '../api/client';
import { Avatar } from './ui';

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2 text-lg font-bold tracking-tight text-white">
      <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="#161b22" />
        <path d="M12 9.5v13l10-6.5-10-6.5z" fill="#e63946" />
      </svg>
      Hypertube
    </Link>
  );
}

function LanguagePicker() {
  const { i18n, t } = useTranslation();
  const { user, setUser } = useAuth();

  const onChange = async (code: string) => {
    setLanguage(code);
    if (!user || user.language === code) return;
    try {
      const data = await api.patch<{ user: typeof user }>(`/users/${user.id}`, { language: code });
      setUser(data.user);
    } catch {
      // the UI language still changed locally
    }
  };

  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">{t('nav.language')}</span>
      <select
        value={i18n.resolvedLanguage ?? 'en'}
        onChange={(event) => void onChange(event.target.value)}
        className="rounded-lg border border-ink-600 bg-ink-800 px-2 py-1.5 text-xs text-slate-200
                   focus:border-accent focus:outline-none"
      >
        {LANGUAGES.map((language) => (
          <option key={language.code} value={language.code}>
            {language.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  const signOut = async () => {
    setOpen(false);
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-full border border-ink-600 bg-ink-800 py-1 pl-1 pr-3
                   text-sm text-slate-200 transition-colors hover:border-ink-600/70 hover:bg-ink-700"
      >
        <Avatar src={user.profilePictureUrl} name={user.username} size={28} />
        <span className="hidden max-w-[10rem] truncate sm:inline">{user.username}</span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 w-48 overflow-hidden rounded-xl border border-ink-700
                     bg-ink-850 py-1 shadow-xl shadow-black/40 animate-fade-in"
        >
          <Link
            role="menuitem"
            to={`/users/${user.id}`}
            onClick={() => setOpen(false)}
            className="block px-4 py-2 text-sm text-slate-200 hover:bg-ink-800"
          >
            {t('profile.myProfile')}
          </Link>
          <Link
            role="menuitem"
            to="/settings"
            onClick={() => setOpen(false)}
            className="block px-4 py-2 text-sm text-slate-200 hover:bg-ink-800"
          >
            {t('nav.settings')}
          </Link>
          <button
            role="menuitem"
            type="button"
            onClick={() => void signOut()}
            className="block w-full px-4 py-2 text-left text-sm text-accent hover:bg-ink-800"
          >
            {t('nav.logout')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Header() {
  const { user } = useAuth();
  const { t } = useTranslation();

  return (
    <header className="sticky top-0 z-20 border-b border-ink-700 bg-ink-900/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Logo />

        {user ? (
          <nav className="ml-2 hidden sm:block">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                `rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? 'bg-ink-800 text-white' : 'text-slate-300 hover:text-white'
                }`
              }
            >
              {t('nav.library')}
            </NavLink>
          </nav>
        ) : null}

        <div className="ml-auto flex items-center gap-3">
          <LanguagePicker />
          {user ? (
            <UserMenu />
          ) : (
            <Link to="/login" className="btn-primary py-2 text-sm">
              {t('nav.login')}
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

function Footer() {
  const { t } = useTranslation();
  return (
    <footer className="mt-16 border-t border-ink-700 bg-ink-950">
      <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-8 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>{t('app.legal')}</p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <a
            href="https://archive.org"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-slate-300"
          >
            archive.org
          </a>
          <a
            href="http://www.publicdomaintorrents.info"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-slate-300"
          >
            publicdomaintorrents.info
          </a>
          <span>{t('app.footerRights')}</span>
        </p>
      </div>
    </footer>
  );
}

export default function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

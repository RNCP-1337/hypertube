import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Alert, Field, Spinner } from '../components/ui';

interface Provider {
  id: string;
  label: string;
}

const PROVIDER_STYLES: Record<string, string> = {
  '42': 'bg-white text-black hover:bg-slate-200',
  google: 'bg-[#4285f4] text-white hover:bg-[#5a95f5]',
  github: 'bg-[#24292f] text-white hover:bg-[#32383f]',
  discord: 'bg-[#5865f2] text-white hover:bg-[#6b77f4]',
};

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-md py-6 animate-slide-up">
      <h1 className="text-2xl font-bold text-white">{title}</h1>
      <p className="mt-1 text-sm text-muted">{subtitle}</p>
      <div className="card mt-6 p-6">{children}</div>
    </div>
  );
}

export function OAuthButtons() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<Provider[]>([]);

  useEffect(() => {
    api
      .get<{ providers: Provider[] }>('/auth/providers')
      .then((data) => setProviders(data.providers))
      .catch(() => setProviders([]));
  }, []);

  if (providers.length === 0) return null;

  return (
    <>
      <div className="my-6 flex items-center gap-3">
        <span className="h-px flex-1 bg-ink-700" />
        <span className="text-xs uppercase tracking-wide text-muted">{t('auth.continueWith')}</span>
        <span className="h-px flex-1 bg-ink-700" />
      </div>

      <div className="grid gap-2">
        {providers.map((provider) => (
          <a
            key={provider.id}
            href={`/api/auth/oauth/${provider.id}`}
            className={`btn justify-center ${PROVIDER_STYLES[provider.id] ?? 'btn-secondary'}`}
          >
            {provider.label}
          </a>
        ))}
      </div>
    </>
  );
}

export default function Login() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const oauthError = searchParams.get('error');
    if (!oauthError) return;
    const key = `errors.oauth.${oauthError}`;
    const translated = t(key);
    setError(translated === key ? t('errors.generic') : translated);
  }, [searchParams, t]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t('errors.unauthorized') : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title={t('auth.loginTitle')} subtitle={t('auth.loginSubtitle')}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error ? <Alert kind="error">{error}</Alert> : null}

        <Field
          label={t('auth.usernameOrEmail')}
          name="username"
          autoComplete="username"
          required
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />

        <Field
          label={t('auth.password')}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <button type="submit" disabled={busy} className="btn-primary w-full py-3">
          {busy ? <Spinner className="h-4 w-4" /> : null}
          {t('auth.submitLogin')}
        </button>

        <div className="flex items-center justify-between text-sm">
          <Link to="/forgot-password" className="text-muted hover:text-slate-200">
            {t('auth.forgotPassword')}
          </Link>
          <span className="text-muted">
            {t('auth.noAccount')}{' '}
            <Link to="/register" className="font-medium text-accent hover:text-accent-hover">
              {t('nav.register')}
            </Link>
          </span>
        </div>
      </form>

      <OAuthButtons />
    </AuthShell>
  );
}

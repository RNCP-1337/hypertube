import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { Alert, Field, Spinner } from '../components/ui';
import { AuthShell } from './Login';

export function ForgotPassword() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError(t('errors.invalidEmail'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch {
      setError(t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title={t('auth.forgotTitle')} subtitle={t('auth.forgotSubtitle')}>
      {sent ? (
        <div className="space-y-4">
          <Alert kind="success">{t('auth.resetSent')}</Alert>
          <Link to="/login" className="btn-secondary w-full">
            {t('auth.backToLogin')}
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert kind="error">{error}</Alert> : null}

          <Field
            label={t('auth.email')}
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />

          <button type="submit" disabled={busy} className="btn-primary w-full py-3">
            {busy ? <Spinner className="h-4 w-4" /> : null}
            {t('auth.sendResetLink')}
          </button>

          <p className="text-center text-sm">
            <Link to="/login" className="text-muted hover:text-slate-200">
              {t('auth.backToLogin')}
            </Link>
          </p>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPassword() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
    if (password.length < 8 || classes < 3) {
      setError(t('auth.passwordHint'));
      return;
    }
    if (password !== confirm) {
      setError(t('errors.passwordMismatch'));
      return;
    }

    setBusy(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
      window.setTimeout(() => navigate('/login', { replace: true }), 2500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  if (token === '') {
    return (
      <AuthShell title={t('auth.resetTitle')} subtitle={t('auth.resetSubtitle')}>
        <div className="space-y-4">
          <Alert kind="error">{t('errors.generic')}</Alert>
          <Link to="/forgot-password" className="btn-secondary w-full">
            {t('auth.forgotPassword')}
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t('auth.resetTitle')} subtitle={t('auth.resetSubtitle')}>
      {done ? (
        <Alert kind="success">{t('auth.resetDone')}</Alert>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert kind="error">{error}</Alert> : null}

          <Field
            label={t('auth.newPassword')}
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            hint={t('auth.passwordHint')}
          />

          <Field
            label={t('auth.confirmPassword')}
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />

          <button type="submit" disabled={busy} className="btn-primary w-full py-3">
            {busy ? <Spinner className="h-4 w-4" /> : null}
            {t('auth.resetSubmit')}
          </button>
        </form>
      )}
    </AuthShell>
  );
}

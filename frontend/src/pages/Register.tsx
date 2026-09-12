import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Alert, Field, Spinner } from '../components/ui';
import { AuthShell, OAuthButtons } from './Login';

interface FormState {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  confirmPassword: string;
}

const EMPTY: FormState = {
  username: '',
  email: '',
  firstName: '',
  lastName: '',
  password: '',
  confirmPassword: '',
};

export default function Register() {
  const { t, i18n } = useTranslation();
  const { register } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof FormState) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const validate = (): boolean => {
    const next: Partial<Record<keyof FormState, string>> = {};

    if (!/^[A-Za-z0-9_.-]{3,20}$/.test(form.username)) {
      next.username = t('errors.required');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      next.email = t('errors.invalidEmail');
    }
    if (form.firstName.trim() === '') next.firstName = t('errors.required');
    if (form.lastName.trim() === '') next.lastName = t('errors.required');

    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) =>
      re.test(form.password),
    ).length;
    if (form.password.length < 8 || classes < 3) {
      next.password = t('auth.passwordHint');
    }
    if (form.password !== form.confirmPassword) {
      next.confirmPassword = t('errors.passwordMismatch');
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setGlobalError(null);
    if (!validate()) return;

    setBusy(true);
    try {
      await register({
        username: form.username,
        email: form.email,
        firstName: form.firstName,
        lastName: form.lastName,
        password: form.password,
        language: i18n.resolvedLanguage ?? 'en',
      });
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.details) {
        const mapped: Partial<Record<keyof FormState, string>> = {};
        for (const detail of err.details) {
          mapped[detail.field as keyof FormState] = detail.message;
        }
        setErrors(mapped);
        if (Object.keys(mapped).length === 0) setGlobalError(err.message);
      } else {
        setGlobalError(err instanceof ApiError ? err.message : t('errors.generic'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title={t('auth.registerTitle')} subtitle={t('auth.registerSubtitle')}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {globalError ? <Alert kind="error">{globalError}</Alert> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('auth.firstName')}
            name="firstName"
            autoComplete="given-name"
            required
            value={form.firstName}
            onChange={set('firstName')}
            error={errors.firstName}
          />
          <Field
            label={t('auth.lastName')}
            name="lastName"
            autoComplete="family-name"
            required
            value={form.lastName}
            onChange={set('lastName')}
            error={errors.lastName}
          />
        </div>

        <Field
          label={t('auth.username')}
          name="username"
          autoComplete="username"
          required
          minLength={3}
          maxLength={20}
          value={form.username}
          onChange={set('username')}
          error={errors.username}
        />

        <Field
          label={t('auth.email')}
          name="email"
          type="email"
          autoComplete="email"
          required
          value={form.email}
          onChange={set('email')}
          error={errors.email}
        />

        <Field
          label={t('auth.password')}
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={form.password}
          onChange={set('password')}
          error={errors.password}
          hint={t('auth.passwordHint')}
        />

        <Field
          label={t('auth.confirmPassword')}
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          value={form.confirmPassword}
          onChange={set('confirmPassword')}
          error={errors.confirmPassword}
        />

        <button type="submit" disabled={busy} className="btn-primary w-full py-3">
          {busy ? <Spinner className="h-4 w-4" /> : null}
          {t('auth.submitRegister')}
        </button>

        <p className="text-center text-sm text-muted">
          {t('auth.hasAccount')}{' '}
          <Link to="/login" className="font-medium text-accent hover:text-accent-hover">
            {t('nav.login')}
          </Link>
        </p>
      </form>

      <OAuthButtons />
    </AuthShell>
  );
}

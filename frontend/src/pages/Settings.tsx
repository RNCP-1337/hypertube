import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type User } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { LANGUAGES, setLanguage } from '../i18n';
import { Alert, Avatar, Field, SelectField, Spinner } from '../components/ui';

export default function Settings() {
  const { t } = useTranslation();
  const { user, setUser } = useAuth();

  const fileInput = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({
    username: '',
    email: '',
    firstName: '',
    lastName: '',
    language: 'en',
  });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);

  useEffect(() => {
    if (!user) return;
    setForm({
      username: user.username,
      email: user.email ?? '',
      firstName: user.firstName,
      lastName: user.lastName,
      language: user.language,
    });
  }, [user]);

  useEffect(() => {
    api
      .get<{ providers: string[] }>('/auth/me')
      .then((data) => setProviders(data.providers))
      .catch(() => setProviders([]));
  }, []);

  if (!user) return null;

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
    setErrors((current) => ({ ...current, [key]: '' }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    setGlobalError(null);
    setErrors({});

    if (password !== '' && password !== confirm) {
      setErrors({ password: t('errors.passwordMismatch') });
      return;
    }

    const payload: Record<string, string> = {};
    if (form.username !== user.username) payload.username = form.username;
    if (form.email !== (user.email ?? '')) payload.email = form.email;
    if (form.firstName !== user.firstName) payload.firstName = form.firstName;
    if (form.lastName !== user.lastName) payload.lastName = form.lastName;
    if (form.language !== user.language) payload.language = form.language;
    if (password !== '') payload.password = password;

    if (Object.keys(payload).length === 0) return;

    setBusy(true);
    try {
      const data = await api.patch<{ user: User }>(`/users/${user.id}`, payload);
      setUser(data.user);
      if (payload.language) setLanguage(payload.language);
      setPassword('');
      setConfirm('');
      setMessage(t('profile.saved'));
    } catch (err) {
      if (err instanceof ApiError && err.details) {
        const mapped: Record<string, string> = {};
        for (const detail of err.details) mapped[detail.field] = detail.message;
        setErrors(mapped);
        if (Object.keys(mapped).length === 0) setGlobalError(err.message);
      } else {
        setGlobalError(err instanceof ApiError ? err.message : t('errors.generic'));
      }
    } finally {
      setBusy(false);
    }
  };

  const uploadAvatar = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setGlobalError(null);
    setMessage(null);

    if (file.size > 5 * 1024 * 1024) {
      setGlobalError(t('profile.uploadHint'));
      event.target.value = '';
      return;
    }

    const body = new FormData();
    body.append('file', file);

    setBusy(true);
    try {
      const data = await api.upload<{ profilePictureUrl: string }>(`/users/${user.id}/avatar`, body);
      setUser({ ...user, profilePictureUrl: data.profilePictureUrl });
      setMessage(t('profile.saved'));
    } catch (err) {
      setGlobalError(err instanceof ApiError ? err.message : t('errors.generic'));
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold text-white">{t('profile.edit')}</h1>

      {message ? <Alert kind="success">{message}</Alert> : null}
      {globalError ? <Alert kind="error">{globalError}</Alert> : null}

      <section className="card p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          {t('profile.picture')}
        </h2>
        <div className="mt-4 flex items-center gap-4">
          <Avatar src={user.profilePictureUrl} name={user.username} size={72} />
          <div>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="btn-secondary"
            >
              {t('profile.changePicture')}
            </button>
            <p className="mt-1.5 text-xs text-muted">{t('profile.uploadHint')}</p>
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp,image/bmp"
              onChange={(event) => void uploadAvatar(event)}
              className="hidden"
            />
          </div>
        </div>
      </section>

      <form onSubmit={submit} className="card space-y-5 p-6" noValidate>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          {t('profile.information')}
        </h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('auth.firstName')}
            name="firstName"
            value={form.firstName}
            onChange={set('firstName')}
            error={errors.firstName}
          />
          <Field
            label={t('auth.lastName')}
            name="lastName"
            value={form.lastName}
            onChange={set('lastName')}
            error={errors.lastName}
          />
        </div>

        <Field
          label={t('auth.username')}
          name="username"
          value={form.username}
          onChange={set('username')}
          error={errors.username}
        />

        <Field
          label={t('auth.email')}
          name="email"
          type="email"
          value={form.email}
          onChange={set('email')}
          error={errors.email}
        />

        <SelectField
          label={t('profile.preferredLanguage')}
          name="language"
          value={form.language}
          onChange={set('language')}
        >
          {LANGUAGES.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </SelectField>

        <div className="border-t border-ink-700 pt-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            {t('profile.security')}
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              label={t('auth.newPassword')}
              name="newPassword"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={errors.password}
              hint={t('auth.passwordHint')}
            />
            <Field
              label={t('auth.confirmPassword')}
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </div>
        </div>

        <button type="submit" disabled={busy} className="btn-primary">
          {busy ? <Spinner className="h-4 w-4" /> : null}
          {t('profile.save')}
        </button>
      </form>

      <section className="card p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          {t('profile.linkedAccounts')}
        </h2>
        {providers.length === 0 ? (
          <p className="mt-3 text-sm text-muted">{t('profile.noLinkedAccounts')}</p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {providers.map((provider) => (
              <li key={provider} className="chip capitalize">
                {provider}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

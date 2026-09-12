import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, type User } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Alert, Avatar, Loading } from '../components/ui';

export default function Profile() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const { user: current } = useAuth();

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    api
      .get<{ user: User }>(`/users/${id}`)
      .then((data) => {
        if (!cancelled) setUser(data.user);
      })
      .catch(() => {
        if (!cancelled) setError(t('profile.notFound'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, t]);

  if (loading) return <Loading label={t('common.loading')} />;

  if (error || !user) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <Alert kind="error">{error ?? t('profile.notFound')}</Alert>
        <Link to="/" className="btn-secondary">
          {t('errors.backHome')}
        </Link>
      </div>
    );
  }

  const isSelf = current?.id === user.id;
  const joined = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', {
    dateStyle: 'long',
  }).format(new Date(user.createdAt));

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="card p-6">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <Avatar src={user.profilePictureUrl} name={user.username} size={96} />

          <div className="min-w-0 flex-1 text-center sm:text-left">
            <h1 className="text-2xl font-bold text-white">{user.username}</h1>
            <p className="mt-1 text-sm text-slate-300">
              {user.firstName} {user.lastName}
            </p>
            <p className="mt-2 text-xs text-muted">{t('profile.memberSince', { date: joined })}</p>

            {isSelf ? (
              <div className="mt-4">
                <Link to="/settings" className="btn-secondary">
                  {t('profile.edit')}
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          {t('profile.information')}
        </h2>
        <dl className="mt-4 space-y-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">{t('auth.username')}</dt>
            <dd className="text-slate-200">{user.username}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">{t('auth.firstName')}</dt>
            <dd className="text-slate-200">{user.firstName}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">{t('auth.lastName')}</dt>
            <dd className="text-slate-200">{user.lastName}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">{t('auth.email')}</dt>
            <dd className="truncate text-slate-200">
              {user.email ?? <span className="text-muted">{t('profile.emailPrivate')}</span>}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

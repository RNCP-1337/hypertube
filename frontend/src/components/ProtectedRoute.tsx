import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { Loading } from './ui';

export default function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const { t } = useTranslation();

  if (loading) return <Loading label={t('common.loading')} />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

export function GuestRoute() {
  const { user, loading } = useAuth();
  const { t } = useTranslation();

  if (loading) return <Loading label={t('common.loading')} />;
  if (user) return <Navigate to="/" replace />;
  return <Outlet />;
}

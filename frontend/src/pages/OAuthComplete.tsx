import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { Loading } from '../components/ui';

// oauth callback sets the refresh cookie, then we silently refresh into a session
export default function OAuthComplete() {
  const { t } = useTranslation();
  const { refresh, user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (loading) return;
    navigate(user ? '/' : '/login?error=provider_error', { replace: true });
  }, [user, loading, navigate]);

  return <Loading label={t('auth.completing')} />;
}

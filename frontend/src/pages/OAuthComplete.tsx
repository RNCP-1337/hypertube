import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { Loading } from '../components/ui';

// The OmniAuth callback sets the refresh cookie and lands here; one silent
// refresh turns that into a session.
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

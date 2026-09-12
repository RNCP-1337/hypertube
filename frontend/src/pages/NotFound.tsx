import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export default function NotFound() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <p className="text-6xl font-bold text-ink-600">404</p>
      <h1 className="mt-4 text-xl font-semibold text-white">{t('errors.notFound')}</h1>
      <p className="mt-2 text-sm text-muted">{t('errors.notFoundHint')}</p>
      <Link to="/" className="btn-primary mt-6">
        {t('errors.backHome')}
      </Link>
    </div>
  );
}

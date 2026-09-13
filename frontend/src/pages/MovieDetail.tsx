import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, type MovieDetail as Movie } from '../api/client';
import VideoPlayer from '../components/VideoPlayer';
import Comments from '../components/Comments';
import { Alert, Loading, Rating } from '../components/ui';

function Meta({ label, value }: { label: string; value: string | number | null }) {
  if (value === null || value === '' ) return null;
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-200">{value}</dd>
    </div>
  );
}

export default function MovieDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [movie, setMovie] = useState<Movie | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPlaying(false);

    api
      .get<{ movie: Movie }>(`/movies/${id}`)
      .then((data) => {
        if (!cancelled) setMovie(data.movie);
      })
      .catch(() => {
        if (!cancelled) setError(t('movie.notFound'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, t]);

  const markWatched = useCallback(() => {
    setMovie((current) => (current ? { ...current, watched: true } : current));
  }, []);

  const deleteMovie = useCallback(async () => {
    if (!movie) return;
    if (!window.confirm(t('movie.deleteConfirm'))) return;
    setDeleting(true);
    try {
      await api.delete(`/movies/${movie.id}`);
      navigate('/', { replace: true });
    } catch {
      setError(t('errors.generic'));
      setDeleting(false);
    }
  }, [movie, navigate, t]);

  if (loading) return <Loading label={t('common.loading')} />;

  if (error || !movie) {
    return (
      <div className="space-y-4">
        <Alert kind="error">{error ?? t('movie.notFound')}</Alert>
        <Link to="/" className="btn-secondary">
          {t('errors.backHome')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {movie.backdropUrl ? (
        <div className="relative -mx-4 -mt-8 h-48 overflow-hidden sm:-mx-6 sm:h-64">
          <img src={movie.backdropUrl} alt="" className="h-full w-full object-cover opacity-40" />
          <div className="absolute inset-0 bg-gradient-to-t from-ink-900 to-transparent" />
        </div>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[220px,1fr]">
        <div className="mx-auto w-40 sm:w-48 lg:mx-0 lg:w-full">
          {movie.coverUrl ? (
            <img
              src={movie.coverUrl}
              alt=""
              className="w-full rounded-xl border border-ink-700 object-cover shadow-lg shadow-black/40"
            />
          ) : (
            <div className="flex aspect-[2/3] w-full items-center justify-center rounded-xl border border-ink-700 bg-ink-800 p-4 text-center text-sm text-muted">
              {movie.title}
            </div>
          )}
        </div>

        <div className="space-y-5">
          <div>
            <h1 className="text-2xl font-bold text-white sm:text-3xl">{movie.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
              {movie.year ? <span>{movie.year}</span> : null}
              {movie.runtime ? <span>{t('movie.minutes', { count: movie.runtime })}</span> : null}
              <Rating value={movie.rating} />
              {movie.watched ? (
                <span className="chip border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
                  {t('library.watched')}
                </span>
              ) : null}
            </div>
          </div>

          {movie.genres.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {movie.genres.map((genre) => (
                <span key={genre} className="chip capitalize">
                  {genre}
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            {!playing ? (
              <button type="button" onClick={() => setPlaying(true)} className="btn-primary px-5 py-3">
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                  <path d="M6 4l10 6-10 6V4z" />
                </svg>
                {movie.watched ? t('movie.resume') : t('movie.play')}
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => void deleteMovie()}
              disabled={deleting}
              className="btn-secondary border-red-500/40 text-red-400 hover:border-red-500/70 hover:text-red-300 disabled:opacity-50"
            >
              {t('movie.delete')}
            </button>
          </div>

          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              {t('movie.summary')}
            </h2>
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-300">
              {movie.summary ?? t('movie.noSummary')}
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Meta label={t('movie.director')} value={movie.director} />
            <Meta label={t('movie.producer')} value={movie.producer} />
            <Meta label={t('movie.source')} value={movie.source} />
          </dl>

          {movie.cast.length > 0 ? (
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
                {t('movie.cast')}
              </h2>
              <p className="mt-2 text-sm text-slate-300">{movie.cast.join(', ')}</p>
            </div>
          ) : null}
        </div>
      </div>

      {playing ? <VideoPlayer movie={movie} onWatched={markWatched} /> : null}

      <Comments movieId={movie.id} />
    </div>
  );
}

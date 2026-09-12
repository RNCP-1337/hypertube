import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { MovieCard as Movie } from '../api/client';
import { Rating } from './ui';

function Poster({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false);

  if (!url || failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-ink-800 p-4 text-center">
        <span className="line-clamp-4 text-sm font-medium text-muted">{title}</span>
      </div>
    );
  }

  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
    />
  );
}

export default function MovieCard({ movie }: { movie: Movie }) {
  const { t } = useTranslation();

  return (
    <Link
      to={`/movies/${movie.id}`}
      className="group block overflow-hidden rounded-xl border border-ink-700 bg-ink-850
                 transition-colors hover:border-ink-600 focus-visible:border-accent"
    >
      <div className="relative aspect-[2/3] overflow-hidden bg-ink-800">
        <Poster url={movie.coverUrl} title={movie.title} />

        {movie.watched ? (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-emerald-600/90
                           px-2 py-0.5 text-[11px] font-semibold text-white shadow">
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3" aria-hidden="true">
              <path d="M7.6 13.4L4.2 10l-1.2 1.2 4.6 4.6 9-9L15.4 5.6z" />
            </svg>
            {t('library.watched')}
          </span>
        ) : null}

        {movie.rating !== null ? (
          <span className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 backdrop-blur">
            <Rating value={movie.rating} />
          </span>
        ) : null}

        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 h-1 ${
            movie.watched ? 'bg-emerald-500' : 'bg-transparent'
          }`}
        />
      </div>

      <div className="p-3">
        <h3
          className={`line-clamp-2 text-sm font-semibold leading-snug ${
            movie.watched ? 'text-muted' : 'text-slate-100'
          }`}
          title={movie.title}
        >
          {movie.title}
        </h3>
        <p className="mt-1 flex items-center gap-2 text-xs text-muted">
          <span>{movie.year ?? t('movie.unknown')}</span>
          {movie.genres.length > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate capitalize">{movie.genres.slice(0, 2).join(', ')}</span>
            </>
          ) : null}
        </p>
      </div>
    </Link>
  );
}

export function MovieCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-ink-700 bg-ink-850">
      <div className="aspect-[2/3] animate-pulse bg-ink-800" />
      <div className="space-y-2 p-3">
        <div className="h-3.5 w-4/5 animate-pulse rounded bg-ink-800" />
        <div className="h-3 w-2/5 animate-pulse rounded bg-ink-800" />
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, type MovieCard as Movie, type MovieDetail } from '../api/client';
import MovieCard, { MovieCardSkeleton } from '../components/MovieCard';
import Filters, { DEFAULT_FILTERS, type LibraryFilters } from '../components/Filters';
import { Alert, Field, Spinner } from '../components/ui';

function AddMovieForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [year, setYear] = useState('');
  const [source, setSource] = useState(''); // magnet URI or .torrent URL
  const [quality, setQuality] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { title: title.trim() };
      if (year) body.year = Number(year);
      if (quality) body.quality = quality.trim();
      if (source.trim().startsWith('magnet:')) body.magnetUri = source.trim();
      else body.torrentUrl = source.trim();

      const data = await api.post<{ movie: MovieDetail }>('/movies', body);
      onCreated(data.movie.id);
    } catch {
      setError(t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="card space-y-4 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
        {t('library.addMovieTitle')}
      </h2>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('library.titleField')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={300}
        />
        <Field
          label={t('library.yearField')}
          type="number"
          value={year}
          onChange={(e) => setYear(e.target.value)}
          min={1878}
          max={2100}
        />
        <Field
          label={t('library.magnetOrTorrent')}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          required
          className="sm:col-span-2"
        />
        <Field
          label={`${t('library.qualityField')} (${t('common.optional')})`}
          value={quality}
          onChange={(e) => setQuality(e.target.value)}
          maxLength={20}
        />
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={submitting} className="btn-primary disabled:opacity-50">
          {t('common.save')}
        </button>
        <button type="button" onClick={onClose} className="btn-ghost">
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

interface BrowseResponse {
  movies: Movie[];
  page: number;
  hasMore: boolean;
}

const PER_PAGE = 20;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export default function Library() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showAddForm, setShowAddForm] = useState(false);

  const [searchInput, setSearchInput] = useState(searchParams.get('q') ?? '');
  const search = useDebounced(searchInput.trim(), 450);

  const [filters, setFilters] = useState<LibraryFilters>(() => ({
    ...DEFAULT_FILTERS,
    sort: (searchParams.get('sort') as LibraryFilters['sort']) ?? DEFAULT_FILTERS.sort,
    order: (searchParams.get('order') as LibraryFilters['order']) ?? DEFAULT_FILTERS.order,
    genre: searchParams.get('genre') ?? '',
  }));

  const sortTouched = useRef(searchParams.has('sort') || searchParams.has('order'));

  const [movies, setMovies] = useState<Movie[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sentinel = useRef<HTMLDivElement | null>(null);
  const requestId = useRef(0);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    params.set('perPage', String(PER_PAGE));

    if (sortTouched.current) {
      params.set('sort', filters.sort);
      params.set('order', filters.order);
    }
    if (filters.genre) params.set('genre', filters.genre);
    if (filters.yearMin) params.set('yearMin', filters.yearMin);
    if (filters.yearMax) params.set('yearMax', filters.yearMax);
    if (filters.ratingMin) params.set('ratingMin', filters.ratingMin);
    return params.toString();
  }, [search, filters]);

  useEffect(() => {
    api
      .get<{ genres: string[] }>('/movies/genres')
      .then((data) => setGenres(data.genres))
      .catch(() => setGenres([]));
  }, []);

  // keep the URL in sync so a search can be shared or reloaded
  useEffect(() => {
    const next = new URLSearchParams();
    if (search) next.set('q', search);
    if (filters.sort !== DEFAULT_FILTERS.sort) next.set('sort', filters.sort);
    if (filters.order !== DEFAULT_FILTERS.order) next.set('order', filters.order);
    if (filters.genre) next.set('genre', filters.genre);
    setSearchParams(next, { replace: true });
  }, [search, filters, setSearchParams]);

  const load = useCallback(
    async (targetPage: number, replace: boolean) => {
      const id = ++requestId.current;
      if (replace) setLoading(true);
      else setLoadingMore(true);
      setError(null);

      try {
        const data = await api.get<BrowseResponse>(`/movies?${queryString}&page=${targetPage}`);
        if (id !== requestId.current) return;

        setMovies((current) => {
          if (replace) return data.movies;
          const seen = new Set(current.map((movie) => movie.id));
          return [...current, ...data.movies.filter((movie) => !seen.has(movie.id))];
        });
        setHasMore(data.hasMore);
        setPage(targetPage);
      } catch {
        if (id === requestId.current) setError(t('errors.generic'));
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [queryString, t],
  );

  useEffect(() => {
    void load(1, true);
  }, [load]);

  // infinite scroll: the next page loads when the sentinel becomes visible
  useEffect(() => {
    const node = sentinel.current;
    if (!node || loading || loadingMore || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void load(page + 1, false);
      },
      { rootMargin: '600px 0px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [load, page, hasMore, loading, loadingMore]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold text-white sm:text-3xl">{t('library.title')}</h1>
          <p className="text-sm text-muted">{t('app.tagline')}</p>
        </div>
        <button type="button" onClick={() => setShowAddForm((v) => !v)} className="btn-secondary">
          {t('library.addMovie')}
        </button>
      </div>

      {showAddForm ? (
        <AddMovieForm
          onClose={() => setShowAddForm(false)}
          onCreated={(id) => navigate(`/movies/${id}`)}
        />
      ) : null}

      <div className="relative">
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
        >
          <path
            fillRule="evenodd"
            d="M9 3.5a5.5 5.5 0 1 0 3.4 9.8l3.6 3.6 1.4-1.4-3.6-3.6A5.5 5.5 0 0 0 9 3.5zm-3.5 5.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"
            clipRule="evenodd"
          />
        </svg>
        <input
          type="search"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder={t('library.searchPlaceholder')}
          aria-label={t('common.search')}
          maxLength={120}
          className="field py-3 pl-10 pr-4 text-base"
        />
      </div>

      <Filters
        filters={filters}
        genres={genres}
        onChange={(next) => {
          if (next.sort !== filters.sort || next.order !== filters.order) {
            sortTouched.current = true;
          }
          setFilters(next);
        }}
      />

      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
        {search ? t('library.resultsFor', { query: search }) : t('library.popular')}
      </h2>

      {error ? <Alert kind="error">{error}</Alert> : null}

      {loading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }, (_, index) => (
            <MovieCardSkeleton key={index} />
          ))}
        </div>
      ) : movies.length === 0 ? (
        <div className="card px-6 py-16 text-center">
          <p className="text-base font-medium text-slate-200">{t('library.empty')}</p>
          <p className="mt-1 text-sm text-muted">{t('library.emptyHint')}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {movies.map((movie) => (
              <MovieCard key={movie.id} movie={movie} />
            ))}
          </div>

          <div ref={sentinel} className="h-px" />

          {loadingMore ? (
            <div className="flex items-center justify-center gap-3 py-8 text-muted">
              <Spinner />
              <span className="text-sm">{t('library.loadingMore')}</span>
            </div>
          ) : !hasMore ? (
            <p className="py-8 text-center text-sm text-muted">{t('library.endOfList')}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface LibraryFilters {
  sort: 'popularity' | 'title' | 'year' | 'rating';
  order: 'asc' | 'desc';
  genre: string;
  yearMin: string;
  yearMax: string;
  ratingMin: string;
}

export const DEFAULT_FILTERS: LibraryFilters = {
  sort: 'popularity',
  order: 'desc',
  genre: '',
  yearMin: '',
  yearMax: '',
  ratingMin: '',
};

export function countActiveFilters(filters: LibraryFilters): number {
  let count = 0;
  if (filters.genre) count += 1;
  if (filters.yearMin) count += 1;
  if (filters.yearMax) count += 1;
  if (filters.ratingMin) count += 1;
  return count;
}

interface Props {
  filters: LibraryFilters;
  genres: string[];
  onChange: (filters: LibraryFilters) => void;
}

export default function Filters({ filters, genres, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const active = countActiveFilters(filters);

  const set = <K extends keyof LibraryFilters>(key: K, value: LibraryFilters[K]) =>
    onChange({ ...filters, [key]: value });

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[9rem] flex-1 sm:max-w-[13rem]">
          <label className="label" htmlFor="sort">
            {t('library.sortBy')}
          </label>
          <select
            id="sort"
            value={filters.sort}
            onChange={(event) => set('sort', event.target.value as LibraryFilters['sort'])}
            className="field"
          >
            <option value="popularity">{t('library.sortPopularity')}</option>
            <option value="title">{t('library.sortTitle')}</option>
            <option value="year">{t('library.sortYear')}</option>
            <option value="rating">{t('library.sortRating')}</option>
          </select>
        </div>

        <div className="min-w-[8rem] flex-1 sm:max-w-[11rem]">
          <label className="label" htmlFor="order">
            {t('library.order')}
          </label>
          <select
            id="order"
            value={filters.order}
            onChange={(event) => set('order', event.target.value as LibraryFilters['order'])}
            className="field"
          >
            <option value="desc">{t('library.descending')}</option>
            <option value="asc">{t('library.ascending')}</option>
          </select>
        </div>

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="btn-secondary"
        >
          {t('library.filters')}
          {active > 0 ? (
            <span className="rounded-full bg-accent px-1.5 text-[11px] font-bold text-white">
              {active}
            </span>
          ) : null}
        </button>

        {active > 0 ? (
          <button
            type="button"
            onClick={() => onChange({ ...DEFAULT_FILTERS, sort: filters.sort, order: filters.order })}
            className="btn-ghost"
          >
            {t('library.clearFilters')}
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="mt-4 grid gap-4 border-t border-ink-700 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label" htmlFor="genre">
              {t('library.genre')}
            </label>
            <select
              id="genre"
              value={filters.genre}
              onChange={(event) => set('genre', event.target.value)}
              className="field capitalize"
            >
              <option value="">{t('library.allGenres')}</option>
              {genres.map((genre) => (
                <option key={genre} value={genre}>
                  {genre}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className="label">{t('library.yearRange')}</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={1878}
                max={2100}
                placeholder={t('library.from')}
                aria-label={t('library.from')}
                value={filters.yearMin}
                onChange={(event) => set('yearMin', event.target.value)}
                className="field"
              />
              <span className="text-muted" aria-hidden="true">
                –
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={1878}
                max={2100}
                placeholder={t('library.to')}
                aria-label={t('library.to')}
                value={filters.yearMax}
                onChange={(event) => set('yearMax', event.target.value)}
                className="field"
              />
            </div>
          </div>

          <div className="sm:col-span-2 lg:col-span-2">
            <label className="label" htmlFor="ratingMin">
              {t('library.minRating')}
              {filters.ratingMin ? ` — ${filters.ratingMin}` : ''}
            </label>
            <input
              id="ratingMin"
              type="range"
              min={0}
              max={10}
              step={0.5}
              value={filters.ratingMin === '' ? 0 : Number(filters.ratingMin)}
              onChange={(event) =>
                set('ratingMin', event.target.value === '0' ? '' : event.target.value)
              }
              className="mt-2 w-full accent-accent"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

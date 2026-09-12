import { mapLimit } from '../lib/cache';
import { query, queryOne } from '../db/pool';
import { lookupMetadata } from './metadata';
import { popularFromSources, searchSources, type SourceMovie } from './sources';

export type SortField = 'title' | 'year' | 'rating' | 'popularity';
export type SortOrder = 'asc' | 'desc';

export interface BrowseOptions {
  search?: string;
  page: number;
  perPage: number;
  sort: SortField;
  order: SortOrder;
  genre?: string;
  yearMin?: number;
  yearMax?: number;
  ratingMin?: number;
  userId?: number;
}

export interface MovieCard {
  id: number;
  title: string;
  year: number | null;
  rating: number | null;
  coverUrl: string | null;
  genres: string[];
  source: string;
  watched: boolean;
  popularity: number;
}

export interface MovieDetail extends MovieCard {
  summary: string | null;
  backdropUrl: string | null;
  runtime: number | null;
  director: string | null;
  producer: string | null;
  cast: string[];
  imdbId: string | null;
  language: string | null;
  sourceId: string;
  torrents: Array<{
    id: number;
    quality: string;
    container: string | null;
    sizeBytes: number | null;
    seeders: number;
    leechers: number;
  }>;
  commentCount: number;
  subtitles: Array<{ language: string; label: string }>;
  download: {
    status: string;
    progress: number;
    downloadedBytes: number;
    totalBytes: number;
  } | null;
}

export function slugify(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'movie'
  );
}

async function upsertMovie(movie: SourceMovie): Promise<number | null> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO movies (source, source_id, title, slug, year, summary, cover_url,
                         genres, language, runtime, rating, popularity)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (source, source_id) DO UPDATE
        SET title      = EXCLUDED.title,
            year       = COALESCE(movies.year, EXCLUDED.year),
            summary    = COALESCE(movies.summary, EXCLUDED.summary),
            cover_url  = COALESCE(movies.cover_url, EXCLUDED.cover_url),
            genres     = CASE WHEN cardinality(movies.genres) = 0
                              THEN EXCLUDED.genres ELSE movies.genres END,
            popularity = GREATEST(movies.popularity, EXCLUDED.popularity)
     RETURNING id`,
    [
      movie.source,
      movie.sourceId,
      movie.title,
      slugify(movie.title),
      movie.year ?? null,
      movie.summary ?? null,
      movie.coverUrl ?? null,
      movie.genres,
      movie.language ?? null,
      movie.runtime ?? null,
      movie.rating ?? null,
      movie.popularity,
    ],
  );
  if (!row) return null;
  const movieId = Number(row.id);

  for (const torrent of movie.torrents) {
    await query(
      `INSERT INTO movie_torrents (movie_id, quality, container, size_bytes,
                                   seeders, leechers, info_hash, magnet_uri, torrent_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (movie_id, COALESCE(torrent_url, magnet_uri, '')) DO UPDATE
          SET quality    = EXCLUDED.quality,
              container  = COALESCE(EXCLUDED.container, movie_torrents.container),
              seeders    = GREATEST(movie_torrents.seeders, EXCLUDED.seeders),
              leechers   = GREATEST(movie_torrents.leechers, EXCLUDED.leechers),
              size_bytes = COALESCE(EXCLUDED.size_bytes, movie_torrents.size_bytes)`,
      [
        movieId,
        torrent.quality,
        torrent.container ?? null,
        torrent.sizeBytes ?? null,
        torrent.seeders,
        torrent.leechers,
        torrent.infoHash?.toLowerCase() ?? null,
        torrent.magnetUri ?? null,
        torrent.torrentUrl ?? null,
      ],
    ).catch((err) => {
      console.warn(`[catalog] torrent upsert failed: ${(err as Error).message}`);
    });
  }

  return movieId;
}

export async function ingest(movies: SourceMovie[]): Promise<number[]> {
  const ids = await mapLimit(movies, 4, (movie) =>
    upsertMovie(movie).catch((err) => {
      console.warn(`[catalog] upsert failed for "${movie.title}": ${(err as Error).message}`);
      return null;
    }),
  );
  return ids.filter((id): id is number => id !== null);
}

export async function enrich(movieIds: number[]): Promise<void> {
  if (movieIds.length === 0) return;

  const pending = await query<{ id: string; title: string; year: number | null }>(
    `SELECT id, title, year FROM movies
      WHERE id = ANY($1::bigint[]) AND metadata_fetched_at IS NULL
      LIMIT 30`,
    [movieIds],
  );

  await mapLimit(pending, 4, async (row) => {
    const meta = await lookupMetadata(row.title, row.year ?? undefined).catch(() => null);

    await query(
      `UPDATE movies
          SET rating       = COALESCE($2, rating),
              runtime      = COALESCE($3, runtime),
              summary      = COALESCE($4, summary),
              cover_url    = COALESCE($5, cover_url),
              backdrop_url = COALESCE($6, backdrop_url),
              genres       = CASE WHEN cardinality(genres) = 0 AND $7::text[] IS NOT NULL
                                  THEN $7::text[] ELSE genres END,
              cast_members = CASE WHEN cardinality(cast_members) = 0 AND $8::text[] IS NOT NULL
                                  THEN $8::text[] ELSE cast_members END,
              director     = COALESCE(director, $9),
              producer     = COALESCE(producer, $10),
              imdb_id      = COALESCE(imdb_id, $11),
              tmdb_id      = COALESCE(tmdb_id, $12),
              language     = COALESCE(language, $13),
              year         = COALESCE(year, $14),
              metadata_fetched_at = now()
        WHERE id = $1`,
      [
        row.id,
        meta?.rating ?? null,
        meta?.runtime ?? null,
        meta?.summary ?? null,
        meta?.coverUrl ?? null,
        meta?.backdropUrl ?? null,
        meta?.genres ?? null,
        meta?.cast ?? null,
        meta?.director ?? null,
        meta?.producer ?? null,
        meta?.imdbId ?? null,
        meta?.tmdbId ?? null,
        meta?.language ?? null,
        meta?.year ?? null,
      ],
    ).catch(() => undefined);
  });
}

const SORT_COLUMNS: Record<SortField, string> = {
  // Fixed mapping: the client can only choose a key, never inject SQL.
  title: 'm.title',
  year: 'm.year',
  rating: 'm.rating',
  popularity: 'm.popularity',
};

interface MovieRow {
  id: string;
  title: string;
  year: number | null;
  rating: string | null;
  cover_url: string | null;
  genres: string[];
  source: string;
  popularity: number;
  watched: boolean;
}

function toCard(row: MovieRow): MovieCard {
  return {
    id: Number(row.id),
    title: row.title,
    year: row.year,
    rating: row.rating === null ? null : Number(row.rating),
    coverUrl: row.cover_url,
    genres: row.genres ?? [],
    source: row.source,
    watched: row.watched,
    popularity: Number(row.popularity),
  };
}

export async function browse(
  options: BrowseOptions,
): Promise<{ movies: MovieCard[]; hasMore: boolean }> {
  const perPage = Math.min(Math.max(options.perPage, 1), 50);
  const page = Math.max(1, options.page);

  // 1. Refresh from the external sources (never fatal for the page).
  try {
    const fromSources = options.search
      ? await searchSources({ search: options.search, page, perPage })
      : await popularFromSources({ page, perPage });
    const ids = await ingest(fromSources);
    await enrich(ids);
  } catch (err) {
    console.warn(`[catalog] source refresh failed: ${(err as Error).message}`);
  }

  // 2. Serve the page from the database.
  const params: unknown[] = [];
  const where: string[] = [];

  if (options.search && options.search.trim() !== '') {
    params.push(`%${options.search.trim()}%`);
    where.push(`m.title ILIKE $${params.length}`);
  }
  if (options.genre) {
    params.push(options.genre.toLowerCase());
    where.push(`EXISTS (SELECT 1 FROM unnest(m.genres) g WHERE lower(g) = $${params.length})`);
  }
  if (options.yearMin !== undefined) {
    params.push(options.yearMin);
    where.push(`m.year >= $${params.length}`);
  }
  if (options.yearMax !== undefined) {
    params.push(options.yearMax);
    where.push(`m.year <= $${params.length}`);
  }
  if (options.ratingMin !== undefined) {
    params.push(options.ratingMin);
    where.push(`m.rating >= $${params.length}`);
  }
  // Only surface movies we can actually play.
  where.push('EXISTS (SELECT 1 FROM movie_torrents t WHERE t.movie_id = m.id)');

  params.push(options.userId ?? null);
  const userParam = `$${params.length}`;

  const direction = options.order === 'asc' ? 'ASC' : 'DESC';
  const column = SORT_COLUMNS[options.sort] ?? SORT_COLUMNS.popularity;

  params.push(perPage + 1);
  const limitParam = `$${params.length}`;
  params.push((page - 1) * perPage);
  const offsetParam = `$${params.length}`;

  const rows = await query<MovieRow>(
    `SELECT m.id, m.title, m.year, m.rating, m.cover_url, m.genres, m.source, m.popularity,
            (w.user_id IS NOT NULL) AS watched
       FROM movies m
       LEFT JOIN watch_history w
              ON w.movie_id = m.id AND w.user_id = ${userParam}::bigint
      WHERE ${where.join(' AND ')}
      ORDER BY ${column} ${direction} NULLS LAST, m.id ASC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  );

  const hasMore = rows.length > perPage;
  return { movies: rows.slice(0, perPage).map(toCard), hasMore };
}

export async function getMovie(movieId: number, userId?: number): Promise<MovieDetail | null> {
  const row = await queryOne<
    MovieRow & {
      summary: string | null;
      backdrop_url: string | null;
      runtime: number | null;
      director: string | null;
      producer: string | null;
      cast_members: string[];
      imdb_id: string | null;
      language: string | null;
      source_id: string;
      comment_count: string;
    }
  >(
    `SELECT m.id, m.title, m.year, m.rating, m.cover_url, m.genres, m.source, m.source_id,
            m.popularity, m.summary, m.backdrop_url, m.runtime, m.director, m.producer,
            m.cast_members, m.imdb_id, m.language,
            (w.user_id IS NOT NULL) AS watched,
            (SELECT count(*) FROM comments c WHERE c.movie_id = m.id) AS comment_count
       FROM movies m
       LEFT JOIN watch_history w ON w.movie_id = m.id AND w.user_id = $2::bigint
      WHERE m.id = $1`,
    [movieId, userId ?? null],
  );
  if (!row) return null;

  // A detail page is a good moment to fill in anything still missing.
  await enrich([movieId]).catch(() => undefined);

  const torrents = await query<{
    id: string;
    quality: string;
    container: string | null;
    size_bytes: string | null;
    seeders: number;
    leechers: number;
  }>(
    `SELECT id, quality, container, size_bytes, seeders, leechers
       FROM movie_torrents WHERE movie_id = $1
      ORDER BY size_bytes DESC NULLS LAST`,
    [movieId],
  );

  const subtitles = await query<{ language: string; label: string }>(
    'SELECT language, label FROM subtitles WHERE movie_id = $1 ORDER BY language',
    [movieId],
  );

  const download = await queryOne<{
    status: string;
    downloaded_bytes: string;
    total_bytes: string;
  }>(
    `SELECT status, downloaded_bytes, total_bytes
       FROM downloads WHERE movie_id = $1 ORDER BY last_accessed_at DESC LIMIT 1`,
    [movieId],
  );

  const total = download ? Number(download.total_bytes) : 0;
  const downloaded = download ? Number(download.downloaded_bytes) : 0;

  return {
    ...toCard(row),
    summary: row.summary,
    backdropUrl: row.backdrop_url,
    runtime: row.runtime,
    director: row.director,
    producer: row.producer,
    cast: row.cast_members ?? [],
    imdbId: row.imdb_id,
    language: row.language,
    sourceId: row.source_id,
    torrents: torrents.map((t) => ({
      id: Number(t.id),
      quality: t.quality,
      container: t.container,
      sizeBytes: t.size_bytes === null ? null : Number(t.size_bytes),
      seeders: t.seeders,
      leechers: t.leechers,
    })),
    commentCount: Number(row.comment_count),
    subtitles,
    download: download
      ? {
          status: download.status,
          progress: total > 0 ? Math.min(1, downloaded / total) : 0,
          downloadedBytes: downloaded,
          totalBytes: total,
        }
      : null,
  };
}

export async function genres(): Promise<string[]> {
  const rows = await query<{ genre: string }>(
    `SELECT DISTINCT lower(g) AS genre
       FROM movies m, unnest(m.genres) g
      WHERE length(g) BETWEEN 2 AND 30
      ORDER BY genre
      LIMIT 100`,
  );
  return rows.map((r) => r.genre);
}

export async function markWatched(
  userId: number,
  movieId: number,
  positionSec: number,
  completed: boolean,
): Promise<void> {
  await query(
    `INSERT INTO watch_history (user_id, movie_id, position_sec, completed, watched_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id, movie_id) DO UPDATE
        SET position_sec = EXCLUDED.position_sec,
            completed    = watch_history.completed OR EXCLUDED.completed,
            watched_at   = now()`,
    [userId, movieId, Math.max(0, Math.floor(positionSec)), completed],
  );
}

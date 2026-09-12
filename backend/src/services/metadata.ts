import { TtlCache } from '../lib/cache';
import { tryFetchJson } from '../lib/http';
import { config } from '../config';

export interface MovieMetadata {
  title?: string;
  year?: number;
  rating?: number;
  runtime?: number;
  summary?: string;
  coverUrl?: string;
  backdropUrl?: string;
  genres?: string[];
  cast?: string[];
  director?: string;
  producer?: string;
  imdbId?: string;
  tmdbId?: number;
  language?: string;
}

const cache = new TtlCache<MovieMetadata | null>(24 * 60 * 60 * 1000, 3000);

const TMDB = 'https://api.themoviedb.org/3';
const TMDB_IMAGE = 'https://image.tmdb.org/t/p';

export function normaliseTitle(raw: string): { title: string; year?: number } {
  let title = raw
    .replace(/\.(mp4|mkv|avi|webm|mov|mpg|mpeg|ogv)$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');

  const yearMatch = /\b(18|19|20)\d{2}\b/.exec(title);
  const year = yearMatch ? Number(yearMatch[0]) : undefined;

  title = title
    .replace(
      /\b(720p|1080p|2160p|480p|4k|uhd|bluray|brrip|bdrip|dvdrip|webrip|web-dl|hdtv|x264|x265|h264|h265|hevc|xvid|divx|aac|ac3|dts|remastered|extended|unrated|repack|proper|psp|pocketpc|ipod)\b/gi,
      ' ',
    )
    .replace(/\b(18|19|20)\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title: title || raw, year };
}

interface TmdbSearchResponse {
  results?: Array<{
    id: number;
    title: string;
    original_language?: string;
    release_date?: string;
    overview?: string;
    poster_path?: string | null;
    backdrop_path?: string | null;
    vote_average?: number;
  }>;
}

interface TmdbDetails {
  id: number;
  imdb_id?: string | null;
  runtime?: number | null;
  genres?: Array<{ name: string }>;
  credits?: {
    cast?: Array<{ name: string }>;
    crew?: Array<{ name: string; job: string }>;
  };
}

async function fromTmdb(title: string, year?: number): Promise<MovieMetadata | null> {
  if (!config.TMDB_API_KEY) return null;

  const searchParams = new URLSearchParams({
    api_key: config.TMDB_API_KEY,
    query: title,
    include_adult: 'false',
  });
  if (year) searchParams.set('year', String(year));

  const search = await tryFetchJson<TmdbSearchResponse>(
    `${TMDB}/search/movie?${searchParams.toString()}`,
  );
  const hit = search?.results?.[0];
  if (!hit) return null;

  const details = await tryFetchJson<TmdbDetails>(
    `${TMDB}/movie/${hit.id}?api_key=${encodeURIComponent(config.TMDB_API_KEY)}&append_to_response=credits`,
  );

  const crew = details?.credits?.crew ?? [];
  return {
    title: hit.title,
    year: hit.release_date ? Number(hit.release_date.slice(0, 4)) : year,
    rating: typeof hit.vote_average === 'number' ? Number(hit.vote_average.toFixed(1)) : undefined,
    runtime: details?.runtime ?? undefined,
    summary: hit.overview || undefined,
    coverUrl: hit.poster_path ? `${TMDB_IMAGE}/w500${hit.poster_path}` : undefined,
    backdropUrl: hit.backdrop_path ? `${TMDB_IMAGE}/w1280${hit.backdrop_path}` : undefined,
    genres: details?.genres?.map((g) => g.name).slice(0, 8),
    cast: details?.credits?.cast?.slice(0, 12).map((c) => c.name),
    director: crew.find((c) => c.job === 'Director')?.name,
    producer: crew.find((c) => c.job === 'Producer')?.name,
    imdbId: details?.imdb_id ?? undefined,
    tmdbId: hit.id,
    language: hit.original_language,
  };
}

interface OmdbResponse {
  Response: string;
  Title?: string;
  Year?: string;
  Runtime?: string;
  Genre?: string;
  Director?: string;
  Writer?: string;
  Actors?: string;
  Plot?: string;
  Poster?: string;
  imdbRating?: string;
  imdbID?: string;
  Language?: string;
}

async function fromOmdb(title: string, year?: number): Promise<MovieMetadata | null> {
  if (!config.OMDB_API_KEY) return null;

  const params = new URLSearchParams({
    apikey: config.OMDB_API_KEY,
    t: title,
    type: 'movie',
  });
  if (year) params.set('y', String(year));

  const data = await tryFetchJson<OmdbResponse>(`https://www.omdbapi.com/?${params.toString()}`);
  if (!data || data.Response !== 'True') return null;

  const rating = Number(data.imdbRating);
  const runtime = Number(/(\d+)/.exec(data.Runtime ?? '')?.[1]);

  return {
    title: data.Title,
    year: data.Year ? Number(data.Year.slice(0, 4)) : year,
    rating: Number.isFinite(rating) ? rating : undefined,
    runtime: Number.isFinite(runtime) ? runtime : undefined,
    summary: data.Plot && data.Plot !== 'N/A' ? data.Plot : undefined,
    coverUrl: data.Poster && data.Poster !== 'N/A' ? data.Poster : undefined,
    genres: data.Genre?.split(',').map((g) => g.trim()).filter(Boolean),
    cast: data.Actors?.split(',').map((a) => a.trim()).filter(Boolean),
    director: data.Director && data.Director !== 'N/A' ? data.Director : undefined,
    producer: data.Writer && data.Writer !== 'N/A' ? data.Writer : undefined,
    imdbId: data.imdbID,
    language: data.Language?.split(',')[0]?.trim().toLowerCase(),
  };
}

export async function lookupMetadata(rawTitle: string, hintYear?: number): Promise<MovieMetadata | null> {
  const { title, year } = normaliseTitle(rawTitle);
  const effectiveYear = hintYear ?? year;
  const key = `${title.toLowerCase()}|${effectiveYear ?? ''}`;

  return cache.wrap(key, async () => {
    const tmdb = await fromTmdb(title, effectiveYear);
    if (tmdb) return tmdb;
    return fromOmdb(title, effectiveYear);
  });
}

export function metadataProvidersConfigured(): string[] {
  const providers: string[] = [];
  if (config.TMDB_API_KEY) providers.push('tmdb');
  if (config.OMDB_API_KEY) providers.push('omdb');
  return providers;
}

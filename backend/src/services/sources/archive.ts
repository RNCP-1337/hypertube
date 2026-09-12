import { tryFetchJson } from '../../lib/http';
import {
  extractYear,
  stripHtml,
  type MovieSource,
  type SourceMovie,
  type SourceQuery,
} from './types';

interface ArchiveDoc {
  identifier: string;
  title?: string | string[];
  year?: string | number;
  date?: string;
  description?: string | string[];
  downloads?: number;
  avg_rating?: string | number;
  subject?: string | string[];
  language?: string | string[];
  runtime?: string;
  item_size?: number;
  format?: string | string[];
}

interface ArchiveResponse {
  response?: { numFound: number; docs: ArchiveDoc[] };
}

const BASE = 'https://archive.org';

function first(value?: string | string[] | null): string | undefined {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : undefined;
  return value ?? undefined;
}

function list(value?: string | string[] | null): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((v) => String(v).split(/[;,]/))
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.length < 40)
    .slice(0, 8);
}

function parseRuntime(raw?: string): number | undefined {
  if (!raw) return undefined;
  const clock = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (clock) {
    return clock[3]
      ? Number(clock[1]) * 60 + Number(clock[2])
      : Number(clock[1]) * 60 + Number(clock[2]);
  }
  const minutes = /(\d+)\s*min/i.exec(raw);
  return minutes ? Number(minutes[1]) : undefined;
}

function toMovie(doc: ArchiveDoc): SourceMovie | null {
  const title = first(doc.title);
  if (!doc.identifier || !title) return null;

  const rating = Number(first(String(doc.avg_rating ?? '')) ?? NaN);
  const sizeBytes = typeof doc.item_size === 'number' ? doc.item_size : undefined;

  return {
    source: 'archive',
    sourceId: doc.identifier,
    title: title.slice(0, 300),
    year: doc.year ? Number(doc.year) : extractYear(doc.date) ?? extractYear(title),
    summary: stripHtml(first(doc.description)),
    // The Archive renders a poster for every item at a stable URL.
    coverUrl: `${BASE}/services/img/${encodeURIComponent(doc.identifier)}`,
    genres: list(doc.subject),
    language: first(doc.language),
    runtime: parseRuntime(doc.runtime),
    // avg_rating is out of 5; the app displays a /10 grade like IMDb.
    rating: Number.isFinite(rating) && rating > 0 ? Math.min(10, rating * 2) : undefined,
    // log scale so downloads (which span orders of magnitude) compare fairly with other sources
    popularity: doc.downloads ? Math.round(Math.log10(doc.downloads + 1) * 10) : 0,
    torrents: [
      {
        // one torrent holds every encoding, so no single resolution label fits
        quality: 'multi',
        sizeBytes,
        seeders: 0, // filled in by the tracker announce once playback starts
        leechers: 0,
        torrentUrl: `${BASE}/download/${encodeURIComponent(doc.identifier)}/${encodeURIComponent(
          doc.identifier,
        )}_archive.torrent`,
      },
    ],
  };
}

function escapeLucene(input: string): string {
  return input.replace(/["\\]/g, '\\$&').slice(0, 120);
}

// restrict to these collections - mediatype:movies alone also returns home videos and test clips
const COLLECTIONS = [
  'feature_films',
  'classic_cartoons',
  'sci-fi_horror',
  'film_noir',
  'silent_films',
  'short_films',
  'animationandcartoons',
];

async function run(query: SourceQuery, sort: string): Promise<SourceMovie[]> {
  const clauses = [
    'mediatype:(movies)',
    `collection:(${COLLECTIONS.join(' OR ')})`,
  ];
  if (query.search && query.search.trim() !== '') {
    clauses.push(`title:("${escapeLucene(query.search.trim())}")`);
  }

  const params = new URLSearchParams();
  params.set('q', clauses.join(' AND '));
  for (const field of [
    'identifier',
    'title',
    'year',
    'date',
    'description',
    'downloads',
    'avg_rating',
    'subject',
    'language',
    'runtime',
    'item_size',
    'format',
  ]) {
    params.append('fl[]', field);
  }
  params.append('sort[]', sort);
  params.set('rows', String(Math.min(query.perPage, 50)));
  params.set('page', String(Math.max(1, query.page)));
  params.set('output', 'json');

  const data = await tryFetchJson<ArchiveResponse>(
    `${BASE}/advancedsearch.php?${params.toString()}`,
    { timeoutMs: 12_000 },
  );

  const docs = data?.response?.docs ?? [];
  return docs.map(toMovie).filter((m): m is SourceMovie => m !== null);
}

export const archiveSource: MovieSource = {
  id: 'archive',
  label: 'Internet Archive',
  homepage: 'https://archive.org',
  search: (query) => run(query, 'downloads desc'),
  popular: (query) => run(query, 'downloads desc'),
};

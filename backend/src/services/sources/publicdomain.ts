import { fetchBuffer } from '../../lib/http';
import { mapLimit, TtlCache } from '../../lib/cache';
import {
  extractYear,
  guessContainer,
  guessQuality,
  stripHtml,
  type MovieSource,
  type SourceMovie,
  type SourceQuery,
  type SourceTorrent,
} from './types';

const SITE = 'http://www.publicdomaintorrents.info';

interface CatalogueEntry {
  movieId: string;
  title: string;
}

const catalogueCache = new TtlCache<CatalogueEntry[]>(30 * 60 * 1000, 8);
const detailCache = new TtlCache<SourceMovie | null>(6 * 60 * 60 * 1000, 2000);

async function fetchText(url: string): Promise<string> {
  const buf = await fetchBuffer(url, { timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 });
  // The site serves latin1; decoding it as such avoids mojibake in titles.
  return buf.toString('latin1');
}

async function catalogue(): Promise<CatalogueEntry[]> {
  return catalogueCache.wrap('all', async () => {
    const html = await fetchText(`${SITE}/nshowcat.html?category=ALL`);
    const entries: CatalogueEntry[] = [];
    const seen = new Set<string>();

    const pattern = /nshowmovie\.html\?movieid=(\d+)[^>]*>([^<]{1,200})<\/a>/gi;
    for (const match of html.matchAll(pattern)) {
      const movieId = match[1];
      const title = stripHtml(match[2]);
      if (!title || seen.has(movieId)) continue;
      seen.add(movieId);
      entries.push({ movieId, title });
    }
    return entries;
  });
}

async function detail(entry: CatalogueEntry): Promise<SourceMovie | null> {
  return detailCache.wrap(entry.movieId, async () => {
    let html: string;
    try {
      html = await fetchText(`${SITE}/nshowmovie.html?movieid=${encodeURIComponent(entry.movieId)}`);
    } catch {
      return null;
    }

    const title = stripHtml(/<h3>([^<]{1,200})<\/h3>/i.exec(html)?.[1]) ?? entry.title;

    const genres = [
      ...new Set(
        [...html.matchAll(/nshowcat\.html\?category=([a-z]+)>([^<]{1,40})<\/a>/gi)].map((m) =>
          m[2].trim().toLowerCase(),
        ),
      ),
    ]
      .filter((g) => g !== 'all' && g.length > 1)
      .slice(0, 6);

    // screen grabs under /grabs/ double as posters; filter out banner/sidebar images
    const grab = [...html.matchAll(/src=(?:"|')?(grabs\/[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|gif))/gi)]
      .map((m) => m[1])
      .find((src) => !/hdsale|banner|rentme/i.test(src));
    const coverUrl = grab ? `${SITE}/${grab}` : undefined;

    const summary = stripHtml(
      /<\/h3>\s*<br>\s*([\s\S]{0,1200}?)(?:Categories:|User rating:)/i.exec(html)?.[1],
    );

    const torrents: SourceTorrent[] = [];
    const torrentPattern =
      /href=(?:"|')?(https?:\/\/[^\s"'>]*btdownload\.php\?type=torrent&(?:amp;)?file=[^\s"'>]+)(?:"|')?[^>]*>([^<]{0,120})</gi;

    for (const match of html.matchAll(torrentPattern)) {
      const torrentUrl = match[1].replace(/&amp;/g, '&');
      const label = stripHtml(match[2]) ?? '';
      const fileName = decodeURIComponent(/file=([^&]+)/.exec(torrentUrl)?.[1] ?? '');

      torrents.push({
        quality: guessQuality(`${label} ${fileName}`, sizeFromLabel(label)),
        container: guessContainer(fileName.replace(/\.torrent$/i, '')),
        sizeBytes: sizeFromLabel(label),
        seeders: 0,
        leechers: 0,
        torrentUrl,
      });
    }

    if (torrents.length === 0) return null;

    return {
      source: 'publicdomain',
      sourceId: entry.movieId,
      title: title.slice(0, 300),
      year: extractYear(title) ?? extractYear(summary),
      summary,
      coverUrl,
      genres,
      popularity: 0,
      torrents,
    };
  });
}

function sizeFromLabel(label: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)\s*(GB|MB|KB)/i.exec(label);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : 1024;
  return Math.round(value * multiplier);
}

async function page(entries: CatalogueEntry[], query: SourceQuery): Promise<SourceMovie[]> {
  const start = (Math.max(1, query.page) - 1) * query.perPage;
  const slice = entries.slice(start, start + query.perPage);
  if (slice.length === 0) return [];

  const details = await mapLimit(slice, 6, (entry) => detail(entry));
  return details.filter((m): m is SourceMovie => m !== null);
}

export const publicDomainSource: MovieSource = {
  id: 'publicdomain',
  label: 'Public Domain Torrents',
  homepage: SITE,

  async search(query: SourceQuery): Promise<SourceMovie[]> {
    const all = await catalogue();
    const needle = (query.search ?? '').trim().toLowerCase();
    const matches = needle
      ? all.filter((e) => e.title.toLowerCase().includes(needle))
      : all;
    return page(matches, query);
  },

  async popular(query: SourceQuery): Promise<SourceMovie[]> {
    // "top seeded" page is dead; serve the catalogue alphabetically with a flat baseline popularity
    const movies = await page(await catalogue(), query);
    return movies.map((m) => ({ ...m, popularity: 35 }));
  },
};

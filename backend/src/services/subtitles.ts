import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { config, SUPPORTED_LANGUAGES } from '../config';
import { query } from '../db/pool';
import { fetchBuffer, tryFetchJson } from '../lib/http';
import { convertSubtitleFile, extractSubtitle, probe } from './transcode';
import type { Torrent } from '../torrent/torrent';

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  eng: 'English',
  fr: 'Français',
  fre: 'Français',
  fra: 'Français',
  es: 'Español',
  spa: 'Español',
  de: 'Deutsch',
  ger: 'Deutsch',
  it: 'Italiano',
  ita: 'Italiano',
  pt: 'Português',
  ar: 'العربية',
  ara: 'العربية',
  nl: 'Nederlands',
  ru: 'Русский',
  und: 'Unknown',
};

const THREE_TO_TWO: Record<string, string> = {
  eng: 'en',
  fre: 'fr',
  fra: 'fr',
  spa: 'es',
  ger: 'de',
  deu: 'de',
  ita: 'it',
  por: 'pt',
  ara: 'ar',
  nld: 'nl',
  dut: 'nl',
  rus: 'ru',
};

const KNOWN = new Set([
  'en', 'fr', 'es', 'de', 'it', 'pt', 'ar', 'nl', 'ru', 'ja', 'zh', 'ko',
  'pl', 'tr', 'sv', 'da', 'fi', 'no', 'cs', 'el', 'he', 'hi', 'ro', 'hu',
]);

export function normaliseLanguage(raw: string, fallback = 'en'): string {
  const code = raw.toLowerCase().trim().split(/[-_]/)[0];
  const two = THREE_TO_TWO[code] ?? code.slice(0, 2);
  // filenames like ".asr.srt" or ".forced.srt" look like language codes but aren't
  return KNOWN.has(two) ? two : fallback;
}

export function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code.toUpperCase();
}

function subtitleDir(infoHash: string): string {
  return join(config.MEDIA_DIR, infoHash, '.subtitles');
}

async function record(
  movieId: number,
  language: string,
  filePath: string,
  source: string,
): Promise<void> {
  await query(
    `INSERT INTO subtitles (movie_id, language, label, file_path, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (movie_id, language, source) DO UPDATE SET file_path = EXCLUDED.file_path`,
    [movieId, language, languageLabel(language), filePath, source],
  );
}

async function fromTorrentFiles(
  torrent: Torrent,
  movieId: number,
  outputDir: string,
): Promise<string[]> {
  const found: string[] = [];
  const files = torrent.storage?.subtitleFiles() ?? [];

  for (const file of files) {
    const name = basename(file.path[file.path.length - 1]);
    // "movie.en.srt" / "movie.eng.srt" -> en
    const match = /[._-]([a-z]{2,3})\.(srt|vtt|ass|ssa|sub)$/i.exec(name);
    const language = normaliseLanguage(match?.[1] ?? 'en');

    // subtitles are tiny; fetch as a pinned side-request so they don't disturb the video buffer
    const last = Math.max(0, file.length - 1);
    if (!torrent.isRangeAvailable(file, 0, last)) {
      const fetched = await torrent
        .waitForRange(file, 0, last, 90_000, { movePlayhead: false })
        .then(() => true)
        .catch(() => false);
      if (!fetched) continue;
    }

    const target = join(outputDir, `${language}-torrent.vtt`);
    const ok = await convertSubtitleFile(file.absolutePath, target);
    if (!ok) continue;

    await record(movieId, language, target, 'torrent');
    found.push(language);
  }
  return found;
}

async function fromEmbeddedStreams(
  videoPath: string,
  movieId: number,
  outputDir: string,
): Promise<string[]> {
  const info = await probe(videoPath);
  if (!info || info.subtitleStreams.length === 0) return [];

  const found: string[] = [];
  for (const stream of info.subtitleStreams) {
    // Bitmap formats cannot become WebVTT.
    if (/pgs|dvd_?sub|dvb_?sub|hdmv/i.test(stream.codec)) continue;

    const language = normaliseLanguage(stream.language);
    const target = join(outputDir, `${language}-embedded.vtt`);
    const ok = await extractSubtitle(videoPath, stream.index, target);
    if (!ok) continue;

    await record(movieId, language, target, 'embedded');
    found.push(language);
  }
  return found;
}

interface OpenSubtitlesSearch {
  data?: Array<{
    attributes?: {
      language?: string;
      files?: Array<{ file_id?: number; file_name?: string }>;
    };
  }>;
}

interface OpenSubtitlesDownload {
  link?: string;
}

async function fromOpenSubtitles(
  movieId: number,
  imdbId: string | null,
  title: string,
  languages: string[],
  outputDir: string,
): Promise<string[]> {
  if (!config.OPENSUBTITLES_API_KEY || languages.length === 0) return [];

  const headers = {
    'Api-Key': config.OPENSUBTITLES_API_KEY,
    'User-Agent': config.OPENSUBTITLES_USER_AGENT,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const params = new URLSearchParams({ languages: languages.join(','), type: 'movie' });
  if (imdbId) params.set('imdb_id', imdbId.replace(/^tt/, ''));
  else params.set('query', title.slice(0, 100));

  const search = await tryFetchJson<OpenSubtitlesSearch>(
    `https://api.opensubtitles.com/api/v1/subtitles?${params.toString()}`,
    { headers, timeoutMs: 12_000 },
  );
  if (!search?.data?.length) return [];

  const found: string[] = [];
  const seen = new Set<string>();

  for (const entry of search.data.slice(0, 8)) {
    const language = normaliseLanguage(entry.attributes?.language ?? '');
    const fileId = entry.attributes?.files?.[0]?.file_id;
    if (!language || !fileId || seen.has(language)) continue;
    seen.add(language);

    // The download endpoint hands back a short-lived direct link.
    let link: string | undefined;
    try {
      const res = await fetch('https://api.opensubtitles.com/api/v1/download', {
        method: 'POST',
        headers,
        body: JSON.stringify({ file_id: fileId }),
      });
      if (!res.ok) continue;
      link = ((await res.json()) as OpenSubtitlesDownload).link;
    } catch {
      continue;
    }
    if (!link) continue;

    try {
      const srt = await fetchBuffer(link, { maxBytes: 4 * 1024 * 1024 });
      const rawPath = join(outputDir, `${language}-opensubtitles.srt`);
      const vttPath = join(outputDir, `${language}-opensubtitles.vtt`);
      await fs.writeFile(rawPath, srt);
      const ok = await convertSubtitleFile(rawPath, vttPath);
      await fs.rm(rawPath, { force: true });
      if (!ok) continue;

      await record(movieId, language, vttPath, 'opensubtitles');
      found.push(language);
    } catch {
      continue;
    }
  }
  return found;
}

const inProgress = new Set<string>();

export async function collectSubtitles(options: {
  torrent: Torrent;
  movieId: number;
  imdbId: string | null;
  title: string;
  audioLanguage: string | null;
  preferredLanguage: string;
}): Promise<void> {
  const { torrent, movieId, imdbId, title, audioLanguage, preferredLanguage } = options;

  const key = `${torrent.infoHashHex}:${movieId}`;
  if (inProgress.has(key)) return;
  inProgress.add(key);

  try {
    const primary = torrent.primaryFile();
    if (!primary) return;

    const outputDir = subtitleDir(torrent.infoHashHex);
    await fs.mkdir(outputDir, { recursive: true });

    const already = new Set<string>();
    for (const language of await fromTorrentFiles(torrent, movieId, outputDir)) {
      already.add(language);
    }
    for (const language of await fromEmbeddedStreams(primary.absolutePath, movieId, outputDir)) {
      already.add(language);
    }

    // always want English; add the viewer's language too if audio isn't already in it
    const wanted = new Set<string>(['en']);
    if (audioLanguage === null || normaliseLanguage(audioLanguage) !== preferredLanguage) {
      wanted.add(preferredLanguage);
    }
    for (const language of SUPPORTED_LANGUAGES) {
      if (language === preferredLanguage) wanted.add(language);
    }

    const missing = [...wanted].filter((l) => !already.has(l));
    await fromOpenSubtitles(movieId, imdbId, title, missing, outputDir);
  } catch (err) {
    console.warn(`[subtitles] collection failed: ${(err as Error).message}`);
  } finally {
    inProgress.delete(key);
  }
}

export async function listSubtitles(
  movieId: number,
): Promise<Array<{ id: number; language: string; label: string; source: string }>> {
  const rows = await query<{ id: string; language: string; label: string; source: string }>(
    'SELECT id, language, label, source FROM subtitles WHERE movie_id = $1 ORDER BY language, source',
    [movieId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    language: r.language,
    label: r.label,
    source: r.source,
  }));
}

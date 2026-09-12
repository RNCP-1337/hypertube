import { createReadStream, promises as fs } from 'node:fs';
import { extname } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { query, queryOne } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { badRequest, notFound } from '../middleware/errors';
import { idSchema, playSchema, watchProgressSchema } from '../lib/validation';
import { markWatched } from '../services/catalog';
import { collectSubtitles } from '../services/subtitles';
import { isNativelyPlayable, probe, transcodeToMp4 } from '../services/transcode';
import { torrentEngine } from '../torrent/engine';
import type { Torrent } from '../torrent/torrent';
import type { ResolvedFile } from '../torrent/storage';

interface TorrentRow {
  id: string;
  movie_id: string;
  quality: string;
  magnet_uri: string | null;
  torrent_url: string | null;
  info_hash: string | null;
  size_bytes: string | null;
}

async function resolveTorrentRow(movieId: number, torrentId?: number): Promise<TorrentRow> {
  const row = torrentId
    ? await queryOne<TorrentRow>(
        `SELECT id, movie_id, quality, magnet_uri, torrent_url, info_hash, size_bytes
           FROM movie_torrents WHERE id = $1 AND movie_id = $2`,
        [torrentId, movieId],
      )
    : await queryOne<TorrentRow>(
        `SELECT id, movie_id, quality, magnet_uri, torrent_url, info_hash, size_bytes
           FROM movie_torrents
          WHERE movie_id = $1 AND (magnet_uri IS NOT NULL OR torrent_url IS NOT NULL)
          ORDER BY seeders DESC, size_bytes DESC NULLS LAST
          LIMIT 1`,
        [movieId],
      );

  if (!row) throw notFound('no playable torrent for this movie');
  return row;
}

async function startPlayback(movieId: number, torrentId?: number): Promise<Torrent> {
  const row = await resolveTorrentRow(movieId, torrentId);

  const torrent = await torrentEngine.add({
    magnetUri: row.magnet_uri,
    torrentUrl: row.torrent_url,
    infoHash: row.info_hash,
    movieId,
    torrentId: Number(row.id),
  });

  // cache the info-hash so a restart can skip the metadata exchange
  await query(
    'UPDATE movie_torrents SET info_hash = COALESCE(info_hash, $2) WHERE id = $1',
    [row.id, torrent.infoHashHex],
  ).catch(() => undefined);

  return torrent;
}

async function waitForMetadata(torrent: Torrent, timeoutMs = 60_000): Promise<void> {
  if (torrent.meta) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      torrent.off('metadata', onMeta);
      reject(badRequest('could not retrieve the torrent metadata from the swarm'));
    }, timeoutMs);
    const onMeta = () => {
      clearTimeout(timer);
      resolve();
    };
    torrent.once('metadata', onMeta);
  });
}

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number; partial: boolean } {
  if (!header) return { start: 0, end: size - 1, partial: false };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { start: 0, end: size - 1, partial: false };

  const [, rawStart, rawEnd] = match;

  if (rawStart === '') {
    // Suffix range: "bytes=-500" means the last 500 bytes.
    const length = Math.min(Number(rawEnd) || 0, size);
    return { start: Math.max(0, size - length), end: size - 1, partial: true };
  }

  const start = Math.min(Number(rawStart), size - 1);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
    return { start: 0, end: size - 1, partial: false };
  }
  return { start, end, partial: true };
}

const CHUNK_BYTES = 8 * 1024 * 1024;

const NATIVE_CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
};

function nativeContentType(filePath: string): string {
  return NATIVE_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'video/mp4';
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {

  app.post('/:id/play', { preHandler: requireAuth }, async (request, reply) => {
    const movieId = idSchema.parse((request.params as { id: string }).id);
    const body = playSchema.safeParse(request.body ?? {});
    const torrentId = body.success ? body.data.torrentId : undefined;

    const torrent = await startPlayback(movieId, torrentId);

    // fetch metadata + subtitles in the background, don't block the response
    void waitForMetadata(torrent)
      .then(async () => {
        const movie = await queryOne<{ imdb_id: string | null; title: string; language: string | null }>(
          'SELECT imdb_id, title, language FROM movies WHERE id = $1',
          [movieId],
        );
        if (!movie) return;
        await collectSubtitles({
          torrent,
          movieId,
          imdbId: movie.imdb_id,
          title: movie.title,
          audioLanguage: movie.language,
          preferredLanguage: request.user?.language ?? 'en',
        });
      })
      .catch(() => undefined);

    reply.send({
      infoHash: torrent.infoHashHex,
      status: torrent.stats(),
      streamUrl: `/api/movies/${movieId}/stream`,
    });
  });

  app.get('/:id/status', { preHandler: requireAuth }, async (request, reply) => {
    const movieId = idSchema.parse((request.params as { id: string }).id);

    const download = await queryOne<{
      info_hash: string;
      status: string;
      downloaded_bytes: string;
      total_bytes: string;
    }>(
      `SELECT info_hash, status, downloaded_bytes, total_bytes
         FROM downloads WHERE movie_id = $1 ORDER BY last_accessed_at DESC LIMIT 1`,
      [movieId],
    );
    if (!download) {
      reply.send({ started: false, ready: false, progress: 0, status: 'idle' });
      return;
    }

    const torrent = torrentEngine.get(download.info_hash);
    if (torrent) {
      reply.send({ started: true, ...torrent.stats() });
      return;
    }

    const total = Number(download.total_bytes);
    const downloaded = Number(download.downloaded_bytes);
    reply.send({
      started: true,
      status: download.status,
      ready: download.status === 'ready' || download.status === 'completed',
      progress: total > 0 ? Math.min(1, downloaded / total) : 0,
      downloadedBytes: downloaded,
      totalBytes: total,
    });
  });

  app.get('/:id/stream', { preHandler: requireAuth }, async (request, reply) => {
    const movieId = idSchema.parse((request.params as { id: string }).id);

    const torrent = await startPlayback(movieId);
    await waitForMetadata(torrent);

    const file = torrent.primaryFile();
    if (!file) throw notFound('this torrent contains no video file');

    await torrentEngine.touch(torrent.infoHashHex);

    if (isNativelyPlayable(file.absolutePath)) {
      await serveRanged(request, reply, torrent, file);
    } else {
      await serveTranscoded(request, reply, torrent, file);
    }
  });

  app.post('/:id/progress', { preHandler: requireAuth }, async (request, reply) => {
    const movieId = idSchema.parse((request.params as { id: string }).id);
    const parsed = watchProgressSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('invalid progress payload');

    await markWatched(
      request.user!.id,
      movieId,
      parsed.data.positionSec,
      parsed.data.completed,
    );
    reply.code(204).send();
  });

  app.get('/:id/subtitles/:language', { preHandler: requireAuth }, async (request, reply) => {
    const movieId = idSchema.parse((request.params as { id: string }).id);
    const { language } = request.params as { language: string };
    if (!/^[a-z]{2,3}$/i.test(language)) throw notFound('no such subtitle track');

    const row = await queryOne<{ file_path: string }>(
      `SELECT file_path FROM subtitles
        WHERE movie_id = $1 AND language = $2
        ORDER BY CASE source WHEN 'embedded' THEN 0 WHEN 'torrent' THEN 1 ELSE 2 END
        LIMIT 1`,
      [movieId, language.toLowerCase()],
    );
    if (!row) throw notFound('no such subtitle track');

    // The path comes from our own database and always lives under MEDIA_DIR.
    if (!row.file_path.startsWith(config.MEDIA_DIR)) throw notFound('no such subtitle track');
    try {
      await fs.access(row.file_path);
    } catch {
      throw notFound('no such subtitle track');
    }

    // small files, just buffer them instead of setting up a stream
    const vtt = await fs.readFile(row.file_path);
    return reply
      .header('Content-Type', 'text/vtt; charset=utf-8')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=3600')
      .send(vtt);
  });
}

async function serveRanged(
  request: FastifyRequest,
  reply: FastifyReply,
  torrent: Torrent,
  file: ResolvedFile,
): Promise<void> {
  const size = file.length;
  const range = parseRange(request.headers.range, size);

  // Bound the response so we never wait for more of the torrent than needed.
  const end = Math.min(range.end, range.start + CHUNK_BYTES - 1);

  try {
    await torrent.waitForRange(file, range.start, end);
  } catch (err) {
    // 503 + Retry-After: the player will simply ask again.
    reply
      .code(503)
      .header('Retry-After', '3')
      .send({ error: 'buffering', message: (err as Error).message });
    return;
  }

  const length = end - range.start + 1;

  reply
    .code(range.partial ? 206 : 200)
    .header('Content-Type', nativeContentType(file.absolutePath))
    .header('Accept-Ranges', 'bytes')
    .header('Content-Length', String(length))
    .header('Cache-Control', 'no-store');

  if (range.partial) {
    reply.header('Content-Range', `bytes ${range.start}-${end}/${size}`);
  }

  const stream = createReadStream(file.absolutePath, { start: range.start, end });
  request.raw.on('close', () => stream.destroy());
  await reply.send(stream);
}

async function serveTranscoded(
  request: FastifyRequest,
  reply: FastifyReply,
  torrent: Torrent,
  file: ResolvedFile,
): Promise<void> {
  // ffmpeg needs a readable header plus some data ahead of the playhead
  const warmup = Math.min(file.length - 1, 24 * 1024 * 1024);
  try {
    await torrent.waitForRange(file, 0, warmup);
  } catch (err) {
    reply
      .code(503)
      .header('Retry-After', '5')
      .send({ error: 'buffering', message: (err as Error).message });
    return;
  }

  // can't byte-seek a live transcode, so seeking is ?t=<seconds> instead
  const seconds = Number((request.query as { t?: string }).t ?? 0);
  const startSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;

  const info = await probe(file.absolutePath);

  if (startSeconds > 0 && info?.durationSec) {
    // Pull the piece picker to roughly where playback will resume.
    const ratio = Math.min(0.98, startSeconds / info.durationSec);
    const offset = Math.floor(file.length * ratio);
    torrent.seekTo(offset);
    await torrent
      .waitForRange(file, offset, Math.min(file.length - 1, offset + warmup))
      .catch(() => undefined);
  }

  const handle = transcodeToMp4(file.absolutePath, info, startSeconds);

  reply
    .code(200)
    .header('Content-Type', handle.contentType)
    // A live transcode has no known length and cannot answer byte ranges.
    .header('Accept-Ranges', 'none')
    .header('Cache-Control', 'no-store')
    .header('X-Hypertube-Transcoded', '1');

  const cleanup = () => handle.kill();
  request.raw.on('close', cleanup);
  request.raw.on('aborted', cleanup);
  handle.stream.on('end', cleanup);
  handle.stream.on('error', cleanup);

  await reply.send(handle.stream);
}

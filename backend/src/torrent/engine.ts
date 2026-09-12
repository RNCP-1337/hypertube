import { createServer, type Server, type Socket } from 'node:net';
import { promises as fs } from 'node:fs';
import { config } from '../config';
import { query } from '../db/pool';
import { fetchBuffer } from '../lib/http';
import { parseMagnet, parseTorrent, type Metainfo } from './metainfo';
import { Peer } from './peer';
import { Torrent, type TorrentStats } from './torrent';
import { HANDSHAKE_LENGTH, parseHandshake } from './wire';

export interface AddTorrentInput {
  magnetUri?: string | null;
  torrentUrl?: string | null;
  infoHash?: string | null;
  movieId?: number | null;
  torrentId?: number | null;
}

class TorrentEngine {
  private torrents = new Map<string, Torrent>();
  private starting = new Map<string, Promise<Torrent>>();
  private listener: Server | null = null;

  private readonly options = {
    mediaDir: config.MEDIA_DIR,
    port: config.TORRENT_PORT,
    maxPeers: config.TORRENT_MAX_PEERS,
    readaheadPieces: config.TORRENT_READAHEAD_PIECES,
    startThreshold: config.TORRENT_START_THRESHOLD,
  };

  async init(): Promise<void> {
    await fs.mkdir(config.MEDIA_DIR, { recursive: true });
    await fs.mkdir(config.TORRENT_DIR, { recursive: true });
    this.startListener();
  }

  private startListener(): void {
    this.listener = createServer((socket) => this.onInbound(socket));
    this.listener.on('error', (err) => {
      console.warn(`[torrent] peer listener error: ${err.message}`);
    });
    this.listener.listen(config.TORRENT_PORT, '0.0.0.0', () => {
      console.log(`[torrent] listening for peers on :${config.TORRENT_PORT}`);
    });
  }

  private onInbound(socket: Socket): void {
    let buffered: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), 8_000);

    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < HANDSHAKE_LENGTH) return;

      socket.off('data', onData);
      clearTimeout(timer);

      try {
        const handshake = parseHandshake(buffered.subarray(0, HANDSHAKE_LENGTH));
        const torrent = this.torrents.get(handshake.infoHash.toString('hex'));
        if (!torrent) {
          socket.destroy();
          return;
        }
        const address = {
          host: socket.remoteAddress ?? '0.0.0.0',
          port: socket.remotePort ?? 0,
        };
        const peer = new Peer(
          address,
          torrent.infoHash,
          torrent.peerId,
          torrent.meta?.pieceHashes.length ?? 0,
        );
        torrent.acceptPeer(peer, socket, buffered);
      } catch {
        socket.destroy();
      }
    };

    socket.on('error', () => socket.destroy());
    socket.on('data', onData);
  }

  get(infoHash: string): Torrent | undefined {
    return this.torrents.get(infoHash.toLowerCase());
  }

  list(): TorrentStats[] {
    return [...this.torrents.values()].map((t) => t.stats());
  }

  async add(input: AddTorrentInput): Promise<Torrent> {
    const resolved = await this.resolveSource(input);
    const key = resolved.infoHash.toString('hex');

    const existing = this.torrents.get(key);
    if (existing) {
      await this.touch(key);
      return existing;
    }
    const pending = this.starting.get(key);
    if (pending) return pending;

    const startPromise = (async () => {
      const torrent = new Torrent(resolved, this.options);
      this.torrents.set(key, torrent);
      this.bindPersistence(torrent, input);
      await this.upsertDownloadRow(key, input, 'queued');
      await torrent.start();
      await this.upsertDownloadRow(key, input, 'downloading');
      return torrent;
    })().finally(() => this.starting.delete(key));

    this.starting.set(key, startPromise);
    return startPromise;
  }

  private async resolveSource(
    input: AddTorrentInput,
  ): Promise<{ infoHash: Buffer; trackers?: string[]; meta?: Metainfo }> {
    if (input.torrentUrl) {
      const buffer = await fetchBuffer(input.torrentUrl, { maxBytes: 8 * 1024 * 1024 });
      const meta = parseTorrent(buffer);
      // cache the .torrent so a restart doesn't need the source online
      await fs
        .writeFile(`${config.TORRENT_DIR}/${meta.infoHashHex}.torrent`, buffer)
        .catch(() => undefined);
      return { infoHash: meta.infoHash, meta, trackers: meta.announce };
    }

    if (input.magnetUri) {
      const magnet = parseMagnet(input.magnetUri);
      // skip metadata exchange if we already cached the .torrent
      const cached = await fs
        .readFile(`${config.TORRENT_DIR}/${magnet.infoHashHex}.torrent`)
        .catch(() => null);
      if (cached) {
        const meta = parseTorrent(cached);
        return { infoHash: meta.infoHash, meta, trackers: [...magnet.trackers, ...meta.announce] };
      }
      return { infoHash: magnet.infoHash, trackers: magnet.trackers };
    }

    if (input.infoHash && /^[0-9a-f]{40}$/i.test(input.infoHash)) {
      return { infoHash: Buffer.from(input.infoHash, 'hex') };
    }

    throw new Error('no usable torrent source (magnet, .torrent url or info-hash required)');
  }

  private bindPersistence(torrent: Torrent, input: AddTorrentInput): void {
    const key = torrent.infoHashHex;

    torrent.on('metadata', () => {
      void this.upsertDownloadRow(key, input, 'downloading');
    });

    let lastWrite = 0;
    torrent.on('progress', (stats: TorrentStats) => {
      const now = Date.now();
      if (now - lastWrite < 3_000) return; // throttle DB writes
      lastWrite = now;
      void this.writeProgress(key, stats);
    });

    torrent.on('ready', (stats: TorrentStats) => {
      void this.writeProgress(key, stats, 'ready');
    });

    torrent.on('complete', (stats: TorrentStats) => {
      void this.writeProgress(key, stats, 'completed');
    });

    torrent.on('error-state', (message: string) => {
      void query(
        `UPDATE downloads SET status = 'error', error_message = $2 WHERE info_hash = $1`,
        [key, message.slice(0, 500)],
      );
    });
  }

  private async upsertDownloadRow(
    infoHash: string,
    input: AddTorrentInput,
    status: string,
  ): Promise<void> {
    const torrent = this.torrents.get(infoHash);
    const primary = torrent?.primaryFile() ?? null;

    await query(
      `INSERT INTO downloads (info_hash, movie_id, torrent_id, file_path, file_name,
                              total_bytes, status, last_accessed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (info_hash) DO UPDATE
          SET movie_id         = COALESCE(EXCLUDED.movie_id, downloads.movie_id),
              torrent_id       = COALESCE(EXCLUDED.torrent_id, downloads.torrent_id),
              file_path        = COALESCE(EXCLUDED.file_path, downloads.file_path),
              file_name        = COALESCE(EXCLUDED.file_name, downloads.file_name),
              total_bytes      = GREATEST(EXCLUDED.total_bytes, downloads.total_bytes),
              status           = EXCLUDED.status,
              last_accessed_at = now()`,
      [
        infoHash,
        input.movieId ?? null,
        input.torrentId ?? null,
        primary?.absolutePath ?? null,
        primary ? primary.path[primary.path.length - 1] : null,
        torrent?.meta?.totalLength ?? 0,
        status,
      ],
    );
  }

  private async writeProgress(
    infoHash: string,
    stats: TorrentStats,
    status?: string,
  ): Promise<void> {
    const torrent = this.torrents.get(infoHash);
    const primary = torrent?.primaryFile() ?? null;
    await query(
      `UPDATE downloads
          SET downloaded_bytes = $2,
              total_bytes      = GREATEST($3, total_bytes),
              peers            = $4,
              download_rate    = $5,
              status           = COALESCE($6, status),
              file_path        = COALESCE($7, file_path),
              file_name        = COALESCE($8, file_name),
              completed_at     = CASE WHEN $6 = 'completed' THEN now() ELSE completed_at END
        WHERE info_hash = $1`,
      [
        infoHash,
        stats.downloadedBytes,
        stats.totalBytes,
        stats.connectedPeers,
        stats.downloadRate,
        status ?? null,
        primary?.absolutePath ?? null,
        primary ? primary.path[primary.path.length - 1] : null,
      ],
    ).catch(() => undefined);
  }

  async touch(infoHash: string): Promise<void> {
    await query('UPDATE downloads SET last_accessed_at = now() WHERE info_hash = $1', [
      infoHash,
    ]).catch(() => undefined);
  }

  async remove(infoHash: string, deleteData: boolean): Promise<void> {
    const key = infoHash.toLowerCase();
    const torrent = this.torrents.get(key);
    if (torrent) {
      await torrent.stop(deleteData);
      this.torrents.delete(key);
    } else if (deleteData) {
      await fs.rm(`${config.MEDIA_DIR}/${key}`, { recursive: true, force: true });
    }

    if (deleteData) {
      await fs.rm(`${config.TORRENT_DIR}/${key}.torrent`, { force: true }).catch(() => undefined);
      await query(
        `UPDATE downloads
            SET status = 'removed', file_path = NULL, downloaded_bytes = 0, completed_at = NULL
          WHERE info_hash = $1`,
        [key],
      );
    }
  }

  async shutdown(): Promise<void> {
    this.listener?.close();
    await Promise.allSettled([...this.torrents.values()].map((t) => t.stop(false)));
    this.torrents.clear();
  }
}

export const torrentEngine = new TorrentEngine();

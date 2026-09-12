import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Peer } from './peer';
import { PieceManager } from './pieces';
import { TorrentStorage, type ResolvedFile } from './storage';
import { parseMetadataPayload, type Metainfo } from './metainfo';
import { announce, FALLBACK_TRACKERS, type PeerAddress } from './trackers';
import { WebSeed } from './webseed';
import { generatePeerId } from './wire';

export type TorrentStatus =
  | 'metadata'
  | 'downloading'
  | 'ready'
  | 'completed'
  | 'error'
  | 'stopped';

export interface TorrentOptions {
  mediaDir: string;
  port: number;
  maxPeers: number;
  readaheadPieces: number;
  startThreshold: number;
}

export interface TorrentStats {
  infoHash: string;
  name: string;
  status: TorrentStatus;
  progress: number; // 0..1
  downloadedBytes: number;
  totalBytes: number;
  downloadRate: number; // bytes/s
  peers: number;
  connectedPeers: number;
  seeders: number;
  leechers: number;
  webSeeds: number;
  ready: boolean;
  error?: string;
}

const ANNOUNCE_MIN_INTERVAL_MS = 60_000;
const PEER_REFILL_INTERVAL_MS = 2_000;
const RATE_WINDOW_MS = 4_000;
const WEBSEED_PUMP_INTERVAL_MS = 500;
const MIN_START_BYTES = 4 * 1024 * 1024;
const MAX_START_BYTES = 48 * 1024 * 1024;
// non-faststart MP4s keep their moov atom at the end - no player can start before reading it
const TAIL_BYTES = 2 * 1024 * 1024;
const WEBSEED_MAX_INFLIGHT = 6;

export class Torrent extends EventEmitter {
  readonly infoHash: Buffer;
  readonly infoHashHex: string;
  readonly peerId: Buffer;

  meta: Metainfo | null = null;
  storage: TorrentStorage | null = null;
  pieces: PieceManager | null = null;

  status: TorrentStatus = 'metadata';
  error: string | null = null;
  seeders = 0;
  leechers = 0;

  private trackers: string[];
  private knownPeers = new Map<string, PeerAddress>();
  private peers = new Map<string, Peer>();
  private failedPeers = new Set<string>();

  private webSeeds: WebSeed[] = [];
  private webSeedInFlight = new Set<number>();
  private webSeedCursor = 0;

  private announceTimer: NodeJS.Timeout | null = null;
  private refillTimer: NodeJS.Timeout | null = null;
  private webSeedTimer: NodeJS.Timeout | null = null;
  private rateSamples: Array<{ at: number; bytes: number }> = [];
  private stopped = false;

  private waiters: Array<{ from: number; to: number; resolve: () => void; reject: (e: Error) => void }> = [];

  constructor(
    source: { infoHash: Buffer; trackers?: string[]; meta?: Metainfo },
    private readonly options: TorrentOptions,
  ) {
    super();
    this.infoHash = source.infoHash;
    this.infoHashHex = source.infoHash.toString('hex');
    this.peerId = generatePeerId(randomBytes(20));
    this.meta = source.meta ?? null;

    const declared = source.meta?.announce ?? source.trackers ?? [];
    this.trackers = [...new Set([...declared, ...FALLBACK_TRACKERS])];
  }

  async start(): Promise<void> {
    if (this.meta) await this.onMetadataReady(this.meta);
    else this.status = 'metadata';

    await this.announceAll('started');
    this.announceTimer = setInterval(() => {
      void this.announceAll();
    }, ANNOUNCE_MIN_INTERVAL_MS);
    this.announceTimer.unref();

    this.refillTimer = setInterval(() => this.refillPeers(), PEER_REFILL_INTERVAL_MS);
    this.refillTimer.unref();

    this.webSeedTimer = setInterval(() => this.pumpWebSeeds(), WEBSEED_PUMP_INTERVAL_MS);
    this.webSeedTimer.unref();

    this.refillPeers();
  }

  async stop(removeData = false): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.status = 'stopped';

    if (this.announceTimer) clearInterval(this.announceTimer);
    if (this.refillTimer) clearInterval(this.refillTimer);
    if (this.webSeedTimer) clearInterval(this.webSeedTimer);

    for (const peer of this.peers.values()) peer.destroy('torrent stopped');
    this.peers.clear();

    for (const waiter of this.waiters) waiter.reject(new Error('torrent stopped'));
    this.waiters = [];

    await this.announceAll('stopped').catch(() => undefined);

    if (removeData) await this.storage?.destroy();
    else await this.storage?.close();
  }

  private async onMetadataReady(meta: Metainfo): Promise<void> {
    if (this.storage) return;
    this.meta = meta;

    this.storage = new TorrentStorage(meta, this.options.mediaDir);
    await this.storage.open();

    this.pieces = new PieceManager(meta, this.storage, this.options.readaheadPieces);
    await this.pieces.verifyExisting();

    this.pieces.on('piece', (index) => {
      this.rateSamples.push({ at: Date.now(), bytes: this.pieces!.pieceLength(index) });
      this.notifyWaiters();
      this.maybeMarkReady();
      this.emit('progress', this.stats());
      this.refillRequests();
    });

    this.pieces.on('complete', () => {
      this.status = 'completed';
      void this.storage?.flush();
      this.emit('complete', this.stats());
    });

    this.webSeeds = meta.urlList.map((url) => new WebSeed(url, meta));

    // start playhead at the movie file, not byte 0 - skip whatever junk precedes it
    const primary = this.storage.pickPrimaryVideoFile();
    if (primary) {
      this.pieces.setPlayhead(primary.offset);
      const [from, to] = this.tailRange(primary);
      this.pieces.pin(from, to);
    }

    for (const peer of this.peers.values()) peer.setPieceCount(meta.pieceHashes.length);

    this.status = this.pieces.isComplete ? 'completed' : 'downloading';
    this.maybeMarkReady();
    this.emit('metadata', meta);
  }

  private async announceAll(event?: 'started' | 'stopped' | 'completed'): Promise<void> {
    const left = this.meta && this.pieces
      ? Math.max(0, this.meta.totalLength - this.pieces.downloadedBytes)
      : 0;

    const results = await Promise.allSettled(
      this.trackers.map((tracker) =>
        announce(tracker, {
          infoHash: this.infoHash,
          peerId: this.peerId,
          port: this.options.port,
          uploaded: 0,
          downloaded: this.pieces?.downloadedBytes ?? 0,
          left,
          event,
          numWant: 80,
        }),
      ),
    );

    let discovered = 0;
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      this.seeders = Math.max(this.seeders, result.value.seeders ?? 0);
      this.leechers = Math.max(this.leechers, result.value.leechers ?? 0);
      for (const peer of result.value.peers) {
        const key = `${peer.host}:${peer.port}`;
        if (this.knownPeers.has(key)) continue;
        this.knownPeers.set(key, peer);
        discovered += 1;
      }
    }

    if (discovered > 0) this.refillPeers();

    if (this.knownPeers.size === 0 && event === 'started') {
      // Not fatal: trackers may simply be slow. Surfaced through stats.
      this.emit('warning', 'no peers returned by any tracker yet');
    }
  }

  private refillPeers(): void {
    if (this.stopped) return;
    if (this.status === 'completed') return;

    for (const [key, address] of this.knownPeers) {
      if (this.peers.size >= this.options.maxPeers) break;
      if (this.peers.has(key) || this.failedPeers.has(key)) continue;
      this.connectPeer(address);
    }

    // Everything failed? Give previously-failed peers another chance.
    if (this.peers.size === 0 && this.failedPeers.size > 0) this.failedPeers.clear();
  }

  private connectPeer(address: PeerAddress): void {
    const key = `${address.host}:${address.port}`;
    const peer = new Peer(
      address,
      this.infoHash,
      this.peerId,
      this.meta?.pieceHashes.length ?? 0,
    );
    this.peers.set(key, peer);
    this.bindPeer(peer, key);
    peer.connect();
  }

  acceptPeer(peer: Peer, socket: import('node:net').Socket, initialData: Buffer): void {
    const key = peer.id;
    if (this.peers.has(key) || this.peers.size >= this.options.maxPeers) {
      socket.destroy();
      return;
    }
    this.peers.set(key, peer);
    this.bindPeer(peer, key);
    peer.attach(socket, initialData);
  }

  private bindPeer(peer: Peer, key: string): void {
    peer.on('ready', () => {
      if (!this.meta && peer.supportsMetadataExchange) peer.requestMetadata();
    });

    peer.on('metadata', (infoBytes: Buffer) => {
      if (this.meta) return;
      try {
        const meta = parseMetadataPayload(infoBytes, this.infoHash);
        void this.onMetadataReady(meta);
      } catch (err) {
        // metadata didn't hash to our info-hash
        peer.destroy(`bad metadata: ${(err as Error).message}`);
      }
    });

    peer.on('unchoke', () => this.requestFrom(peer));
    peer.on('bitfield', () => {
      if (!this.meta && peer.supportsMetadataExchange) peer.requestMetadata();
      this.requestFrom(peer);
    });
    peer.on('have', () => this.requestFrom(peer));

    peer.on('block', (index, begin, block) => {
      void this.onBlock(peer, index, begin, block);
    });

    peer.on('close', () => {
      this.pieces?.releaseRequests(peer.outstanding.values());
      this.peers.delete(key);
      this.failedPeers.add(key);
    });
  }

  private async onBlock(peer: Peer, index: number, begin: number, block: Buffer): Promise<void> {
    if (!this.pieces) return;
    try {
      await this.pieces.addBlock(index, begin, block);
    } catch (err) {
      this.fail(`failed writing piece ${index}: ${(err as Error).message}`);
      return;
    }
    this.requestFrom(peer);
  }

  private requestFrom(peer: Peer): void {
    if (!this.pieces || this.stopped) return;
    if (!peer.canRequest) return;
    const picks = this.pieces.pick(
      (i) => peer.has(i),
      peer.pipelineRoom,
      this.pieces.inEndgame,
    );
    if (picks.length > 0) peer.request(picks);
  }

  private refillRequests(): void {
    for (const peer of this.peers.values()) this.requestFrom(peer);
  }

  private pumpWebSeeds(): void {
    if (this.stopped || !this.pieces || this.pieces.isComplete) return;

    const healthy = this.webSeeds.filter((s) => s.isHealthy);
    if (healthy.length === 0) return;

    const room = WEBSEED_MAX_INFLIGHT - this.webSeedInFlight.size;
    if (room <= 0) return;

    for (const index of this.pieces.missingByPriority(room, this.webSeedInFlight)) {
      // Round-robin across seeds so one slow mirror cannot hold everything up.
      const seed = healthy[this.webSeedCursor % healthy.length];
      this.webSeedCursor += 1;
      this.webSeedInFlight.add(index);

      void seed
        .fetchPiece(index, this.pieces.pieceLength(index))
        .then((data) => this.pieces?.addWholePiece(index, data))
        .catch(() => undefined)
        .finally(() => this.webSeedInFlight.delete(index));
    }
  }

  get webSeedCount(): number {
    return this.webSeeds.filter((s) => s.isHealthy).length;
  }

  private maybeMarkReady(): void {
    if (!this.pieces || !this.meta) return;
    if (this.status === 'completed') return;

    const primary = this.primaryFile();
    if (!primary) return;

    // cap the start buffer in absolute bytes too - percentage alone waits too long on huge files
    const [firstPiece] = this.storage!.piecesForFileRange(primary, 0, 0);
    const targetBytes = Math.min(
      Math.max(primary.length * this.options.startThreshold, MIN_START_BYTES),
      Math.min(primary.length, MAX_START_BYTES),
    );
    const needed = Math.max(1, Math.ceil(targetBytes / this.meta.pieceLength));
    const lastNeeded = Math.min(this.pieces.pieceCount - 1, firstPiece + needed - 1);

    const [tailFrom, tailTo] = this.tailRange(primary);

    if (this.pieces.hasRange(firstPiece, lastNeeded) && this.pieces.hasRange(tailFrom, tailTo)) {
      if (this.status !== 'ready') {
        this.status = 'ready';
        this.emit('ready', this.stats());
      }
    } else if (this.status === 'metadata') {
      this.status = 'downloading';
    }
  }

  private tailRange(file: ResolvedFile): [number, number] {
    const tailStart = Math.max(0, file.length - TAIL_BYTES);
    return this.storage!.piecesForFileRange(file, tailStart, file.length - 1);
  }

  primaryFile(): ResolvedFile | null {
    return this.storage?.pickPrimaryVideoFile() ?? null;
  }

  seekTo(fileByteOffset: number): void {
    const primary = this.primaryFile();
    if (!primary || !this.pieces) return;
    this.pieces.setPlayhead(primary.offset + fileByteOffset);
    this.refillRequests();
  }

  isRangeAvailable(file: ResolvedFile, start: number, end: number): boolean {
    if (!this.pieces || !this.storage) return false;
    const [from, to] = this.storage.piecesForFileRange(file, start, end);
    return this.pieces.hasRange(from, to);
  }

  waitForRange(
    file: ResolvedFile,
    start: number,
    end: number,
    timeoutMs = 120_000,
    options: { movePlayhead?: boolean } = {},
  ): Promise<void> {
    if (!this.pieces || !this.storage) return Promise.reject(new Error('torrent has no metadata'));

    const [from, to] = this.storage.piecesForFileRange(file, start, end);
    if (this.pieces.hasRange(from, to)) return Promise.resolve();

    if (options.movePlayhead === false) this.pieces.pin(from, to);
    else this.seekTo(start);
    this.refillRequests();
    this.pumpWebSeeds();

    return new Promise<void>((resolve, reject) => {
      const entry = {
        from,
        to,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== entry);
        reject(new Error('timed out waiting for torrent data'));
      }, timeoutMs);
      timer.unref();
      this.waiters.push(entry);
    });
  }

  private notifyWaiters(): void {
    if (!this.pieces) return;
    const stillWaiting: typeof this.waiters = [];
    for (const waiter of this.waiters) {
      if (this.pieces.hasRange(waiter.from, waiter.to)) waiter.resolve();
      else stillWaiting.push(waiter);
    }
    this.waiters = stillWaiting;
  }

  private fail(message: string): void {
    this.error = message;
    this.status = 'error';
    for (const waiter of this.waiters) waiter.reject(new Error(message));
    this.waiters = [];
    this.emit('error-state', message);
  }

  get downloadRate(): number {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    this.rateSamples = this.rateSamples.filter((s) => s.at >= cutoff);
    const bytes = this.rateSamples.reduce((sum, s) => sum + s.bytes, 0);
    return Math.round((bytes * 1000) / RATE_WINDOW_MS);
  }

  stats(): TorrentStats {
    const total = this.meta?.totalLength ?? 0;
    const downloaded = this.pieces?.downloadedBytes ?? 0;
    return {
      infoHash: this.infoHashHex,
      name: this.meta?.name ?? this.infoHashHex,
      status: this.status,
      progress: total > 0 ? Math.min(1, downloaded / total) : 0,
      downloadedBytes: downloaded,
      totalBytes: total,
      downloadRate: this.downloadRate,
      peers: this.knownPeers.size,
      connectedPeers: [...this.peers.values()].filter((p) => p.isConnected).length,
      seeders: this.seeders,
      leechers: this.leechers,
      webSeeds: this.webSeedCount,
      ready: this.status === 'ready' || this.status === 'completed',
      error: this.error ?? undefined,
    };
  }
}

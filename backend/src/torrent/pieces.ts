import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Bitfield, BLOCK_LENGTH } from './wire';
import type { Metainfo } from './metainfo';
import type { TorrentStorage } from './storage';

export interface BlockRequest {
  index: number;
  begin: number;
  length: number;
}

interface PieceState {
  received: boolean[];
  inFlight: Map<number, number>;
  buffer: Buffer | null;
  receivedCount: number;
}

const REQUEST_TIMEOUT_MS = 25_000;

export declare interface PieceManager {
  on(event: 'piece', listener: (index: number) => void): this;
  on(event: 'complete', listener: () => void): this;
  on(event: 'corrupt', listener: (index: number) => void): this;
  emit(event: 'piece', index: number): boolean;
  emit(event: 'complete'): boolean;
  emit(event: 'corrupt', index: number): boolean;
}

export class PieceManager extends EventEmitter {
  readonly pieceCount: number;
  readonly have: Bitfield;

  private readonly states: PieceState[];
  private readonly blocksPerPiece: number[];
  private playhead = 0;
  private completedCount = 0;
  private readonly pinned = new Set<number>();

  constructor(
    private readonly meta: Metainfo,
    private readonly storage: TorrentStorage,
    private readonly readaheadPieces: number,
  ) {
    super();
    this.pieceCount = meta.pieceHashes.length;
    this.have = new Bitfield(this.pieceCount);
    this.blocksPerPiece = [];
    this.states = [];

    for (let i = 0; i < this.pieceCount; i += 1) {
      const blocks = Math.ceil(this.pieceLength(i) / BLOCK_LENGTH);
      this.blocksPerPiece.push(blocks);
      this.states.push({
        received: new Array<boolean>(blocks).fill(false),
        inFlight: new Map(),
        buffer: null,
        receivedCount: 0,
      });
    }
  }

  pieceLength(index: number): number {
    if (index < this.pieceCount - 1) return this.meta.pieceLength;
    const remainder = this.meta.totalLength % this.meta.pieceLength;
    return remainder === 0 ? this.meta.pieceLength : remainder;
  }

  private blockLength(index: number, blockIndex: number): number {
    const pieceLen = this.pieceLength(index);
    const begin = blockIndex * BLOCK_LENGTH;
    return Math.min(BLOCK_LENGTH, pieceLen - begin);
  }

  get completed(): number {
    return this.completedCount;
  }

  get downloadedBytes(): number {
    let total = 0;
    for (let i = 0; i < this.pieceCount; i += 1) {
      if (this.have.get(i)) total += this.pieceLength(i);
    }
    return total;
  }

  get isComplete(): boolean {
    return this.completedCount >= this.pieceCount;
  }

  hasPiece(index: number): boolean {
    return this.have.get(index);
  }

  hasRange(from: number, to: number): boolean {
    for (let i = from; i <= to; i += 1) if (!this.have.get(i)) return false;
    return true;
  }

  // Mark a range as urgent without moving the playhead: small side files
  // (subtitles) must not push the video buffer out of the way.
  pin(from: number, to: number): void {
    for (let i = from; i <= to; i += 1) {
      if (!this.have.get(i)) this.pinned.add(i);
    }
  }

  setPlayhead(byteOffset: number): void {
    this.playhead = Math.max(0, Math.min(byteOffset, this.meta.totalLength - 1));
  }

  get playheadPiece(): number {
    return Math.floor(this.playhead / this.meta.pieceLength);
  }

  async verifyExisting(): Promise<void> {
    for (let i = 0; i < this.pieceCount; i += 1) {
      const len = this.pieceLength(i);
      let data: Buffer;
      try {
        data = await this.storage.read(i * this.meta.pieceLength, len);
      } catch {
        continue;
      }
      const digest = createHash('sha1').update(data).digest();
      if (digest.equals(this.meta.pieceHashes[i])) {
        this.have.set(i, true);
        this.completedCount += 1;
      }
    }
  }

  private priority(index: number): number {
    if (this.pinned.has(index)) return -1;
    const head = this.playheadPiece;
    if (index < head) return 1_000_000 + index;
    const distance = index - head;
    if (distance < this.readaheadPieces) return distance;
    return 1_000 + distance;
  }

  pick(peerHas: (index: number) => boolean, limit: number, endgame = false): BlockRequest[] {
    if (limit <= 0) return [];

    const now = Date.now();
    const candidates: number[] = [];

    for (let i = 0; i < this.pieceCount; i += 1) {
      if (this.have.get(i)) continue;
      if (!peerHas(i)) continue;
      candidates.push(i);
    }
    candidates.sort((a, b) => this.priority(a) - this.priority(b));

    const picks: BlockRequest[] = [];
    for (const index of candidates) {
      if (picks.length >= limit) break;
      const state = this.states[index];

      for (let block = 0; block < this.blocksPerPiece[index]; block += 1) {
        if (picks.length >= limit) break;
        if (state.received[block]) continue;

        const requestedAt = state.inFlight.get(block);
        if (requestedAt !== undefined) {
          const stale = now - requestedAt > REQUEST_TIMEOUT_MS;
          if (!stale && !endgame) continue;
        }

        state.inFlight.set(block, now);
        picks.push({
          index,
          begin: block * BLOCK_LENGTH,
          length: this.blockLength(index, block),
        });
      }
    }
    return picks;
  }

  releaseRequests(requests: Iterable<BlockRequest>): void {
    for (const req of requests) {
      const state = this.states[req.index];
      if (!state) continue;
      const block = Math.floor(req.begin / BLOCK_LENGTH);
      if (!state.received[block]) state.inFlight.delete(block);
    }
  }

  missingByPriority(limit: number, exclude: ReadonlySet<number>): number[] {
    const candidates: number[] = [];
    for (let i = 0; i < this.pieceCount; i += 1) {
      if (this.have.get(i) || exclude.has(i)) continue;
      candidates.push(i);
    }
    candidates.sort((a, b) => this.priority(a) - this.priority(b));
    return candidates.slice(0, limit);
  }

  get inEndgame(): boolean {
    return this.pieceCount - this.completedCount <= 3;
  }

  async addWholePiece(index: number, data: Buffer): Promise<boolean> {
    if (index < 0 || index >= this.pieceCount) return false;
    if (this.have.get(index)) return false;
    if (data.length !== this.pieceLength(index)) return false;

    const digest = createHash('sha1').update(data).digest();
    if (!digest.equals(this.meta.pieceHashes[index])) {
      this.emit('corrupt', index);
      return false;
    }

    await this.storage.write(index * this.meta.pieceLength, data);

    const state = this.states[index];
    state.buffer = null;
    state.received.fill(true);
    state.receivedCount = this.blocksPerPiece[index];
    state.inFlight.clear();

    this.have.set(index, true);
    this.completedCount += 1;
    this.pinned.delete(index);

    this.emit('piece', index);
    if (this.isComplete) this.emit('complete');
    return true;
  }

  async addBlock(index: number, begin: number, block: Buffer): Promise<boolean> {
    if (index < 0 || index >= this.pieceCount) return false;
    if (this.have.get(index)) return false;
    if (begin % BLOCK_LENGTH !== 0) return false;

    const blockIndex = begin / BLOCK_LENGTH;
    const state = this.states[index];
    if (blockIndex >= this.blocksPerPiece[index]) return false;
    if (state.received[blockIndex]) return false;
    if (block.length !== this.blockLength(index, blockIndex)) return false;

    if (!state.buffer) state.buffer = Buffer.alloc(this.pieceLength(index));
    block.copy(state.buffer, begin);
    state.received[blockIndex] = true;
    state.receivedCount += 1;
    state.inFlight.delete(blockIndex);

    if (state.receivedCount < this.blocksPerPiece[index]) return false;

    const digest = createHash('sha1').update(state.buffer).digest();
    if (!digest.equals(this.meta.pieceHashes[index])) {
      // Corrupt piece: throw everything away and re-download it.
      state.buffer = null;
      state.received.fill(false);
      state.receivedCount = 0;
      state.inFlight.clear();
      this.emit('corrupt', index);
      return false;
    }

    await this.storage.write(index * this.meta.pieceLength, state.buffer);
    state.buffer = null; // free the memory as soon as it is on disk
    this.have.set(index, true);
    this.completedCount += 1;
    this.pinned.delete(index);

    this.emit('piece', index);
    if (this.isComplete) this.emit('complete');
    return true;
  }
}

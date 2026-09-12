import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { asNumber, decode, encode, isDict, type BencodeDict } from './bencode';
import {
  Bitfield,
  buildHandshake,
  MessageFramer,
  messages,
  type Handshake,
  type WireMessage,
} from './wire';
import type { BlockRequest } from './pieces';
import type { PeerAddress } from './trackers';

const CONNECT_TIMEOUT_MS = 8_000;
const IDLE_TIMEOUT_MS = 60_000;
const KEEPALIVE_INTERVAL_MS = 100_000;
const MAX_PIPELINE = 12;
const METADATA_PIECE_SIZE = 16 * 1024;

export interface PeerEvents {
  ready: () => void;
  unchoke: () => void;
  have: (index: number) => void;
  bitfield: () => void;
  block: (index: number, begin: number, block: Buffer) => void;
  metadata: (infoBytes: Buffer) => void;
  close: (reason: string) => void;
}

export declare interface Peer {
  on<K extends keyof PeerEvents>(event: K, listener: PeerEvents[K]): this;
  once<K extends keyof PeerEvents>(event: K, listener: PeerEvents[K]): this;
  emit<K extends keyof PeerEvents>(event: K, ...args: Parameters<PeerEvents[K]>): boolean;
}

export class Peer extends EventEmitter {
  readonly address: PeerAddress;

  private socket: Socket | null = null;
  private framer = new MessageFramer();
  private closed = false;

  peerChoking = true;
  peerInterested = false;
  amInterested = false;
  handshakeComplete = false;

  bitfield: Bitfield | null = null;
  private pieceCount: number;

  readonly outstanding = new Map<string, BlockRequest>();

  bytesDownloaded = 0;
  private lastActivity = Date.now();
  private keepAliveTimer: NodeJS.Timeout | null = null;

  private extensionIds: Record<string, number> = {};
  private metadataSize = 0;
  private metadataPieces: (Buffer | null)[] = [];
  private metadataRequested = new Set<number>();

  constructor(
    address: PeerAddress,
    private readonly infoHash: Buffer,
    private readonly peerId: Buffer,
    pieceCount: number,
  ) {
    super();
    this.address = address;
    this.pieceCount = pieceCount;
    if (pieceCount > 0) this.bitfield = new Bitfield(pieceCount);
  }

  get id(): string {
    return `${this.address.host}:${this.address.port}`;
  }

  get isConnected(): boolean {
    return !this.closed && this.handshakeComplete;
  }

  get canRequest(): boolean {
    return this.isConnected && !this.peerChoking && this.outstanding.size < MAX_PIPELINE;
  }

  get pipelineRoom(): number {
    return Math.max(0, MAX_PIPELINE - this.outstanding.size);
  }

  setPieceCount(count: number): void {
    if (this.pieceCount === count) return;
    const previous = this.bitfield;
    this.pieceCount = count;
    this.bitfield = new Bitfield(count, previous?.buffer);
  }

  has(index: number): boolean {
    return this.bitfield ? this.bitfield.get(index) : false;
  }

  connect(): void {
    const socket = new Socket();
    this.wire(socket, CONNECT_TIMEOUT_MS);
    socket.connect(this.address.port, this.address.host, () => {
      socket.setTimeout(IDLE_TIMEOUT_MS);
      this.send(buildHandshake(this.infoHash, this.peerId));
    });
  }

  attach(socket: Socket, initialData: Buffer): void {
    this.wire(socket, IDLE_TIMEOUT_MS);
    this.send(buildHandshake(this.infoHash, this.peerId));
    if (initialData.length > 0) this.onData(initialData);
  }

  private wire(socket: Socket, timeout: number): void {
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setTimeout(timeout);

    socket.on('timeout', () => {
      // After the handshake the socket is allowed to idle longer.
      const limit = this.handshakeComplete ? IDLE_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
      if (Date.now() - this.lastActivity >= limit) this.destroy('timeout');
    });
    socket.on('error', (err) => this.destroy(err.message));
    socket.on('close', () => this.destroy('socket closed'));
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  private send(buf: Buffer): void {
    if (this.closed || !this.socket || this.socket.destroyed) return;
    this.socket.write(buf);
  }

  private onData(chunk: Buffer): void {
    this.lastActivity = Date.now();
    let result: { handshake?: Handshake; messages: WireMessage[] };
    try {
      result = this.framer.push(chunk);
    } catch (err) {
      this.destroy(`protocol error: ${(err as Error).message}`);
      return;
    }

    if (result.handshake) {
      if (!result.handshake.infoHash.equals(this.infoHash)) {
        this.destroy('info-hash mismatch');
        return;
      }
      this.handshakeComplete = true;
      if (result.handshake.supportsExtended) this.sendExtensionHandshake();
      this.send(messages.interested());
      this.amInterested = true;
      this.startKeepAlive();
      this.emit('ready');
    }

    for (const message of result.messages) this.handleMessage(message);
  }

  private handleMessage(message: WireMessage): void {
    switch (message.type) {
      case 'keep-alive':
        break;
      case 'choke':
        this.peerChoking = true;
        break;
      case 'unchoke':
        this.peerChoking = false;
        this.emit('unchoke');
        break;
      case 'interested':
        this.peerInterested = true;
        break;
      case 'not-interested':
        this.peerInterested = false;
        break;
      case 'have':
        if (!this.bitfield && this.pieceCount > 0) this.bitfield = new Bitfield(this.pieceCount);
        this.bitfield?.set(message.index, true);
        this.emit('have', message.index);
        break;
      case 'bitfield':
        this.bitfield = new Bitfield(this.pieceCount || message.bits.length * 8, message.bits);
        this.emit('bitfield');
        break;
      case 'piece': {
        const key = `${message.index}:${message.begin}`;
        this.outstanding.delete(key);
        this.bytesDownloaded += message.block.length;
        this.emit('block', message.index, message.begin, message.block);
        break;
      }
      case 'extended':
        this.handleExtended(message.extensionId, message.payload);
        break;
      // we're leecher-only and stay choked, so ignore request/cancel; port is DHT, unused
      default:
        break;
    }
  }

  private sendExtensionHandshake(): void {
    const payload = encode({
      m: { ut_metadata: 1 } as unknown as BencodeDict,
      v: Buffer.from('Hypertube 1.0', 'utf8'),
      reqq: 250,
    } as unknown as BencodeDict);
    this.send(messages.extended(0, payload));
  }

  private handleExtended(extensionId: number, payload: Buffer): void {
    if (extensionId === 0) {
      this.handleExtensionHandshake(payload);
      return;
    }
    // Our own ut_metadata id is 1 (advertised above).
    if (extensionId === 1) this.handleMetadataMessage(payload);
  }

  private handleExtensionHandshake(payload: Buffer): void {
    let dict: unknown;
    try {
      dict = decode(payload);
    } catch {
      return;
    }
    if (!isDict(dict as never)) return;
    const root = dict as BencodeDict;

    const m = root['m'];
    if (isDict(m)) {
      for (const [name, value] of Object.entries(m)) {
        const id = asNumber(value);
        if (id !== undefined) this.extensionIds[name] = id;
      }
    }
    const size = asNumber(root['metadata_size']);
    if (size !== undefined && size > 0 && size < 16 * 1024 * 1024) {
      this.metadataSize = size;
      this.metadataPieces = new Array(Math.ceil(size / METADATA_PIECE_SIZE)).fill(null);
    }
  }

  get supportsMetadataExchange(): boolean {
    return this.extensionIds['ut_metadata'] !== undefined && this.metadataSize > 0;
  }

  requestMetadata(): void {
    const id = this.extensionIds['ut_metadata'];
    if (id === undefined || this.metadataSize === 0) return;

    for (let piece = 0; piece < this.metadataPieces.length; piece += 1) {
      if (this.metadataPieces[piece] || this.metadataRequested.has(piece)) continue;
      this.metadataRequested.add(piece);
      this.send(messages.extended(id, encode({ msg_type: 0, piece } as unknown as BencodeDict)));
    }
  }

  private handleMetadataMessage(payload: Buffer): void {
    // The bencoded header is followed immediately by the raw piece bytes.
    let header: BencodeDict;
    let headerLength: number;
    try {
      header = decode(payload) as BencodeDict;
      if (!isDict(header)) return;
      headerLength = encode(header).length;
    } catch {
      return;
    }

    const msgType = asNumber(header['msg_type']);
    const piece = asNumber(header['piece']);
    if (msgType !== 1 || piece === undefined) return; // 0 = request, 2 = reject

    const data = payload.subarray(headerLength);
    if (piece < 0 || piece >= this.metadataPieces.length) return;
    this.metadataPieces[piece] = data;

    if (this.metadataPieces.every((p) => p !== null)) {
      const full = Buffer.concat(this.metadataPieces as Buffer[]).subarray(0, this.metadataSize);
      this.emit('metadata', full);
    }
  }

  request(requests: BlockRequest[]): void {
    for (const req of requests) {
      const key = `${req.index}:${req.begin}`;
      if (this.outstanding.has(key)) continue;
      this.outstanding.set(key, req);
      this.send(messages.request(req.index, req.begin, req.length));
    }
  }

  cancel(req: BlockRequest): void {
    const key = `${req.index}:${req.begin}`;
    if (!this.outstanding.delete(key)) return;
    this.send(messages.cancel(req.index, req.begin, req.length));
  }

  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(() => this.send(messages.keepAlive()), KEEPALIVE_INTERVAL_MS);
    this.keepAliveTimer.unref();
  }

  destroy(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.socket?.destroy();
    this.socket = null;
    this.emit('close', reason);
    this.removeAllListeners();
  }
}

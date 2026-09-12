export const PROTOCOL_STRING = 'BitTorrent protocol';
export const HANDSHAKE_LENGTH = 68;
export const BLOCK_LENGTH = 16 * 1024; // 16 KiB, the de-facto request size

export enum MessageId {
  Choke = 0,
  Unchoke = 1,
  Interested = 2,
  NotInterested = 3,
  Have = 4,
  Bitfield = 5,
  Request = 6,
  Piece = 7,
  Cancel = 8,
  Port = 9,
  Extended = 20,
}

export interface Handshake {
  infoHash: Buffer;
  peerId: Buffer;
  supportsExtended: boolean;
}

export function buildHandshake(infoHash: Buffer, peerId: Buffer): Buffer {
  const buf = Buffer.alloc(HANDSHAKE_LENGTH);
  buf.writeUInt8(PROTOCOL_STRING.length, 0);
  buf.write(PROTOCOL_STRING, 1, 'ascii');
  buf.fill(0, 20, 28);
  buf[25] = 0x10; // extension protocol
  infoHash.copy(buf, 28);
  peerId.copy(buf, 48);
  return buf;
}

export function parseHandshake(buf: Buffer): Handshake {
  if (buf.length < HANDSHAKE_LENGTH) throw new Error('handshake too short');
  const pstrlen = buf.readUInt8(0);
  if (pstrlen !== PROTOCOL_STRING.length) throw new Error('unexpected protocol string length');
  if (buf.toString('ascii', 1, 1 + pstrlen) !== PROTOCOL_STRING) {
    throw new Error('unexpected protocol string');
  }
  return {
    infoHash: buf.subarray(28, 48),
    peerId: buf.subarray(48, 68),
    supportsExtended: (buf[25] & 0x10) !== 0,
  };
}

function withLengthPrefix(id: MessageId, payload?: Buffer): Buffer {
  const body = payload ?? Buffer.alloc(0);
  const buf = Buffer.alloc(5 + body.length);
  buf.writeUInt32BE(1 + body.length, 0);
  buf.writeUInt8(id, 4);
  body.copy(buf, 5);
  return buf;
}

export const messages = {
  keepAlive: (): Buffer => Buffer.alloc(4), // length 0
  choke: (): Buffer => withLengthPrefix(MessageId.Choke),
  unchoke: (): Buffer => withLengthPrefix(MessageId.Unchoke),
  interested: (): Buffer => withLengthPrefix(MessageId.Interested),
  notInterested: (): Buffer => withLengthPrefix(MessageId.NotInterested),

  have: (pieceIndex: number): Buffer => {
    const p = Buffer.alloc(4);
    p.writeUInt32BE(pieceIndex, 0);
    return withLengthPrefix(MessageId.Have, p);
  },

  bitfield: (bits: Buffer): Buffer => withLengthPrefix(MessageId.Bitfield, bits),

  request: (index: number, begin: number, length: number): Buffer => {
    const p = Buffer.alloc(12);
    p.writeUInt32BE(index, 0);
    p.writeUInt32BE(begin, 4);
    p.writeUInt32BE(length, 8);
    return withLengthPrefix(MessageId.Request, p);
  },

  cancel: (index: number, begin: number, length: number): Buffer => {
    const p = Buffer.alloc(12);
    p.writeUInt32BE(index, 0);
    p.writeUInt32BE(begin, 4);
    p.writeUInt32BE(length, 8);
    return withLengthPrefix(MessageId.Cancel, p);
  },

  piece: (index: number, begin: number, block: Buffer): Buffer => {
    const p = Buffer.alloc(8 + block.length);
    p.writeUInt32BE(index, 0);
    p.writeUInt32BE(begin, 4);
    block.copy(p, 8);
    return withLengthPrefix(MessageId.Piece, p);
  },

  extended: (extensionId: number, payload: Buffer): Buffer => {
    const p = Buffer.alloc(1 + payload.length);
    p.writeUInt8(extensionId, 0);
    payload.copy(p, 1);
    return withLengthPrefix(MessageId.Extended, p);
  },
};

export type WireMessage =
  | { type: 'keep-alive' }
  | { type: 'choke' }
  | { type: 'unchoke' }
  | { type: 'interested' }
  | { type: 'not-interested' }
  | { type: 'have'; index: number }
  | { type: 'bitfield'; bits: Buffer }
  | { type: 'request'; index: number; begin: number; length: number }
  | { type: 'piece'; index: number; begin: number; block: Buffer }
  | { type: 'cancel'; index: number; begin: number; length: number }
  | { type: 'port'; port: number }
  | { type: 'extended'; extensionId: number; payload: Buffer }
  | { type: 'unknown'; id: number };

export function parseMessage(body: Buffer): WireMessage {
  if (body.length === 0) return { type: 'keep-alive' };
  const id = body.readUInt8(0);
  const payload = body.subarray(1);

  switch (id) {
    case MessageId.Choke:
      return { type: 'choke' };
    case MessageId.Unchoke:
      return { type: 'unchoke' };
    case MessageId.Interested:
      return { type: 'interested' };
    case MessageId.NotInterested:
      return { type: 'not-interested' };
    case MessageId.Have:
      if (payload.length < 4) throw new Error('short have message');
      return { type: 'have', index: payload.readUInt32BE(0) };
    case MessageId.Bitfield:
      return { type: 'bitfield', bits: payload };
    case MessageId.Request:
      if (payload.length < 12) throw new Error('short request message');
      return {
        type: 'request',
        index: payload.readUInt32BE(0),
        begin: payload.readUInt32BE(4),
        length: payload.readUInt32BE(8),
      };
    case MessageId.Piece:
      if (payload.length < 8) throw new Error('short piece message');
      return {
        type: 'piece',
        index: payload.readUInt32BE(0),
        begin: payload.readUInt32BE(4),
        block: payload.subarray(8),
      };
    case MessageId.Cancel:
      if (payload.length < 12) throw new Error('short cancel message');
      return {
        type: 'cancel',
        index: payload.readUInt32BE(0),
        begin: payload.readUInt32BE(4),
        length: payload.readUInt32BE(8),
      };
    case MessageId.Port:
      if (payload.length < 2) throw new Error('short port message');
      return { type: 'port', port: payload.readUInt16BE(0) };
    case MessageId.Extended:
      if (payload.length < 1) throw new Error('short extended message');
      return {
        type: 'extended',
        extensionId: payload.readUInt8(0),
        payload: payload.subarray(1),
      };
    default:
      return { type: 'unknown', id };
  }
}

export class MessageFramer {
  private buffer: Buffer = Buffer.alloc(0);
  private handshakeDone = false;

  private static readonly MAX_MESSAGE = 1024 * 1024; // 1 MiB

  push(chunk: Buffer): { handshake?: Handshake; messages: WireMessage[] } {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: WireMessage[] = [];
    let handshake: Handshake | undefined;

    if (!this.handshakeDone) {
      if (this.buffer.length < HANDSHAKE_LENGTH) return { messages: out };
      handshake = parseHandshake(this.buffer.subarray(0, HANDSHAKE_LENGTH));
      this.buffer = this.buffer.subarray(HANDSHAKE_LENGTH);
      this.handshakeDone = true;
    }

    for (;;) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32BE(0);
      if (length > MessageFramer.MAX_MESSAGE) throw new Error('peer sent an oversized message');
      if (this.buffer.length < 4 + length) break;
      out.push(parseMessage(this.buffer.subarray(4, 4 + length)));
      this.buffer = this.buffer.subarray(4 + length);
    }

    return { handshake, messages: out };
  }

  get pending(): number {
    return this.buffer.length;
  }
}

export class Bitfield {
  private readonly bits: Buffer;

  constructor(
    public readonly size: number,
    source?: Buffer,
  ) {
    const bytes = Math.ceil(size / 8);
    this.bits = Buffer.alloc(bytes);
    if (source) source.copy(this.bits, 0, 0, Math.min(source.length, bytes));
  }

  get(index: number): boolean {
    if (index < 0 || index >= this.size) return false;
    return (this.bits[index >> 3] & (0x80 >> (index & 7))) !== 0;
  }

  set(index: number, value = true): void {
    if (index < 0 || index >= this.size) return;
    const byte = index >> 3;
    const mask = 0x80 >> (index & 7);
    if (value) this.bits[byte] |= mask;
    else this.bits[byte] &= ~mask;
  }

  get buffer(): Buffer {
    return this.bits;
  }

  count(): number {
    let total = 0;
    for (const byte of this.bits) {
      let b = byte;
      while (b) {
        total += b & 1;
        b >>= 1;
      }
    }
    return total;
  }

  isComplete(): boolean {
    return this.count() >= this.size;
  }
}

export function generatePeerId(random: Buffer): Buffer {
  const prefix = Buffer.from('-HT1000-', 'ascii');
  return Buffer.concat([prefix, random.subarray(0, 20 - prefix.length)]);
}

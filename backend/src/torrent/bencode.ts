export type BencodeValue = Buffer | number | BencodeList | BencodeDict;
export interface BencodeList extends Array<BencodeValue> {}
export interface BencodeDict {
  [key: string]: BencodeValue;
}

const CHAR_i = 0x69; // 'i'
const CHAR_l = 0x6c; // 'l'
const CHAR_d = 0x64; // 'd'
const CHAR_e = 0x65; // 'e'
const CHAR_COLON = 0x3a; // ':'

export class BencodeError extends Error {}

class Decoder {
  private offset = 0;

  readonly ranges = new Map<string, [number, number]>();

  constructor(private readonly buf: Buffer) {}

  decode(): BencodeValue {
    const value = this.readValue(0);
    return value;
  }

  get position(): number {
    return this.offset;
  }

  private byte(): number {
    if (this.offset >= this.buf.length) throw new BencodeError('unexpected end of input');
    return this.buf[this.offset];
  }

  private readValue(depth: number): BencodeValue {
    if (depth > 100) throw new BencodeError('nesting too deep');
    const c = this.byte();
    if (c === CHAR_i) return this.readInteger();
    if (c === CHAR_l) return this.readList(depth);
    if (c === CHAR_d) return this.readDict(depth);
    if (c >= 0x30 && c <= 0x39) return this.readString();
    throw new BencodeError(`invalid token 0x${c.toString(16)} at offset ${this.offset}`);
  }

  private readInteger(): number {
    this.offset += 1; // skip 'i'
    const end = this.buf.indexOf(CHAR_e, this.offset);
    if (end === -1) throw new BencodeError('unterminated integer');
    const raw = this.buf.toString('ascii', this.offset, end);
    if (!/^-?\d+$/.test(raw) || raw === '-0' || /^-?0\d/.test(raw)) {
      throw new BencodeError(`invalid integer "${raw}"`);
    }
    this.offset = end + 1;
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new BencodeError(`integer out of range "${raw}"`);
    return value;
  }

  private readString(): Buffer {
    const colon = this.buf.indexOf(CHAR_COLON, this.offset);
    if (colon === -1) throw new BencodeError('unterminated string length');
    const raw = this.buf.toString('ascii', this.offset, colon);
    if (!/^\d+$/.test(raw)) throw new BencodeError(`invalid string length "${raw}"`);
    const length = Number(raw);
    const start = colon + 1;
    const end = start + length;
    if (end > this.buf.length) throw new BencodeError('string longer than input');
    this.offset = end;
    return this.buf.subarray(start, end);
  }

  private readList(depth: number): BencodeList {
    this.offset += 1; // skip 'l'
    const list: BencodeList = [];
    while (this.byte() !== CHAR_e) list.push(this.readValue(depth + 1));
    this.offset += 1; // skip 'e'
    return list;
  }

  private readDict(depth: number): BencodeDict {
    const isTopLevel = depth === 0;
    this.offset += 1; // skip 'd'
    const dict: BencodeDict = {};
    let previousKey: string | null = null;

    while (this.byte() !== CHAR_e) {
      const key = this.readString().toString('utf8');
      // BEP-3 requires sorted keys; tolerate violations but keep the last value.
      if (previousKey !== null && key < previousKey && depth === 0) {
        // not fatal - some real-world torrents are sloppy
      }
      previousKey = key;
      const valueStart = this.offset;
      dict[key] = this.readValue(depth + 1);
      if (isTopLevel) this.ranges.set(key, [valueStart, this.offset]);
    }
    this.offset += 1; // skip 'e'
    return dict;
  }
}

export function decode(buf: Buffer): BencodeValue {
  return new Decoder(buf).decode();
}

export function decodeTorrentFile(buf: Buffer): { root: BencodeDict; infoBytes: Buffer } {
  const decoder = new Decoder(buf);
  const root = decoder.decode();
  if (!isDict(root)) throw new BencodeError('torrent root is not a dictionary');
  const range = decoder.ranges.get('info');
  if (!range) throw new BencodeError('torrent has no info dictionary');
  return { root, infoBytes: buf.subarray(range[0], range[1]) };
}

export function encode(value: BencodeValue): Buffer {
  const parts: Buffer[] = [];
  write(value, parts);
  return Buffer.concat(parts);
}

function write(value: BencodeValue, out: Buffer[]): void {
  if (Buffer.isBuffer(value)) {
    out.push(Buffer.from(`${value.length}:`, 'ascii'), value);
    return;
  }
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8');
    out.push(Buffer.from(`${b.length}:`, 'ascii'), b);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new BencodeError('cannot bencode a non-integer number');
    out.push(Buffer.from(`i${value}e`, 'ascii'));
    return;
  }
  if (Array.isArray(value)) {
    out.push(Buffer.from('l', 'ascii'));
    for (const item of value) write(item, out);
    out.push(Buffer.from('e', 'ascii'));
    return;
  }
  if (value && typeof value === 'object') {
    out.push(Buffer.from('d', 'ascii'));
    // Keys must be emitted in lexicographic byte order (BEP-3).
    for (const key of Object.keys(value).sort()) {
      const k = Buffer.from(key, 'utf8');
      out.push(Buffer.from(`${k.length}:`, 'ascii'), k);
      write(value[key], out);
    }
    out.push(Buffer.from('e', 'ascii'));
    return;
  }
  throw new BencodeError(`cannot bencode value of type ${typeof value}`);
}

export function isDict(v: BencodeValue | undefined): v is BencodeDict {
  return !!v && !Buffer.isBuffer(v) && !Array.isArray(v) && typeof v === 'object';
}

export function asBuffer(v: BencodeValue | undefined): Buffer | undefined {
  return Buffer.isBuffer(v) ? v : undefined;
}

export function asString(v: BencodeValue | undefined): string | undefined {
  return Buffer.isBuffer(v) ? v.toString('utf8') : undefined;
}

export function asNumber(v: BencodeValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

export function asList(v: BencodeValue | undefined): BencodeList | undefined {
  return Array.isArray(v) ? v : undefined;
}

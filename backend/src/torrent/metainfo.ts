import { createHash } from 'node:crypto';
import {
  asBuffer,
  asList,
  asNumber,
  asString,
  BencodeError,
  decodeTorrentFile,
  encode,
  isDict,
  type BencodeDict,
} from './bencode';

export interface TorrentFileEntry {
  path: string[];
  length: number;
  offset: number;
  // BEP-47 padding: alignment filler, defined to be zeros. It occupies room in
  // the address space but exists on no server and on no peer's disk.
  padding: boolean;
}

export interface Metainfo {
  infoHash: Buffer; // 20 raw bytes
  infoHashHex: string; // 40 lowercase hex chars
  name: string;
  pieceLength: number;
  pieceHashes: Buffer[]; // 20 bytes each
  totalLength: number;
  files: TorrentFileEntry[];
  announce: string[];
  urlList: string[];
  private: boolean;
  raw: BencodeDict;
}

// Clients that predate the `attr` field mark padding with a conventional name.
function isPaddingPath(path: string[]): boolean {
  return path.some((part) => /^\.?_+padding_file/i.test(part));
}

function sanitiseComponent(component: string): string {
  const cleaned = component.replace(/\0/g, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    throw new BencodeError('illegal path component in torrent');
  }
  if (cleaned.includes('/') || cleaned.includes('\\')) {
    throw new BencodeError('path separator in torrent path component');
  }
  return cleaned;
}

export function parseInfoDictionary(info: BencodeDict, infoBytes: Buffer): Metainfo {
  const name = asString(info['name']) ?? 'unnamed';
  const pieceLength = asNumber(info['piece length']);
  const piecesBuf = asBuffer(info['pieces']);

  if (!pieceLength || pieceLength <= 0) throw new BencodeError('missing "piece length"');
  if (!piecesBuf || piecesBuf.length % 20 !== 0) throw new BencodeError('malformed "pieces"');

  const pieceHashes: Buffer[] = [];
  for (let i = 0; i < piecesBuf.length; i += 20) {
    pieceHashes.push(piecesBuf.subarray(i, i + 20));
  }

  const files: TorrentFileEntry[] = [];
  let offset = 0;

  const fileList = asList(info['files']);
  if (fileList) {
    // Multi-file torrent: `name` is the containing directory.
    for (const entry of fileList) {
      if (!isDict(entry)) continue;
      const length = asNumber(entry['length']);
      const pathList = asList(entry['path']);
      if (length === undefined || !pathList) continue;
      const path = pathList
        .map((p) => asString(p) ?? '')
        .filter((p) => p !== '')
        .map(sanitiseComponent);
      if (path.length === 0) continue;

      const attr = asString(entry['attr']) ?? '';
      const padding = attr.includes('p') || isPaddingPath(path);

      files.push({ path, length, offset, padding });
      offset += length;
    }
  } else {
    const length = asNumber(info['length']);
    if (length === undefined) throw new BencodeError('single-file torrent without "length"');
    files.push({ path: [sanitiseComponent(name)], length, offset, padding: false });
    offset += length;
  }

  const totalLength = offset;
  const expectedPieces = Math.ceil(totalLength / pieceLength);
  if (expectedPieces !== pieceHashes.length) {
    throw new BencodeError(
      `piece count mismatch: ${pieceHashes.length} hashes for ${expectedPieces} pieces`,
    );
  }

  const infoHash = createHash('sha1').update(infoBytes).digest();

  return {
    infoHash,
    infoHashHex: infoHash.toString('hex'),
    name,
    pieceLength,
    pieceHashes,
    totalLength,
    files,
    announce: [],
    urlList: [],
    private: asNumber(info['private']) === 1,
    raw: info,
  };
}

export function parseTorrent(buffer: Buffer): Metainfo {
  const { root, infoBytes } = decodeTorrentFile(buffer);
  const info = root['info'];
  if (!isDict(info)) throw new BencodeError('info dictionary missing');

  const meta = parseInfoDictionary(info, infoBytes);
  meta.announce = collectTrackers(root);
  meta.urlList = collectWebSeeds(root);
  return meta;
}

export function parseMetadataPayload(infoBytes: Buffer, expectedHash: Buffer): Metainfo {
  const actual = createHash('sha1').update(infoBytes).digest();
  if (!actual.equals(expectedHash)) {
    throw new BencodeError('metadata info-hash mismatch (peer sent forged metadata)');
  }
  // Wrap the raw info bytes in a one-key dictionary so the generic decoder
  // can read them back while `infoBytes` stays byte-identical for the hash.
  const { root } = decodeTorrentFile(
    Buffer.concat([Buffer.from('d4:info', 'ascii'), infoBytes, Buffer.from('e', 'ascii')]),
  );
  const info = root['info'];
  if (!isDict(info)) throw new BencodeError('metadata payload is not an info dictionary');
  return parseInfoDictionary(info, infoBytes);
}

function collectTrackers(root: BencodeDict): string[] {
  const out = new Set<string>();
  const announce = asString(root['announce']);
  if (announce) out.add(announce);

  const tiers = asList(root['announce-list']);
  if (tiers) {
    for (const tier of tiers) {
      const urls = asList(tier);
      if (!urls) continue;
      for (const url of urls) {
        const s = asString(url);
        if (s) out.add(s);
      }
    }
  }
  return [...out].filter((u) => /^(https?|udp):\/\//i.test(u));
}

function collectWebSeeds(root: BencodeDict): string[] {
  const raw = root['url-list'];
  const urls: string[] = [];

  const single = asString(raw);
  if (single) urls.push(single);

  for (const entry of asList(raw) ?? []) {
    const url = asString(entry);
    if (url) urls.push(url);
  }
  return [...new Set(urls)].filter((u) => /^https?:\/\//i.test(u));
}

export function encodeInfo(info: BencodeDict): Buffer {
  return encode(info);
}

export interface MagnetInfo {
  infoHash: Buffer;
  infoHashHex: string;
  displayName?: string;
  trackers: string[];
}

export function parseMagnet(uri: string): MagnetInfo {
  if (!uri.startsWith('magnet:?')) throw new BencodeError('not a magnet URI');
  const params = new URLSearchParams(uri.slice('magnet:?'.length));

  const xt = params.getAll('xt').find((v) => v.toLowerCase().startsWith('urn:btih:'));
  if (!xt) throw new BencodeError('magnet URI without urn:btih info-hash');

  const raw = xt.slice('urn:btih:'.length);
  let infoHash: Buffer;
  if (/^[0-9a-fA-F]{40}$/.test(raw)) {
    infoHash = Buffer.from(raw, 'hex');
  } else if (/^[A-Z2-7]{32}$/i.test(raw)) {
    infoHash = base32Decode(raw.toUpperCase());
  } else {
    throw new BencodeError('unsupported info-hash encoding in magnet URI');
  }

  return {
    infoHash,
    infoHashHex: infoHash.toString('hex'),
    displayName: params.get('dn') ?? undefined,
    trackers: params.getAll('tr').filter((u) => /^(https?|udp):\/\//i.test(u)),
  };
}

function base32Decode(input: string): Buffer {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new BencodeError('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export function toMagnet(meta: Pick<Metainfo, 'infoHashHex' | 'name' | 'announce'>): string {
  const params = new URLSearchParams();
  params.set('xt', `urn:btih:${meta.infoHashHex}`);
  params.set('dn', meta.name);
  for (const tracker of meta.announce) params.append('tr', tracker);
  return `magnet:?${params.toString()}`;
}

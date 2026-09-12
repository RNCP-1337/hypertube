import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { asBuffer, asList, asNumber, asString, decode, isDict } from './bencode';

export interface PeerAddress {
  host: string;
  port: number;
}

export interface AnnounceRequest {
  infoHash: Buffer;
  peerId: Buffer;
  port: number;
  uploaded: number;
  downloaded: number;
  left: number;
  event?: 'started' | 'stopped' | 'completed';
  numWant?: number;
}

export interface AnnounceResponse {
  interval: number;
  peers: PeerAddress[];
  seeders?: number;
  leechers?: number;
}

const DEFAULT_TIMEOUT = 12_000;

function urlEncodeBytes(buf: Buffer): string {
  let out = '';
  for (const byte of buf) {
    if (
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      byte === 0x2d || // -
      byte === 0x2e || // .
      byte === 0x5f || // _
      byte === 0x7e // ~
    ) {
      out += String.fromCharCode(byte);
    } else {
      out += `%${byte.toString(16).padStart(2, '0')}`;
    }
  }
  return out;
}

export function parseCompactPeers(buf: Buffer): PeerAddress[] {
  const peers: PeerAddress[] = [];
  for (let i = 0; i + 6 <= buf.length; i += 6) {
    const host = `${buf[i]}.${buf[i + 1]}.${buf[i + 2]}.${buf[i + 3]}`;
    const port = buf.readUInt16BE(i + 4);
    if (port > 0) peers.push({ host, port });
  }
  return peers;
}

export function parseCompactPeers6(buf: Buffer): PeerAddress[] {
  const peers: PeerAddress[] = [];
  for (let i = 0; i + 18 <= buf.length; i += 18) {
    const groups: string[] = [];
    for (let g = 0; g < 8; g += 1) groups.push(buf.readUInt16BE(i + g * 2).toString(16));
    const port = buf.readUInt16BE(i + 16);
    if (port > 0) peers.push({ host: groups.join(':'), port });
  }
  return peers;
}

export async function announceHttp(
  trackerUrl: string,
  req: AnnounceRequest,
  timeout = DEFAULT_TIMEOUT,
): Promise<AnnounceResponse> {
  const url = new URL(trackerUrl);

  const query = [
    `info_hash=${urlEncodeBytes(req.infoHash)}`,
    `peer_id=${urlEncodeBytes(req.peerId)}`,
    `port=${req.port}`,
    `uploaded=${req.uploaded}`,
    `downloaded=${req.downloaded}`,
    `left=${req.left}`,
    'compact=1',
    'supportcrypto=0',
    `numwant=${req.numWant ?? 80}`,
  ];
  if (req.event) query.push(`event=${req.event}`);

  url.search = (url.search ? `${url.search.slice(1)}&` : '') + query.join('&');

  const body = await httpGet(url, timeout);
  const decoded = decode(body);
  if (!isDict(decoded)) throw new Error('tracker response is not a dictionary');

  const failure = asString(decoded['failure reason']);
  if (failure) throw new Error(`tracker refused: ${failure}`);

  const peers: PeerAddress[] = [];
  const peersField = decoded['peers'];
  const compact = asBuffer(peersField);
  if (compact) {
    peers.push(...parseCompactPeers(compact));
  } else {
    // Non-compact form: a list of dictionaries.
    const list = asList(peersField);
    for (const entry of list ?? []) {
      if (!isDict(entry)) continue;
      const host = asString(entry['ip']);
      const port = asNumber(entry['port']);
      if (host && port) peers.push({ host, port });
    }
  }
  const peers6 = asBuffer(decoded['peers6']);
  if (peers6) peers.push(...parseCompactPeers6(peers6));

  return {
    interval: asNumber(decoded['interval']) ?? 1800,
    peers,
    seeders: asNumber(decoded['complete']),
    leechers: asNumber(decoded['incomplete']),
  };
}

function httpGet(url: URL, timeout: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { 'User-Agent': 'Hypertube/1.0', Accept: '*/*', Connection: 'close' },
        timeout,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          httpGet(new URL(res.headers.location, url), timeout).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`tracker HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 2 * 1024 * 1024) {
            req.destroy(new Error('tracker response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('tracker timeout')));
    req.on('error', reject);
    req.end();
  });
}

const UDP_PROTOCOL_ID = 0x41727101980n; // magic constant from BEP-15
const ACTION_CONNECT = 0;
const ACTION_ANNOUNCE = 1;
const ACTION_ERROR = 3;

export async function announceUdp(
  trackerUrl: string,
  req: AnnounceRequest,
  timeout = DEFAULT_TIMEOUT,
): Promise<AnnounceResponse> {
  const url = new URL(trackerUrl);
  const host = url.hostname;
  const port = Number(url.port || 80);

  const socket = createSocket('udp4');
  const cleanup = () => {
    try {
      socket.close();
    } catch {}
  };

  try {
    const connectionId = await udpConnect(socket, host, port, timeout);
    return await udpAnnounce(socket, host, port, connectionId, req, timeout);
  } finally {
    cleanup();
  }
}

function udpSend(
  socket: ReturnType<typeof createSocket>,
  payload: Buffer,
  host: string,
  port: number,
  transactionId: number,
  timeout: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeListener('message', onMessage);
      reject(new Error('udp tracker timeout'));
    }, timeout);

    const onMessage = (msg: Buffer) => {
      if (msg.length < 8) return;
      if (msg.readUInt32BE(4) !== transactionId) return; // not our transaction
      clearTimeout(timer);
      socket.removeListener('message', onMessage);
      if (msg.readUInt32BE(0) === ACTION_ERROR) {
        reject(new Error(`udp tracker error: ${msg.subarray(8).toString('utf8')}`));
        return;
      }
      resolve(msg);
    };

    socket.on('message', onMessage);
    socket.send(payload, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        socket.removeListener('message', onMessage);
        reject(err);
      }
    });
  });
}

async function udpConnect(
  socket: ReturnType<typeof createSocket>,
  host: string,
  port: number,
  timeout: number,
): Promise<bigint> {
  const transactionId = randomBytes(4).readUInt32BE(0);
  const packet = Buffer.alloc(16);
  packet.writeBigUInt64BE(UDP_PROTOCOL_ID, 0);
  packet.writeUInt32BE(ACTION_CONNECT, 8);
  packet.writeUInt32BE(transactionId, 12);

  const res = await udpSend(socket, packet, host, port, transactionId, timeout);
  if (res.length < 16 || res.readUInt32BE(0) !== ACTION_CONNECT) {
    throw new Error('malformed udp connect response');
  }
  return res.readBigUInt64BE(8);
}

async function udpAnnounce(
  socket: ReturnType<typeof createSocket>,
  host: string,
  port: number,
  connectionId: bigint,
  req: AnnounceRequest,
  timeout: number,
): Promise<AnnounceResponse> {
  const transactionId = randomBytes(4).readUInt32BE(0);
  const packet = Buffer.alloc(98);

  packet.writeBigUInt64BE(connectionId, 0);
  packet.writeUInt32BE(ACTION_ANNOUNCE, 8);
  packet.writeUInt32BE(transactionId, 12);
  req.infoHash.copy(packet, 16);
  req.peerId.copy(packet, 36);
  packet.writeBigUInt64BE(BigInt(req.downloaded), 56);
  packet.writeBigUInt64BE(BigInt(req.left), 64);
  packet.writeBigUInt64BE(BigInt(req.uploaded), 72);
  packet.writeUInt32BE(eventCode(req.event), 80);
  packet.writeUInt32BE(0, 84); // IP address: 0 = "use the sender's"
  packet.writeUInt32BE(randomBytes(4).readUInt32BE(0), 88); // key
  packet.writeInt32BE(req.numWant ?? 80, 92);
  packet.writeUInt16BE(req.port, 96);

  const res = await udpSend(socket, packet, host, port, transactionId, timeout);
  if (res.length < 20 || res.readUInt32BE(0) !== ACTION_ANNOUNCE) {
    throw new Error('malformed udp announce response');
  }

  return {
    interval: res.readUInt32BE(8),
    leechers: res.readUInt32BE(12),
    seeders: res.readUInt32BE(16),
    peers: parseCompactPeers(res.subarray(20)),
  };
}

function eventCode(event: AnnounceRequest['event']): number {
  switch (event) {
    case 'completed':
      return 1;
    case 'started':
      return 2;
    case 'stopped':
      return 3;
    default:
      return 0;
  }
}

export async function announce(
  trackerUrl: string,
  req: AnnounceRequest,
  timeout = DEFAULT_TIMEOUT,
): Promise<AnnounceResponse> {
  if (trackerUrl.startsWith('udp:')) return announceUdp(trackerUrl, req, timeout);
  if (trackerUrl.startsWith('http:') || trackerUrl.startsWith('https:')) {
    return announceHttp(trackerUrl, req, timeout);
  }
  throw new Error(`unsupported tracker scheme: ${trackerUrl}`);
}

export const FALLBACK_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'http://tracker.openbittorrent.com:80/announce',
];

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { decode, encode, decodeTorrentFile, isDict, type BencodeDict } from './bencode';
import { parseTorrent, parseMagnet, toMagnet } from './metainfo';

test('bencode: integers', () => {
  assert.equal(decode(Buffer.from('i42e')), 42);
  assert.equal(decode(Buffer.from('i-7e')), -7);
  assert.equal(decode(Buffer.from('i0e')), 0);
  assert.throws(() => decode(Buffer.from('i-0e')));
  assert.throws(() => decode(Buffer.from('i03e')));
});

test('bencode: byte strings stay binary', () => {
  const value = decode(Buffer.from('4:\x00\x01\x02\x03', 'binary'));
  assert.ok(Buffer.isBuffer(value));
  assert.deepEqual([...(value as Buffer)], [0, 1, 2, 3]);
});

test('bencode: lists and dictionaries round-trip', () => {
  const source = Buffer.from('d3:agei30e4:listli1ei2ee4:name5:alicee');
  const decoded = decode(source);
  assert.ok(isDict(decoded));
  const dict = decoded as BencodeDict;
  assert.equal(dict['age'], 30);
  assert.equal((dict['name'] as Buffer).toString(), 'alice');
  assert.deepEqual(encode(dict), source);
});

test('bencode: encoder sorts dictionary keys', () => {
  const out = encode({ zebra: Buffer.from('z'), alpha: Buffer.from('a') } as BencodeDict);
  assert.equal(out.toString(), 'd5:alpha1:a5:zebra1:ze');
});

test('bencode: rejects malformed input', () => {
  assert.throws(() => decode(Buffer.from('d3:key')));
  assert.throws(() => decode(Buffer.from('5:ab')));
  assert.throws(() => decode(Buffer.from('x')));
});

function buildTorrent(): { buffer: Buffer; infoHash: string; pieces: Buffer } {
  const pieceLength = 16384;
  const data = Buffer.alloc(pieceLength * 2 + 100, 7);
  const hashes: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += pieceLength) {
    hashes.push(createHash('sha1').update(data.subarray(offset, offset + pieceLength)).digest());
  }
  const pieces = Buffer.concat(hashes);

  const info: BencodeDict = {
    length: data.length,
    name: Buffer.from('big.buck.bunny.mp4'),
    'piece length': pieceLength,
    pieces,
  };
  const infoBytes = encode(info);
  const root: BencodeDict = {
    announce: Buffer.from('udp://tracker.example:6969/announce'),
    'announce-list': [[Buffer.from('udp://tracker.example:6969/announce')]],
    info,
  };
  return {
    buffer: encode(root),
    infoHash: createHash('sha1').update(infoBytes).digest('hex'),
    pieces,
  };
}

test('metainfo: parses a torrent and computes the info-hash over raw bytes', () => {
  const { buffer, infoHash, pieces } = buildTorrent();
  const meta = parseTorrent(buffer);

  assert.equal(meta.infoHashHex, infoHash);
  assert.equal(meta.name, 'big.buck.bunny.mp4');
  assert.equal(meta.pieceLength, 16384);
  assert.equal(meta.pieceHashes.length, pieces.length / 20);
  assert.equal(meta.files.length, 1);
  assert.equal(meta.totalLength, 16384 * 2 + 100);
  assert.ok(meta.announce.includes('udp://tracker.example:6969/announce'));

  const { infoBytes } = decodeTorrentFile(buffer);
  assert.equal(createHash('sha1').update(infoBytes).digest('hex'), infoHash);
});

test('metainfo: flags BEP-47 padding files', () => {
  const pieceLength = 16384;
  const data = Buffer.alloc(pieceLength, 3);
  const info: BencodeDict = {
    files: [
      { length: 100, path: [Buffer.from('movie.mp4')] } as BencodeDict,
      {
        length: pieceLength - 100,
        path: [Buffer.from('.____padding_file'), Buffer.from('0')],
      } as BencodeDict,
    ],
    name: Buffer.from('padded'),
    'piece length': pieceLength,
    pieces: createHash('sha1').update(data).digest(),
  };
  const meta = parseTorrent(encode({ info } as BencodeDict));

  assert.equal(meta.files[0].padding, false);
  assert.equal(meta.files[1].padding, true);
});

test('metainfo: honours the attr padding flag', () => {
  const pieceLength = 16384;
  const data = Buffer.alloc(pieceLength, 3);
  const info: BencodeDict = {
    files: [
      { length: 100, path: [Buffer.from('movie.mp4')] } as BencodeDict,
      {
        attr: Buffer.from('p'),
        length: pieceLength - 100,
        path: [Buffer.from('filler.bin')],
      } as BencodeDict,
    ],
    name: Buffer.from('padded'),
    'piece length': pieceLength,
    pieces: createHash('sha1').update(data).digest(),
  };
  const meta = parseTorrent(encode({ info } as BencodeDict));
  assert.equal(meta.files[1].padding, true);
});

test('metainfo: refuses path traversal in multi-file torrents', () => {
  const pieceLength = 16384;
  const info: BencodeDict = {
    files: [{ length: 10, path: [Buffer.from('..'), Buffer.from('escape.mp4')] } as BencodeDict],
    name: Buffer.from('evil'),
    'piece length': pieceLength,
    pieces: createHash('sha1').update(Buffer.alloc(10)).digest(),
  };
  const buffer = encode({ info } as BencodeDict);
  assert.throws(() => parseTorrent(buffer), /illegal path component/);
});

test('magnet: parses hex and base32 info-hashes', () => {
  const hex = 'a'.repeat(40);
  const magnet = parseMagnet(
    `magnet:?xt=urn:btih:${hex}&dn=Sita+Sings+the+Blues&tr=udp%3A%2F%2Ftracker.example%3A80%2Fannounce`,
  );
  assert.equal(magnet.infoHashHex, hex);
  assert.equal(magnet.displayName, 'Sita Sings the Blues');
  assert.deepEqual(magnet.trackers, ['udp://tracker.example:80/announce']);

  const base32 = parseMagnet('magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(base32.infoHashHex, '0'.repeat(40));

  assert.throws(() => parseMagnet('magnet:?dn=nope'), /without urn:btih/);
  assert.throws(() => parseMagnet('http://example.com'), /not a magnet/);
});

test('magnet: round-trips through toMagnet', () => {
  const uri = toMagnet({
    infoHashHex: 'b'.repeat(40),
    name: 'Night of the Living Dead',
    announce: ['udp://tracker.example:80/announce'],
  });
  const parsed = parseMagnet(uri);
  assert.equal(parsed.infoHashHex, 'b'.repeat(40));
  assert.equal(parsed.displayName, 'Night of the Living Dead');
});

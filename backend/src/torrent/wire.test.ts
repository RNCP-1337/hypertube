import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  Bitfield,
  buildHandshake,
  generatePeerId,
  MessageFramer,
  messages,
  parseHandshake,
  parseMessage,
  MessageId,
} from './wire';
import { parseCompactPeers, parseCompactPeers6 } from './trackers';

test('handshake: builds 68 bytes and advertises the extension protocol', () => {
  const infoHash = randomBytes(20);
  const peerId = generatePeerId(randomBytes(20));
  const hs = buildHandshake(infoHash, peerId);

  assert.equal(hs.length, 68);
  assert.equal(hs.readUInt8(0), 19);
  assert.equal(hs.toString('ascii', 1, 20), 'BitTorrent protocol');
  assert.equal(hs[25] & 0x10, 0x10);

  const parsed = parseHandshake(hs);
  assert.ok(parsed.infoHash.equals(infoHash));
  assert.ok(parsed.peerId.equals(peerId));
  assert.equal(parsed.supportsExtended, true);
});

test('handshake: rejects a foreign protocol', () => {
  const bad = Buffer.alloc(68);
  bad.writeUInt8(19, 0);
  bad.write('NotTorrent protoc', 1, 'ascii');
  assert.throws(() => parseHandshake(bad), /unexpected protocol string/);
});

test('peer id follows the Azureus convention', () => {
  const id = generatePeerId(randomBytes(20));
  assert.equal(id.length, 20);
  assert.equal(id.toString('ascii', 0, 8), '-HT1000-');
});

test('messages: encode then decode', () => {
  const request = messages.request(3, 16384, 16384);
  assert.equal(request.readUInt32BE(0), 13);
  assert.equal(request.readUInt8(4), MessageId.Request);

  const decoded = parseMessage(request.subarray(4));
  assert.deepEqual(decoded, { type: 'request', index: 3, begin: 16384, length: 16384 });

  const block = randomBytes(1024);
  const piece = parseMessage(messages.piece(1, 32768, block).subarray(4));
  assert.equal(piece.type, 'piece');
  if (piece.type === 'piece') {
    assert.equal(piece.index, 1);
    assert.equal(piece.begin, 32768);
    assert.ok(piece.block.equals(block));
  }

  assert.deepEqual(parseMessage(messages.choke().subarray(4)), { type: 'choke' });
  assert.deepEqual(parseMessage(messages.unchoke().subarray(4)), { type: 'unchoke' });
  assert.deepEqual(parseMessage(messages.have(9).subarray(4)), { type: 'have', index: 9 });
  assert.deepEqual(parseMessage(Buffer.alloc(0)), { type: 'keep-alive' });
});

test('framer: reassembles messages split across TCP chunks', () => {
  const infoHash = randomBytes(20);
  const peerId = randomBytes(20);
  const stream = Buffer.concat([
    buildHandshake(infoHash, peerId),
    messages.bitfield(Buffer.from([0xff, 0x00])),
    messages.unchoke(),
    messages.have(5),
  ]);

  const framer = new MessageFramer();
  const collected: string[] = [];
  let handshakeSeen = false;

  // Feed one byte at a time: the worst case a real socket can produce.
  for (const byte of stream) {
    const out = framer.push(Buffer.from([byte]));
    if (out.handshake) handshakeSeen = true;
    for (const message of out.messages) collected.push(message.type);
  }

  assert.equal(handshakeSeen, true);
  assert.deepEqual(collected, ['bitfield', 'unchoke', 'have']);
  assert.equal(framer.pending, 0);
});

test('framer: refuses an oversized message', () => {
  const framer = new MessageFramer();
  framer.push(buildHandshake(randomBytes(20), randomBytes(20)));
  const evil = Buffer.alloc(4);
  evil.writeUInt32BE(50 * 1024 * 1024, 0);
  assert.throws(() => framer.push(evil), /oversized/);
});

test('bitfield: get/set/count', () => {
  const bf = new Bitfield(20);
  assert.equal(bf.count(), 0);
  bf.set(0);
  bf.set(19);
  assert.equal(bf.get(0), true);
  assert.equal(bf.get(19), true);
  assert.equal(bf.get(5), false);
  assert.equal(bf.get(100), false); // out of range is never "have"
  assert.equal(bf.count(), 2);
  assert.equal(bf.isComplete(), false);

  const full = new Bitfield(8, Buffer.from([0xff]));
  assert.equal(full.isComplete(), true);
});

test('compact peer lists', () => {
  const buf = Buffer.from([127, 0, 0, 1, 0x1a, 0xe1, 10, 0, 0, 5, 0x00, 0x00]);
  assert.deepEqual(parseCompactPeers(buf), [{ host: '127.0.0.1', port: 6881 }]);

  const v6 = Buffer.alloc(18);
  v6.writeUInt16BE(0x2001, 0);
  v6.writeUInt16BE(6881, 16);
  assert.equal(parseCompactPeers6(v6)[0].port, 6881);
});

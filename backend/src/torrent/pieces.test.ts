import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PieceManager } from './pieces';
import { TorrentStorage } from './storage';
import { BLOCK_LENGTH } from './wire';
import type { Metainfo } from './metainfo';

const PIECE_LENGTH = 64 * 1024; // 4 blocks per piece

function fixture(): { meta: Metainfo; data: Buffer } {
  const fileA = randomBytes(PIECE_LENGTH + 1000);
  const fileB = randomBytes(PIECE_LENGTH + 5000);
  const data = Buffer.concat([fileA, fileB]);

  const hashes: Buffer[] = [];
  for (let off = 0; off < data.length; off += PIECE_LENGTH) {
    hashes.push(createHash('sha1').update(data.subarray(off, off + PIECE_LENGTH)).digest());
  }

  const infoHash = randomBytes(20);
  const meta: Metainfo = {
    infoHash,
    infoHashHex: infoHash.toString('hex'),
    name: 'fixture',
    pieceLength: PIECE_LENGTH,
    pieceHashes: hashes,
    totalLength: data.length,
    files: [
      { path: ['movie.mp4'], length: fileA.length, offset: 0 },
      { path: ['extras', 'trailer.mp4'], length: fileB.length, offset: fileA.length },
    ],
    announce: [],
    urlList: [],
    private: false,
    raw: {},
  };
  return { meta, data };
}

async function withStorage<T>(
  meta: Metainfo,
  fn: (storage: TorrentStorage, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'hypertube-test-'));
  const storage = new TorrentStorage(meta, dir);
  await storage.open();
  try {
    return await fn(storage, dir);
  } finally {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function deliverPiece(
  pieces: PieceManager,
  data: Buffer,
  meta: Metainfo,
  index: number,
): Promise<void> {
  const pieceLen = pieces.pieceLength(index);
  for (let begin = 0; begin < pieceLen; begin += BLOCK_LENGTH) {
    const length = Math.min(BLOCK_LENGTH, pieceLen - begin);
    const start = index * meta.pieceLength + begin;
    await pieces.addBlock(index, begin, data.subarray(start, start + length));
  }
}

test('storage: maps the flat address space onto multiple files', async () => {
  const { meta, data } = fixture();
  await withStorage(meta, async (storage) => {
    await storage.write(0, data);

    const movie = await readFile(join(storage.root, 'movie.mp4'));
    const trailer = await readFile(join(storage.root, 'extras', 'trailer.mp4'));

    assert.equal(movie.length, meta.files[0].length);
    assert.equal(trailer.length, meta.files[1].length);
    assert.ok(movie.equals(data.subarray(0, meta.files[0].length)));
    assert.ok(trailer.equals(data.subarray(meta.files[0].length)));

    // A read spanning the file boundary must stitch the two files back.
    const spanning = await storage.read(meta.files[0].length - 50, 100);
    assert.ok(spanning.equals(data.subarray(meta.files[0].length - 50, meta.files[0].length + 50)));
  });
});

test('storage: writes land at their offset, out of order, without growing the file', async () => {
  const { meta, data } = fixture();
  await withStorage(meta, async (storage) => {
    const chunk = 4096;
    const offsets: number[] = [];
    for (let off = 0; off < data.length; off += chunk) offsets.push(off);
    // Shuffle: pieces arrive from the swarm in whatever order peers serve them.
    offsets.sort(() => Math.random() - 0.5);

    for (const off of offsets) {
      await storage.write(off, data.subarray(off, Math.min(off + chunk, data.length)));
    }

    const movie = await readFile(join(storage.root, 'movie.mp4'));
    assert.equal(movie.length, meta.files[0].length);
    assert.ok(movie.equals(data.subarray(0, meta.files[0].length)));

    const head = await storage.read(0, 128);
    assert.ok(head.equals(data.subarray(0, 128)));
  });
});

test('storage: picks the biggest video file as the movie', async () => {
  const { meta } = fixture();
  await withStorage(meta, async (storage) => {
    const primary = storage.pickPrimaryVideoFile();
    assert.ok(primary);
    assert.equal(primary.path.join('/'), 'extras/trailer.mp4'); // the larger one
  });
});

test('storage: prefers a browser-native container over a bigger master', async () => {
  const { meta } = fixture();
  const mixed: Metainfo = {
    ...meta,
    files: [
      { path: ['master.mov'], length: 900_000_000, offset: 0, padding: false },
      { path: ['movie.mp4'], length: 64_000_000, offset: 900_000_000, padding: false },
      { path: ['poster.jpg'], length: 10_000, offset: 964_000_000, padding: false },
    ],
  };
  await withStorage(mixed, async (storage) => {
    assert.equal(storage.pickPrimaryVideoFile()?.path.join('/'), 'movie.mp4');
  });
});

test('storage: falls back to the biggest video when none is native', async () => {
  const { meta } = fixture();
  const mixed: Metainfo = {
    ...meta,
    files: [
      { path: ['small.avi'], length: 100_000, offset: 0, padding: false },
      { path: ['big.mkv'], length: 900_000, offset: 100_000, padding: false },
    ],
  };
  await withStorage(mixed, async (storage) => {
    assert.equal(storage.pickPrimaryVideoFile()?.path.join('/'), 'big.mkv');
  });
});

test('storage: rejects a torrent whose paths escape the root', async () => {
  const { meta } = fixture();
  const evil: Metainfo = {
    ...meta,
    files: [{ path: ['..', '..', 'etc', 'passwd'], length: 10, offset: 0, padding: false }],
  };
  const dir = await mkdtemp(join(tmpdir(), 'hypertube-test-'));
  try {
    assert.throws(() => new TorrentStorage(evil, dir), /escapes storage root/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pieces: verifies SHA-1 and persists a complete piece', async () => {
  const { meta, data } = fixture();
  await withStorage(meta, async (storage) => {
    const pieces = new PieceManager(meta, storage, 8);
    const seen: number[] = [];
    pieces.on('piece', (i) => seen.push(i));

    await deliverPiece(pieces, data, meta, 0);

    assert.deepEqual(seen, [0]);
    assert.equal(pieces.hasPiece(0), true);
    assert.equal(pieces.completed, 1);

    const written = await storage.read(0, meta.pieceLength);
    assert.ok(written.equals(data.subarray(0, meta.pieceLength)));
  });
});

test('pieces: a corrupt piece is dropped, not written', async () => {
  const { meta, data } = fixture();
  await withStorage(meta, async (storage) => {
    const pieces = new PieceManager(meta, storage, 8);
    let corrupt = -1;
    pieces.on('corrupt', (i) => {
      corrupt = i;
    });

    const pieceLen = pieces.pieceLength(0);
    for (let begin = 0; begin < pieceLen; begin += BLOCK_LENGTH) {
      const length = Math.min(BLOCK_LENGTH, pieceLen - begin);
      // Last block is garbage -> the SHA-1 check must fail.
      const block =
        begin + BLOCK_LENGTH >= pieceLen
          ? randomBytes(length)
          : data.subarray(begin, begin + length);
      await pieces.addBlock(0, begin, block);
    }

    assert.equal(corrupt, 0);
    assert.equal(pieces.hasPiece(0), false);
    assert.equal(pieces.completed, 0);
  });
});

test('pieces: rejects malformed blocks from a hostile peer', async () => {
  const { meta, data } = fixture();
  await withStorage(meta, async (storage) => {
    const pieces = new PieceManager(meta, storage, 8);
    // Unaligned begin, out-of-range index and wrong length are all refused.
    assert.equal(await pieces.addBlock(0, 7, data.subarray(0, 16)), false);
    assert.equal(await pieces.addBlock(9999, 0, data.subarray(0, BLOCK_LENGTH)), false);
    assert.equal(await pieces.addBlock(0, 0, data.subarray(0, 10)), false);
    assert.equal(pieces.completed, 0);
  });
});

test('picker: prioritises the read-ahead window after the playhead', async () => {
  const { meta } = fixture();
  await withStorage(meta, async (storage) => {
    const pieces = new PieceManager(meta, storage, 2);
    const all = () => true;

    // Playhead at the start: piece 0 first.
    pieces.setPlayhead(0);
    assert.equal(pieces.pick(all, 1)[0].index, 0);

    // Move the playhead into piece 2: the picker follows it instead of
    // restarting from the beginning of the file.
    const fresh = new PieceManager(meta, storage, 2);
    fresh.setPlayhead(2 * meta.pieceLength + 10);
    assert.equal(fresh.pick(all, 1)[0].index, 2);
  });
});

test('picker: never hands the same block to two peers outside endgame', async () => {
  const { meta } = fixture();
  await withStorage(meta, async (storage) => {
    const pieces = new PieceManager(meta, storage, 8);
    const first = pieces.pick(() => true, 4);
    const second = pieces.pick(() => true, 4);

    assert.equal(first.length, 4);
    const firstKeys = new Set(first.map((r) => `${r.index}:${r.begin}`));
    for (const req of second) {
      assert.equal(firstKeys.has(`${req.index}:${req.begin}`), false);
    }

    // Endgame is allowed to duplicate requests to beat a slow peer.
    const endgame = pieces.pick(() => true, 4, true);
    assert.ok(endgame.length > 0);
  });
});

test('picker: skips pieces the peer does not have', async () => {
  const { meta } = fixture();
  await withStorage(meta, async (storage) => {
    const pieces = new PieceManager(meta, storage, 8);
    const picks = pieces.pick((i) => i === 2, 8);
    assert.ok(picks.length > 0);
    assert.ok(picks.every((p) => p.index === 2));
  });
});

test('pieces: releaseRequests lets the blocks of a dropped peer be re-picked', async () => {
  const { meta } = fixture();
  await withStorage(meta, async (storage) => {
    const pieces = new PieceManager(meta, storage, 8);
    const taken = pieces.pick(() => true, 2);
    assert.equal(pieces.pick(() => true, 2).some((r) => r.begin === taken[0].begin), false);

    pieces.releaseRequests(taken);
    const again = pieces.pick(() => true, 2);
    assert.ok(again.some((r) => r.index === taken[0].index && r.begin === taken[0].begin));
  });
});

test('picker: a pinned range outranks the read-ahead window', async () => {
  const { meta } = fixture();
  await withStorage(meta, async (storage) => {
    const pieces = new PieceManager(meta, storage, 8);
    pieces.setPlayhead(0);
    assert.equal(pieces.pick(() => true, 1)[0].index, 0);

    const fresh = new PieceManager(meta, storage, 8);
    fresh.setPlayhead(0);
    fresh.pin(2, 2);
    assert.equal(fresh.pick(() => true, 1)[0].index, 2);
  });
});

test('pieces: verifyExisting recognises an already downloaded file', async () => {
  const { meta, data } = fixture();
  await withStorage(meta, async (storage) => {
    await storage.write(0, data);
    const pieces = new PieceManager(meta, storage, 8);
    await pieces.verifyExisting();
    assert.equal(pieces.completed, meta.pieceHashes.length);
    assert.equal(pieces.isComplete, true);
  });
});

test('pieces: hasRange answers the streaming readiness question', async () => {
  const { meta, data } = fixture();
  await withStorage(meta, async (storage) => {
    const pieces = new PieceManager(meta, storage, 8);
    assert.equal(pieces.hasRange(0, 0), false);
    await deliverPiece(pieces, data, meta, 0);
    assert.equal(pieces.hasRange(0, 0), true);
    assert.equal(pieces.hasRange(0, 1), false);
  });
});

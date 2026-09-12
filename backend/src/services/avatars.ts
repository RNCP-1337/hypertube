import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { config } from '../config';
import { query } from '../db/pool';
import { fetchBuffer } from '../lib/http';
import { normaliseImage } from './transcode';

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

const MAGIC: Array<{ type: string; test: (b: Buffer) => boolean }> = [
  { type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/png',
    test: (b) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  { type: 'image/gif', test: (b) => b.subarray(0, 6).toString('ascii').startsWith('GIF8') },
  {
    type: 'image/webp',
    test: (b) =>
      b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    type: 'image/bmp',
    test: (b) => b[0] === 0x42 && b[1] === 0x4d,
  },
];

export function detectImageType(buffer: Buffer): string | null {
  if (buffer.length < 16) return null;
  return MAGIC.find((m) => m.test(buffer))?.type ?? null;
}

export class InvalidImageError extends Error {}

async function writeAvatar(userId: number, buffer: Buffer): Promise<string> {
  if (buffer.length > MAX_AVATAR_BYTES) {
    throw new InvalidImageError('image is larger than 5 MB');
  }
  if (!detectImageType(buffer)) {
    throw new InvalidImageError('this file is not a JPEG, PNG, GIF, WebP or BMP image');
  }

  await fs.mkdir(config.AVATAR_DIR, { recursive: true });

  const stamp = `${userId}-${randomBytes(12).toString('hex')}`;
  const tempPath = join(config.AVATAR_DIR, `.tmp-${stamp}`);
  const finalName = `${stamp}.jpg`;
  const finalPath = join(config.AVATAR_DIR, finalName);

  await fs.writeFile(tempPath, buffer, { mode: 0o600 });
  try {
    // The re-encode is the actual sanitiser: it fails on anything non-image.
    const ok = await normaliseImage(tempPath, finalPath);
    if (!ok) throw new InvalidImageError('this image could not be processed');
  } finally {
    await fs.rm(tempPath, { force: true });
  }

  // Drop the previous file so old avatars do not pile up on disk.
  const previous = await query<{ avatar_path: string | null }>(
    'SELECT avatar_path FROM users WHERE id = $1',
    [userId],
  );
  const old = previous[0]?.avatar_path;

  await query('UPDATE users SET avatar_path = $2 WHERE id = $1', [userId, finalName]);

  if (old && old !== finalName && /^[A-Za-z0-9_.-]+$/.test(old)) {
    await fs.rm(join(config.AVATAR_DIR, basename(old)), { force: true }).catch(() => undefined);
  }

  return finalName;
}

export function storeAvatar(userId: number, buffer: Buffer): Promise<string> {
  return writeAvatar(userId, buffer);
}

export async function storeAvatarFromUrl(userId: number, url: string): Promise<string> {
  const buffer = await fetchBuffer(url, { maxBytes: MAX_AVATAR_BYTES, timeoutMs: 10_000 });
  return writeAvatar(userId, buffer);
}

export function avatarPath(fileName: string): string | null {
  // traversal attempt must never reach the filesystem.
  if (!/^[A-Za-z0-9_-]+\.jpg$/.test(fileName)) return null;
  return join(config.AVATAR_DIR, fileName);
}

export function avatarUrl(fileName: string | null): string | null {
  return fileName ? `/api/users/avatar/${encodeURIComponent(fileName)}` : null;
}

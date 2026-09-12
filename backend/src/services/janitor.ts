import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config';
import { query } from '../db/pool';
import { torrentEngine } from '../torrent/engine';

const RUN_INTERVAL_MS = 60 * 60 * 1000; // hourly

let timer: NodeJS.Timeout | null = null;

export async function purgeStaleDownloads(): Promise<number> {
  const stale = await query<{ info_hash: string }>(
    `SELECT info_hash
       FROM downloads
      WHERE status <> 'removed'
        AND last_accessed_at < now() - ($1 || ' days')::interval`,
    [String(config.MEDIA_RETENTION_DAYS)],
  );

  for (const row of stale) {
    try {
      await torrentEngine.remove(row.info_hash, true);
      console.log(`[janitor] removed ${row.info_hash} (unwatched for ${config.MEDIA_RETENTION_DAYS} days)`);
    } catch (err) {
      console.warn(`[janitor] failed to remove ${row.info_hash}: ${(err as Error).message}`);
    }
  }
  return stale.length;
}

export async function purgeOrphanDirectories(): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(config.MEDIA_DIR);
  } catch {
    return 0;
  }

  const known = new Set(
    (
      await query<{ info_hash: string }>(
        `SELECT info_hash FROM downloads WHERE status <> 'removed'`,
      )
    ).map((r) => r.info_hash),
  );

  let removed = 0;
  for (const entry of entries) {
    // Directory names are info-hashes; anything else is not ours to delete.
    if (!/^[0-9a-f]{40}$/.test(entry)) continue;
    if (known.has(entry)) continue;
    await fs.rm(join(config.MEDIA_DIR, entry), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export async function purgeExpiredTokens(): Promise<void> {
  await query(
    `DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days'`,
  ).catch(() => undefined);
  await query(
    `DELETE FROM password_resets WHERE expires_at < now() - interval '7 days'`,
  ).catch(() => undefined);
  await query(
    `DELETE FROM oauth_authorization_codes WHERE expires_at < now() - interval '1 day'`,
  ).catch(() => undefined);
}

export async function runJanitor(): Promise<void> {
  try {
    const purged = await purgeStaleDownloads();
    const orphans = await purgeOrphanDirectories();
    await purgeExpiredTokens();
    if (purged > 0 || orphans > 0) {
      console.log(`[janitor] ${purged} expired download(s), ${orphans} orphan director(ies)`);
    }
  } catch (err) {
    console.error(`[janitor] run failed: ${(err as Error).message}`);
  }
}

export function startJanitor(): void {
  if (timer) return;
  // First pass shortly after boot, then hourly.
  setTimeout(() => void runJanitor(), 30_000).unref();
  timer = setInterval(() => void runJanitor(), RUN_INTERVAL_MS);
  timer.unref();
}

export function stopJanitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, waitForDatabase } from './pool';
import { config } from '../config';
import { hashPassword } from '../lib/password';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function seedApiClient(): Promise<void> {
  const secretHash = await hashPassword(config.API_CLIENT_SECRET);
  await pool.query(
    `INSERT INTO oauth_clients (client_id, client_secret, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (client_id) DO UPDATE SET client_secret = EXCLUDED.client_secret`,
    [config.API_CLIENT_ID, secretHash, 'Hypertube default API client'],
  );
}

export async function runMigrations(): Promise<void> {
  await waitForDatabase();
  await ensureMigrationsTable();

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(file);

    if (previous) {
      if (previous !== checksum) {
        console.warn(
          `[migrate] ${file} changed after being applied - create a new migration instead.`,
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        [file, checksum],
      );
      await client.query('COMMIT');
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  await seedApiClient();
  console.log('[migrate] database up to date');
}

if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate]', err);
      process.exit(1);
    });
}

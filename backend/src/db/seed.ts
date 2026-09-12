import { closePool, query, queryOne } from './pool';
import { runMigrations } from './migrate';
import { createUser, ConflictError } from '../services/auth';
import { ingest, enrich } from '../services/catalog';
import { popularFromSources } from '../services/sources';

const DEMO_USERS = [
  {
    username: 'norminet',
    email: 'norminet@hypertube.local',
    firstName: 'Nor',
    lastName: 'Minet',
    password: 'Hypertube42!',
    language: 'en',
  },
  {
    username: 'bocal',
    email: 'bocal@hypertube.local',
    firstName: 'Le',
    lastName: 'Bocal',
    password: 'Hypertube42!',
    language: 'fr',
  },
];

const DEMO_COMMENTS = [
  'Great print for a public-domain release, the streaming started almost instantly.',
  'Watched this on my phone during the commute - the subtitles were spot on.',
  'A classic. The transcoding handled the mkv without a hitch.',
];

async function seedUsers(): Promise<number[]> {
  const ids: number[] = [];
  for (const demo of DEMO_USERS) {
    try {
      const user = await createUser(demo);
      ids.push(user.id);
      console.log(`[seed] created user ${user.username} (password: ${demo.password})`);
    } catch (err) {
      if (err instanceof ConflictError) {
        const existing = await queryOne<{ id: string }>(
          'SELECT id FROM users WHERE username = $1',
          [demo.username],
        );
        if (existing) {
          ids.push(Number(existing.id));
          console.log(`[seed] user ${demo.username} already exists`);
        }
      } else {
        throw err;
      }
    }
  }
  return ids;
}

async function seedMovies(): Promise<number[]> {
  console.log('[seed] fetching the first page from the external sources...');
  const movies = await popularFromSources({ page: 1, perPage: 20 });
  const ids = await ingest(movies);
  console.log(`[seed] ingested ${ids.length} movie(s)`);
  await enrich(ids);
  return ids;
}

async function seedComments(userIds: number[], movieIds: number[]): Promise<void> {
  if (userIds.length === 0 || movieIds.length === 0) return;

  const existing = await queryOne<{ count: string }>('SELECT count(*) FROM comments');
  if (existing && Number(existing.count) > 0) {
    console.log('[seed] comments already present, skipping');
    return;
  }

  for (let i = 0; i < DEMO_COMMENTS.length && i < movieIds.length; i += 1) {
    await query('INSERT INTO comments (movie_id, user_id, content) VALUES ($1, $2, $3)', [
      movieIds[i],
      userIds[i % userIds.length],
      DEMO_COMMENTS[i],
    ]);
  }
  console.log(`[seed] added ${Math.min(DEMO_COMMENTS.length, movieIds.length)} comment(s)`);
}

async function main(): Promise<void> {
  await runMigrations();
  const userIds = await seedUsers();
  const movieIds = await seedMovies();
  await seedComments(userIds, movieIds);
  console.log('[seed] done');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[seed] failed:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });

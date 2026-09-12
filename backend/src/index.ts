import { buildApp } from './app';
import { config } from './config';
import { closePool, waitForDatabase } from './db/pool';
import { runMigrations } from './db/migrate';
import { startJanitor, stopJanitor } from './services/janitor';
import { torrentEngine } from './torrent/engine';

async function main(): Promise<void> {
  console.log(`[boot] Hypertube starting in ${config.NODE_ENV} mode`);

  await waitForDatabase();
  await runMigrations();
  await torrentEngine.init();

  const app = await buildApp();

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  console.log(`[boot] API listening on :${config.PORT} (public URL ${config.PUBLIC_URL})`);

  startJanitor();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, closing gracefully`);

    stopJanitor();
    // Stop accepting requests first, then tear the swarm down.
    await app.close().catch((err) => console.error('[shutdown] http:', err));
    await torrentEngine.shutdown().catch((err) => console.error('[shutdown] torrents:', err));
    await closePool().catch((err) => console.error('[shutdown] database:', err));

    console.log('[shutdown] bye');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A crash must be loud and fatal rather than leaving a half-dead process.
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaught exception:', err);
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  console.error('[boot] failed to start:', err);
  process.exit(1);
});

import { createApp } from './src/app.ts';
import { env } from './src/config/env.ts';
import { closeDb, db } from './src/db/driver.ts';
import { runMigrations } from './src/db/migrations.ts';
import { seedDemoData } from './src/db/seed.ts';

async function bootstrap() {
  console.log(`[boot] starting in ${env.nodeEnv} mode`);

  // Schema work happens before the server accepts traffic, so no request can
  // ever hit a half-migrated database.
  await runMigrations();

  if (env.usePglite && env.seedLocal) {
    await seedDemoData();
  }

  if (!env.apiKey) {
    console.warn(
      '[security] API_KEY is not set — every endpoint is publicly writable. ' +
        'Set API_KEY (and PROTECT_READS=true) to require a token.'
    );
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`[boot] listening on http://localhost:${env.port} (driver: ${db().kind})`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[boot] ${signal} received, shutting down`);
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    // Do not hang forever if a connection refuses to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  console.error('[boot] failed to start:', error);
  process.exit(1);
});

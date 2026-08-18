import { createApp } from './src/app.ts';
import { ensureReady } from './src/boot.ts';
import { env } from './src/config/env.ts';
import { closeDb } from './src/db/driver.ts';

// The app is created at module load so a serverless platform can import it
// directly. Everything that touches the database happens lazily, on the first
// request, through the ensureReady() middleware inside createApp().
const app = createApp();

// Only a long-lived process opens a port; on Vercel the platform owns the
// server and just invokes the exported handler.
if (!env.isServerless) {
  ensureReady()
    .then(() => {
      const server = app.listen(env.port, () => {
        console.log(`[boot] listening on http://localhost:${env.port}`);
      });

      const shutdown = async (signal: string) => {
        console.log(`[boot] ${signal} received, shutting down`);
        server.close(async () => {
          await closeDb();
          process.exit(0);
        });
        setTimeout(() => process.exit(1), 10_000).unref();
      };

      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      process.on('SIGINT', () => void shutdown('SIGINT'));
    })
    .catch((error) => {
      console.error('[boot] failed to start:', error);
      process.exit(1);
    });
}

export default app;

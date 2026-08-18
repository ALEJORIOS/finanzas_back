import { createApp } from './src/app.ts';
import { env } from './src/config/env.ts';
import { closeDb, db } from './src/db/driver.ts';
import { runMigrations } from './src/db/migrations.ts';
import { seedDemoData } from './src/db/seed.ts';

// 1. Instanciar la app fuera de bootstrap para exportarla
const app = createApp();

let isInitialized = false;

// 2. Función de inicialización asíncrona (migraciones y semillas)
async function init() {
  if (isInitialized) return;

  console.log(`[boot] starting in ${env.nodeEnv} mode`);

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

  isInitialized = true;
}

// 3. Ejecución local tradicional (solo fuera de producción/Vercel)
if (process.env.VERCEL !== '1') {
  init()
    .then(() => {
      const server = app.listen(env.port, () => {
        console.log(
          `[boot] listening on http://localhost:${env.port} (driver: ${db().kind})`
        );
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
} else {
  // En Vercel, se inicializan la base de datos y migraciones en la primera petición
  app.use(async (_req, _res, next) => {
    try {
      await init();
      next();
    } catch (err) {
      next(err);
    }
  });
}

// 4. Exportar la instancia de la aplicación
export default app;
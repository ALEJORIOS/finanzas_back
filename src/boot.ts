import { env } from './config/env.ts';
import { runMigrations } from './db/migrations.ts';
import { loadSchemaInfo } from './db/schema.ts';

/**
 * One-time startup work: introspect the schema (the repositories need it before
 * building any SQL) and, when enabled, apply the migrations.
 *
 * It is a lazy promise rather than a bootstrap call so the same code path works
 * for a long-lived server and for a serverless instance, where the first
 * request is what wakes the process up.
 */
let ready: Promise<void> | null = null;

async function boot(): Promise<void> {
  console.log(`[boot] starting in ${env.nodeEnv} mode`);

  if (env.runMigrations) {
    // runMigrations() reloads the schema info itself once the DDL is applied.
    await runMigrations();
  } else {
    await loadSchemaInfo(true);
  }

  if (!env.apiKey) {
    console.warn(
      '[security] API_KEY is not set — every endpoint is publicly writable. ' +
        'Set API_KEY (and PROTECT_READS=true) to require a token.'
    );
  }
}

export function ensureReady(): Promise<void> {
  if (!ready) {
    ready = boot().catch((error) => {
      // Don't cache a failed boot: a transient database hiccup would otherwise
      // poison every later request served by the same instance.
      ready = null;
      throw error;
    });
  }
  return ready;
}

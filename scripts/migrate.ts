/**
 * Applies the schema migrations once, then exits.
 *
 * Migrations no longer run automatically on a serverless deployment (see
 * RUN_MIGRATIONS in src/config/env.ts), so this is how a schema change reaches
 * the production database:
 *
 *   DATABASE_URL=<production url> bun run migrate
 *
 * Every statement is idempotent, so running it twice is a no-op.
 */

import { closeDb } from '../src/db/driver.ts';
import { runMigrations } from '../src/db/migrations.ts';

try {
  await runMigrations();
  console.log('[migrate] done');
} catch (error) {
  console.error('[migrate] failed:', error);
  process.exitCode = 1;
} finally {
  await closeDb();
}

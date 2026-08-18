/**
 * OPTIONAL migration: `record.value` from `money` to `numeric(16,2)`.
 *
 * Postgres' `money` type is locale-dependent — the same row formats
 * differently depending on the server's `lc_monetary`, and the driver returns
 * it as a pre-formatted string. `numeric` is the correct type for currency.
 *
 * The application works correctly either way (see src/db/schema.ts), so this
 * is entirely opt-in. Nothing runs it automatically.
 *
 * Usage:
 *   node scripts/migrate-money-to-numeric.ts --dry-run   # inspect only
 *   node scripts/migrate-money-to-numeric.ts --apply     # perform the change
 *
 * Take a database backup first.
 */

import { closeDb, db } from '../src/db/driver.ts';
import { env } from '../src/config/env.ts';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');

async function main() {
  if (!apply) {
    console.log('DRY RUN — pass --apply to perform the migration.\n');
  }

  console.log(`Target: ${env.usePglite ? 'PGlite (local)' : 'DATABASE_URL'}\n`);

  const { rows: columns } = await db().query<{ udt_name: string }>(
    `SELECT udt_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'record' AND column_name = 'value'`
  );

  if (!columns.length) {
    console.error('Could not find record.value — aborting.');
    process.exitCode = 1;
    return;
  }

  const current = columns[0]!.udt_name;
  console.log(`Current type: ${current}`);

  if (current !== 'money') {
    console.log('Nothing to do: the column is already not `money`.');
    return;
  }

  const { rows: stats } = await db().query(
    `SELECT COUNT(*)::int AS total,
            MIN(value::numeric) AS min,
            MAX(value::numeric) AS max,
            SUM(value::numeric) AS sum
       FROM "record"`
  );
  console.log('Rows:', stats[0]);

  if (!apply) {
    console.log('\nWould run:');
    console.log('  ALTER TABLE "record" ALTER COLUMN value TYPE NUMERIC(16,2) USING value::numeric;');
    return;
  }

  // Checksum before and after guarantees no value was altered by the cast.
  const before = String(stats[0].sum);

  await db().transaction(async (tx) => {
    await tx.query(
      `ALTER TABLE "record" ALTER COLUMN value TYPE NUMERIC(16,2) USING value::numeric`
    );

    const { rows: after } = await tx.query(`SELECT SUM(value)::text AS sum FROM "record"`);
    if (Number(after[0].sum) !== Number(before)) {
      throw new Error(
        `Checksum mismatch: ${before} before vs ${after[0].sum} after. Rolling back.`
      );
    }
    console.log(`Checksum verified: ${before}`);
  });

  console.log('\nDone. record.value is now NUMERIC(16,2).');
  console.log('Restart the API so it re-reads the column type.');
}

main()
  .catch((error) => {
    console.error('Migration failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

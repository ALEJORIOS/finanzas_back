import { db } from './driver.ts';
import { loadSchemaInfo } from './schema.ts';

/**
 * Every statement here is idempotent and additive. Nothing drops, retypes or
 * rewrites the existing `record` table, so running this against the production
 * database with its 1000+ live rows is a no-op beyond adding new columns,
 * indexes and lookup tables.
 *
 * Categories deliberately join to records *by name* rather than by foreign key.
 * That means existing rows light up with colours and icons immediately, and
 * deleting a category can never orphan a record.
 */

const DEFAULT_CATEGORY_COLORS: Record<string, string> = {
  'Admin Apt': '#6366f1',
  Apartment: '#6366f1',
  Beauty: '#ec4899',
  Church: '#8b5cf6',
  Classes: '#0ea5e9',
  Cleaning: '#14b8a6',
  Clothes: '#f43f5e',
  Dreamland: '#a855f7',
  Education: '#0ea5e9',
  'Emergencies Fund': '#10b981',
  Entertainment: '#f59e0b',
  Fam: '#f97316',
  Food: '#22c55e',
  Gift: '#ec4899',
  Health: '#ef4444',
  Home: '#6366f1',
  Lease: '#64748b',
  Mobile: '#3b82f6',
  Other: '#94a3b8',
  Pet: '#d97706',
  'Public Services': '#0891b2',
  Restaurants: '#fb923c',
  Taxes: '#dc2626',
  Tech: '#2563eb',
  Tithe: '#8b5cf6',
  Transportation: '#eab308',
  Travel: '#06b6d4',
  Wage: '#16a34a',
};

const DEFAULT_CATEGORY_ICONS: Record<string, string> = {
  'Admin Apt': 'building',
  Apartment: 'building',
  Beauty: 'sparkles',
  Church: 'heart',
  Classes: 'academic',
  Cleaning: 'sparkles',
  Clothes: 'shirt',
  Dreamland: 'moon',
  Education: 'academic',
  'Emergencies Fund': 'shield',
  Entertainment: 'film',
  Fam: 'users',
  Food: 'shopping-cart',
  Gift: 'gift',
  Health: 'heart-pulse',
  Home: 'home',
  Lease: 'key',
  Mobile: 'device-phone',
  Other: 'dots',
  Pet: 'paw',
  'Public Services': 'bolt',
  Restaurants: 'utensils',
  Taxes: 'receipt',
  Tech: 'cpu',
  Tithe: 'heart',
  Transportation: 'car',
  Travel: 'plane',
  Wage: 'banknotes',
};

/** Categories that are income by nature, so the UI can default correctly. */
const INCOME_CATEGORIES = new Set(['Wage', 'Emergencies Fund']);

const PALETTE = [
  '#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4',
  '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#3b82f6',
];

function colorFor(name: string): string {
  if (DEFAULT_CATEGORY_COLORS[name]) return DEFAULT_CATEGORY_COLORS[name]!;
  // Deterministic fallback so a category keeps its colour between runs.
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}

export async function runMigrations(): Promise<void> {
  const driver = db();

  // 1. Base table. Only creates anything on a fresh (local) database; the
  //    production table already exists and is left exactly as it is.
  //    `value` is intentionally `money` here so local runs exercise the same
  //    code path production takes.
  await driver.query(`
    CREATE TABLE IF NOT EXISTS "record" (
      id          SERIAL PRIMARY KEY,
      date        TIMESTAMP NOT NULL,
      concept     TEXT NOT NULL,
      category    TEXT NOT NULL,
      description TEXT,
      value       MONEY NOT NULL,
      create_time TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // 2. Additive columns on the existing table. Every one is nullable or has a
  //    default, so the existing rows stay valid and untouched.
  await driver.query(`ALTER TABLE "record" ADD COLUMN IF NOT EXISTS account_id INTEGER`);
  await driver.query(`ALTER TABLE "record" ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP`);
  // `pending` marks a planned/unpaid movement. It is excluded from realised
  // totals and surfaced separately, so historical rows (all FALSE) behave
  // exactly as they did before.
  await driver.query(
    `ALTER TABLE "record" ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT FALSE`
  );

  // 3. Lookup + planning tables.
  await driver.query(`
    CREATE TABLE IF NOT EXISTS "category" (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'outcome',
      color       TEXT NOT NULL DEFAULT '#6366f1',
      icon        TEXT NOT NULL DEFAULT 'dots',
      archived    BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await driver.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS category_name_key ON "category" (LOWER(name))`
  );

  await driver.query(`
    CREATE TABLE IF NOT EXISTS "account" (
      id              SERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      kind            TEXT NOT NULL DEFAULT 'cash',
      color           TEXT NOT NULL DEFAULT '#6366f1',
      icon            TEXT NOT NULL DEFAULT 'wallet',
      opening_balance NUMERIC(16,2) NOT NULL DEFAULT 0,
      archived        BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await driver.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS account_name_key ON "account" (LOWER(name))`
  );

  await driver.query(`
    CREATE TABLE IF NOT EXISTS "budget" (
      id              SERIAL PRIMARY KEY,
      category        TEXT,
      amount          NUMERIC(16,2) NOT NULL,
      period          TEXT NOT NULL DEFAULT 'monthly',
      start_date      DATE NOT NULL,
      end_date        DATE,
      alert_threshold INTEGER NOT NULL DEFAULT 80,
      active          BOOLEAN NOT NULL DEFAULT TRUE,
      note            TEXT,
      created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  // At most one active budget per category+period. NULL category = global budget.
  await driver.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS budget_active_key
      ON "budget" (COALESCE(LOWER(category), '*'), period)
      WHERE active
  `);

  // 4. Indexes that matter for the list + analytics queries.
  await driver.query(`CREATE INDEX IF NOT EXISTS record_date_idx ON "record" (date DESC)`);
  await driver.query(`CREATE INDEX IF NOT EXISTS record_category_idx ON "record" (category)`);
  await driver.query(`CREATE INDEX IF NOT EXISTS record_concept_idx ON "record" (concept)`);
  await driver.query(
    `CREATE INDEX IF NOT EXISTS record_date_concept_idx ON "record" (date DESC, concept)`
  );
  await driver.query(
    `CREATE INDEX IF NOT EXISTS record_pending_idx ON "record" (pending) WHERE pending`
  );

  await loadSchemaInfo(true);
  await seedCategoriesFromRecords();
}

/**
 * Backfills the category table from whatever categories the existing records
 * already use, so nothing has to be re-entered by hand. Safe to run repeatedly:
 * existing rows are never modified.
 */
export async function seedCategoriesFromRecords(): Promise<number> {
  const driver = db();

  const { rows: existing } = await driver.query<{ name: string }>(
    `SELECT name FROM "category"`
  );
  const known = new Set(existing.map((row) => row.name.toLowerCase()));

  const { rows: used } = await driver.query<{ category: string; kind: string }>(`
    SELECT category,
           CASE WHEN SUM(CASE WHEN UPPER(concept) = 'INCOME' THEN 1 ELSE 0 END) >
                     SUM(CASE WHEN UPPER(concept) = 'INCOME' THEN 0 ELSE 1 END)
                THEN 'income' ELSE 'outcome' END AS kind
      FROM "record"
     WHERE category IS NOT NULL AND category <> ''
     GROUP BY category
  `);

  // Always make sure the original hard-coded list exists, even on an empty database.
  const seedNames = new Set<string>([
    ...Object.keys(DEFAULT_CATEGORY_COLORS),
    ...used.map((row) => row.category),
  ]);
  const kindByName = new Map(used.map((row) => [row.category, row.kind]));

  let inserted = 0;
  for (const name of seedNames) {
    if (known.has(name.toLowerCase())) continue;
    const kind = kindByName.get(name) ?? (INCOME_CATEGORIES.has(name) ? 'income' : 'outcome');
    await driver.query(
      `INSERT INTO "category" (name, kind, color, icon)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [name, kind, colorFor(name), DEFAULT_CATEGORY_ICONS[name] ?? 'dots']
    );
    inserted += 1;
  }

  if (inserted > 0) {
    console.log(`[db] seeded ${inserted} categories from existing records`);
  }
  return inserted;
}

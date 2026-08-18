# Finanzas — API

REST API for the personal-finance app: movements, categories, accounts, budgets,
analytics and report exports (PDF / Excel / CSV).

## Running

```bash
bun install

# Local development — no database setup needed.
# With no DATABASE_URL the API boots an embedded Postgres (PGlite) into
# ./.data/pglite and seeds ~460 demo records so every screen has data.
bun run start          # or: bun run dev  (watch mode)

# Against the real database
DATABASE_URL=postgres://… bun run start
```

Runs on both Bun and Node (`bun run start:node`). One caveat: PGlite's
**in-memory** mode (`PGLITE_DIR=memory`) fails under Bun, so keep the default
on-disk directory there — or use Node if you want a throwaway database.

To start over from a clean database, delete the folder:

```bash
rm -rf .data          # PowerShell: Remove-Item -Recurse -Force .data
```

Verify a running instance end to end:

```bash
BASE_URL=http://localhost:3210 npm run smoke   # 130 assertions
npm run typecheck
```

## Configuration

Everything is optional except `DATABASE_URL` in production.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string. Absent ⇒ local PGlite. |
| `PORT` | `3210` | HTTP port. |
| `API_KEY` | — | **Unset ⇒ the API is fully public.** When set, mutations require `Authorization: Bearer <key>` or `X-API-Key`. |
| `PROTECT_READS` | `false` | Also require the key on `GET`. |
| `CORS_ORIGINS` | *(any)* | Comma-separated allowlist. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `300` / `60000` | In-process rate limit. |
| `CURRENCY` / `LOCALE` | `COP` / `es-CO` | Formatting in generated reports. |
| `PG_POOL_MAX` | `10` | Connection pool size. |
| `SEED_LOCAL` | `true` | Seed demo data on an empty local database. |

### Security

With no `API_KEY` the API is readable **and writable** by anyone who knows the
URL — which is how it was originally deployed. The server logs a warning at boot
in that state. To lock it down:

```bash
API_KEY=<a long random string>
PROTECT_READS=true
```

## The `record.value` column

The production table stores `value` as Postgres `money`. That type is
locale-dependent and the driver returns it as a formatted string (`"$50,314.00"`),
which is why the old frontend stripped it with a regex.

`src/db/schema.ts` **introspects the column at boot** and builds the right SQL
either way — `money::numeric` on read, `::numeric::money` on write — so the API
always deals in plain numbers and works before *or* after a type change.

Converting to `numeric(16,2)` is recommended but entirely opt-in:

```bash
node scripts/migrate-money-to-numeric.ts --dry-run   # inspect
node scripts/migrate-money-to-numeric.ts --apply     # convert (verifies a checksum)
```

Take a backup first. Nothing runs it automatically.

## Schema

Migrations run automatically at boot and are **idempotent and additive** — no
column is dropped or retyped, so pointing this at the existing production
database only adds what is missing.

- `record` — unchanged, plus `account_id`, `updated_at`, `pending`.
- `category` — name, kind, colour, icon, archived. Joined to records **by name**,
  not by foreign key, so existing rows work immediately and deleting a category
  can never orphan a record.
- `account` — payment methods with an opening balance.
- `budget` — limit per category and period, with an alert threshold.

Categories are seeded from the `DISTINCT category` values already present in
`record`, so nothing has to be re-entered.

### `pending`

A movement marked `pending` is planned but not yet settled. It is excluded from
balances, analytics and budget consumption, and reported separately. Existing
rows default to `FALSE`, so historical behaviour is unchanged.

## Endpoints

Legacy routes are preserved verbatim so an already-installed PWA keeps working:

| Method | Path | Notes |
|---|---|---|
| `GET` | `/record` | Original shape, incl. `value` as a money string. Now also returns `id`. |
| `POST` | `/insert` | Original contract. |
| `GET` | `/download` | Excel export. |

Current API:

| Method | Path |
|---|---|
| `GET` | `/health` |
| `GET` `POST` | `/api/v1/records` — search, filters, sort, pagination, totals |
| `GET` `PATCH` `DELETE` | `/api/v1/records/:id` |
| `GET` | `/api/v1/records/duplicates` |
| `POST` | `/api/v1/records/bulk-delete` |
| `GET` `POST` `PATCH` `DELETE` | `/api/v1/categories` |
| `GET` `POST` `PATCH` `DELETE` | `/api/v1/accounts` |
| `GET` `POST` `PATCH` `DELETE` | `/api/v1/budgets` — includes live progress |
| `GET` | `/api/v1/analytics/overview` — the whole dashboard in one request |
| `GET` | `/api/v1/analytics/{monthly,daily,by-category,cash-flow}` |
| `GET` | `/api/v1/reports/export?type=…&format=pdf\|xlsx\|csv\|json` |

Errors are always `{ error: { code, message, details? } }`. Internal faults never
leak — they are logged with a request id that the response echoes back.

## Layout

```
index.ts              bootstrap: migrate → seed → listen
src/
  config/env.ts       validated configuration
  db/                 driver (pg | PGlite), introspection, migrations, seed
  lib/                errors, money parsing, date/period maths, zod schemas
  middleware/         request id, logging, auth, rate limit, error handler
  repositories/       all SQL — records, categories, accounts, budgets, analytics
  routes/             HTTP layer (thin), plus legacy.ts
  services/           excel, pdf, csv generation
scripts/              smoke.ts, migrate-money-to-numeric.ts
```

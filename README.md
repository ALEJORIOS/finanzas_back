# Finanzas — API

REST API for the personal-finance app: movements, categories, accounts, budgets,
analytics and report exports (PDF / Excel / CSV).

## Running

The API always talks to a real Postgres database — there is no embedded or
on-disk fallback, so it runs unchanged on a serverless platform.

```bash
bun install

# DATABASE_URL is required; put it in .env for local runs.
DATABASE_URL=postgres://… bun run start     # or: bun run dev  (watch mode)
```

Runs on both Bun and Node (`bun run start:node`).

Verify a running instance end to end:

```bash
BASE_URL=http://localhost:3210 bun run smoke   # 130 assertions
bun run typecheck
```

## Deploying to Vercel

`vercel.json` serves every route from `index.ts`, which exports the Express app
instead of listening on a port. Two things to know:

- Set `DATABASE_URL` in the project's environment variables. Booting without it
  fails immediately with a clear message.
- Migrations do **not** run on a deployment (see `RUN_MIGRATIONS` below). After a
  schema change, apply them once from your machine:
  `DATABASE_URL=<production url> bun run migrate`.

## Configuration

`DATABASE_URL` is required; everything else is optional.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | **Required.** Postgres connection string. |
| `PORT` | `3210` | HTTP port (ignored on Vercel). |
| `RUN_MIGRATIONS` | `true` locally, `false` on Vercel | Apply migrations at boot. Off in serverless so a cold start stays fast and concurrent instances don't race the same DDL. |
| `API_KEY` | — | **Unset ⇒ the API is fully public.** When set, mutations require `Authorization: Bearer <key>` or `X-API-Key`. |
| `PROTECT_READS` | `false` | Also require the key on `GET`. |
| `CORS_ORIGINS` | *(any)* | Comma-separated allowlist. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `300` / `60000` | In-process rate limit. |
| `CURRENCY` / `LOCALE` | `COP` / `es-CO` | Formatting in generated reports. |
| `PG_POOL_MAX` | `10` (`1` on Vercel) | Connection pool size. One connection per serverless instance keeps the database from running out. |

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
bun run migrate:money -- --dry-run   # inspect
bun run migrate:money -- --apply     # convert (verifies a checksum)
```

Take a backup first. Nothing runs it automatically.

## Schema

Migrations are **idempotent and additive** — no column is dropped or retyped, so
pointing this at the existing production database only adds what is missing.
They run at boot locally and on demand (`bun run migrate`) everywhere else.

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
index.ts              exports the Express app; listens only outside serverless
src/
  boot.ts             one-time init (schema introspection, optional migrations)
  config/env.ts       validated configuration
  db/                 pg driver, introspection, migrations
  lib/                errors, money parsing, date/period maths, zod schemas
  middleware/         request id, logging, auth, rate limit, error handler
  repositories/       all SQL — records, categories, accounts, budgets, analytics
  routes/             HTTP layer (thin), plus legacy.ts
  services/           excel, pdf, csv generation
scripts/              smoke.ts, migrate.ts, migrate-money-to-numeric.ts
```

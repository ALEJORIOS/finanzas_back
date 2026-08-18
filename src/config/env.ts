import dotenv from 'dotenv';

dotenv.config();

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value: string | undefined): string[] { 
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const databaseUrl = process.env.DATABASE_URL?.trim() || '';

/**
 * When no DATABASE_URL is provided we fall back to PGlite (Postgres compiled to
 * WASM). That keeps `bun run dev` working with zero setup and gives the test
 * suite a real Postgres to run against instead of a mock.
 */
const usePglite = bool(process.env.USE_PGLITE) || databaseUrl === '';

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: int(process.env.PORT, 3210),

  databaseUrl,
  usePglite,
  /** Directory for the PGlite data files. `memory://` keeps it ephemeral. */
  pgliteDir: process.env.PGLITE_DIR?.trim() || './.data/pglite',
  /** Seed the local database with demo data on first boot. */
  seedLocal: bool(process.env.SEED_LOCAL, true),

  poolMax: int(process.env.PG_POOL_MAX, 10),
  poolIdleTimeoutMs: int(process.env.PG_POOL_IDLE_TIMEOUT_MS, 30_000),
  poolConnectionTimeoutMs: int(process.env.PG_POOL_CONNECTION_TIMEOUT_MS, 10_000),
  statementTimeoutMs: int(process.env.PG_STATEMENT_TIMEOUT_MS, 15_000),

  /**
   * Optional shared secret. When unset the API stays open exactly as it was
   * before, so existing deployments keep working; when set, every mutating
   * request must present it.
   */
  apiKey: process.env.API_KEY?.trim() || '',
  /** Protect reads too, not just writes. */
  protectReads: bool(process.env.PROTECT_READS, false),

  /** Empty list means "reflect any origin", matching the previous cors() default. */
  corsOrigins: list(process.env.CORS_ORIGINS),

  rateLimitWindowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  rateLimitMax: int(process.env.RATE_LIMIT_MAX, 300),

  /** Currency used for formatting money in generated reports. */
  currency: process.env.CURRENCY?.trim() || 'COP',
  locale: process.env.LOCALE?.trim() || 'es-CO',
  /** IANA timezone used to bucket dates into days/months for analytics. */
  timezone: process.env.TIMEZONE?.trim() || 'America/Bogota',
} as const;

export type Env = typeof env;

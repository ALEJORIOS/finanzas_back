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

if (!databaseUrl) {
  // Failing here gives a readable message instead of a connection error deep
  // inside the first query. The app has no local/embedded fallback: it always
  // talks to the Postgres instance behind DATABASE_URL.
  throw new Error(
    'DATABASE_URL is not set. Configure it in .env locally and in the ' +
      'project environment variables before deploying.'
  );
}

/** True when running on Vercel (or any other serverless platform). */
const isServerless = Boolean(process.env.VERCEL);

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',
  isServerless,
  port: int(process.env.PORT, 3210),

  databaseUrl,
  /**
   * Schema migrations are DDL. Running them on every cold start would make a
   * serverless invocation slow and let concurrent instances race each other,
   * so there they are opt-in: run `bun run migrate` (or set RUN_MIGRATIONS=true
   * once) after deploying a schema change.
   */
  runMigrations: bool(process.env.RUN_MIGRATIONS, !isServerless),

  poolMax: int(process.env.PG_POOL_MAX, isServerless ? 1 : 10),
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

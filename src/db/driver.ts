import { Pool } from 'pg';
import { env } from '../config/env.ts';

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface Driver {
  query<T = any>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /** Runs `fn` inside a transaction on a single dedicated connection. */
  transaction<T>(fn: (tx: Driver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'postgres' | 'pglite';
}

/* ------------------------------------------------------------------ */
/* Postgres                                                            */
/* ------------------------------------------------------------------ */

function createPostgresDriver(): Driver {
  // One pool for the whole process. The previous implementation built a new
  // Pool per request and ended it afterwards, which meant a fresh TCP + TLS
  // handshake on every single call.
  const pool = new Pool({
    connectionString: env.databaseUrl,
    max: env.poolMax,
    idleTimeoutMillis: env.poolIdleTimeoutMs,
    connectionTimeoutMillis: env.poolConnectionTimeoutMs,
    statement_timeout: env.statementTimeoutMs,
    ssl: /localhost|127\.0\.0\.1/.test(env.databaseUrl) ? undefined : { rejectUnauthorized: false },
  });

  // An idle client erroring out must not take the process down.
  pool.on('error', (error) => {
    console.error('[db] idle client error:', error.message);
  });

  const wrap = (executor: {
    query: (sql: string, params?: any[]) => Promise<any>;
  }): Pick<Driver, 'query'> => ({
    async query(sql, params) {
      const result = await executor.query(sql, params ? [...params] : undefined);
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 };
    },
  });

  return {
    kind: 'postgres',
    query: wrap(pool).query,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const scoped: Driver = {
          kind: 'postgres',
          query: wrap(client).query,
          transaction: (inner) => inner(scoped),
          close: async () => {},
        };
        const result = await fn(scoped);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/* ------------------------------------------------------------------ */
/* PGlite (local development / tests)                                  */
/* ------------------------------------------------------------------ */

function createPgliteDriver(): Driver {
  // Imported lazily so the dependency never has to resolve in production.
  let ready: Promise<any> | null = null;

  async function instance() {
    if (!ready) {
      ready = (async () => {
        const { PGlite } = await import('@electric-sql/pglite');

        const inMemory = env.pgliteDir === 'memory' || env.pgliteDir === 'memory://';
        let location = 'memory://';

        if (!inMemory) {
          // PGlite's NodeFS backend calls mkdirSync() *without* `recursive`, so
          // a nested path like ./.data/pglite throws ENOENT unless the parent
          // directory already exists. Create the whole tree up front.
          const { mkdirSync } = await import('node:fs');
          mkdirSync(env.pgliteDir, { recursive: true });
          location = env.pgliteDir;
        }

        console.log(`[db] using PGlite at ${location}`);
        return new PGlite(location);
      })();
    }
    return ready;
  }

  async function run(sql: string, params?: readonly unknown[]): Promise<QueryResult> {
    const db = await instance();
    const result = await db.query(sql, params ? [...params] : undefined);
    return { rows: result.rows ?? [], rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  }

  const driver: Driver = {
    kind: 'pglite',
    query: run,
    async transaction(fn) {
      // PGlite is single-connection, so a plain BEGIN/COMMIT on the same handle
      // gives the same isolation guarantees we need here.
      await run('BEGIN');
      try {
        const result = await fn(driver);
        await run('COMMIT');
        return result;
      } catch (error) {
        await run('ROLLBACK').catch(() => {});
        throw error;
      }
    },
    async close() {
      if (!ready) return;
      const db = await instance();
      await db.close?.();
    },
  };

  return driver;
}

/* ------------------------------------------------------------------ */

let driver: Driver | null = null;

export function db(): Driver {
  if (!driver) {
    driver = env.usePglite ? createPgliteDriver() : createPostgresDriver();
  }
  return driver;
}

export async function closeDb(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

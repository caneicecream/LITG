import { Pool, types, type PoolClient, type QueryResultRow } from "pg";

// Dates stay ISO strings (no timezone shifts), timestamps become ISO strings,
// and bigint money/points values become numbers (all well within 2^53).
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1184, (v) => new Date(v).toISOString());
types.setTypeParser(20, (v) => Number(v));

/**
 * PostgreSQL access (server-side only). The connection string comes from
 * DATABASE_URL. Database code lives in src/db and src/data/backends; the domain
 * layer never imports it.
 */

export class DatabaseUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`The database is unavailable: ${cause instanceof Error ? cause.message : String(cause)}. Check DATABASE_URL and that PostgreSQL is running.`);
    this.name = "DatabaseUnavailableError";
  }
}

export class SchemaOutOfDateError extends Error {
  constructor(pending: string[]) {
    super(`The database schema is out of date (pending migrations: ${pending.join(", ")}). Run \`npm run db:migrate\`.`);
    this.name = "SchemaOutOfDateError";
  }
}

export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<R[]>;
  /** Run `fn` in a transaction; rolls back on error. */
  tx<T>(fn: (q: <R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "57P01", "57P03", "3D000", "28P01", "28000"]);

function wrap(err: unknown): never {
  const code = (err as { code?: string })?.code;
  if (code && CONNECTION_CODES.has(code)) throw new DatabaseUnavailableError(err);
  throw err;
}

/** Create a database handle. `schema` isolates tests (each test file gets its own schema). */
export function createDb(connectionString: string, opts: { schema?: string; max?: number } = {}): Db {
  const pool = new Pool({
    connectionString,
    max: opts.max ?? 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
  });
  // An idle client error (e.g. the server restarted) must not crash the app.
  pool.on("error", () => undefined);
  return {
    async query(sql, params) {
      try {
        return (await pool.query(sql, params as unknown[])).rows;
      } catch (err) {
        return wrap(err);
      }
    },
    async tx(fn) {
      let client: PoolClient;
      try {
        client = await pool.connect();
      } catch (err) {
        return wrap(err);
      }
      try {
        await client.query("BEGIN");
        const result = await fn(async (sql, params) => (await client.query(sql, params as unknown[])).rows);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        return wrap(err);
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

let shared: { url: string; db: Db } | null = null;

/** The app-wide database handle, or null when DATABASE_URL isn't set (JSON-file mode). */
export function appDb(): Db | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (!shared || shared.url !== url) shared = { url, db: createDb(url) };
  return shared.db;
}

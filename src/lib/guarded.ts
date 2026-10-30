import { appDb, DatabaseUnavailableError, SchemaOutOfDateError, type Db } from "@/db/pool";
import { ensureSchema } from "@/db/migrate";

export class MonitoringNotConfiguredError extends Error {
  constructor() {
    super("Monitoring needs a PostgreSQL database. Set DATABASE_URL and run `npm run db:migrate` (see README.md, \"Database and monitoring\"). Everything else works without it.");
    this.name = "MonitoringNotConfiguredError";
  }
}

/** The database for monitoring routes (schema verified), or a MonitoringNotConfiguredError. */
export async function monitoringDb(): Promise<Db> {
  const db = appDb();
  if (!db) throw new MonitoringNotConfiguredError();
  await ensureSchema(db);
  return db;
}

/**
 * Route-handler wrapper: a database outage or an un-migrated schema becomes a
 * clear 503 response instead of a crash. Other errors propagate as usual.
 */
export function guarded<A extends unknown[]>(handler: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof MonitoringNotConfiguredError) return Response.json({ errors: [err.message], database: "not_configured" }, { status: 503 });
      if (err instanceof DatabaseUnavailableError || err instanceof SchemaOutOfDateError) {
        return Response.json({ errors: [err.message], database: err instanceof SchemaOutOfDateError ? "out_of_date" : "unavailable" }, { status: 503 });
      }
      throw err;
    }
  };
}

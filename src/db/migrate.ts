import { createHash } from "node:crypto";
import { MIGRATIONS, type Migration } from "./migrations";
import { SchemaOutOfDateError, type Db } from "./pool";

const checksum = (m: Migration) => createHash("sha256").update(m.sql).digest("hex");

async function ensureTable(db: Db) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

export async function migrationStatus(db: Db): Promise<{ applied: string[]; pending: string[] }> {
  await ensureTable(db);
  const rows = await db.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations ORDER BY version");
  for (const r of rows) {
    const m = MIGRATIONS.find((x) => x.version === r.version);
    if (!m) throw new Error(`The database has migration ${r.version}, which this version of the app doesn't know. Upgrade the app.`);
    if (checksum(m) !== r.checksum) throw new Error(`Migration ${r.version} was changed after it was applied. Migrations must never be edited; add a new one.`);
  }
  const applied = rows.map((r) => r.version);
  return { applied, pending: MIGRATIONS.filter((m) => !applied.includes(m.version)).map((m) => m.version) };
}

/** Apply pending migrations, each in its own transaction (with a lock against concurrent runs). */
export async function runMigrations(db: Db, log: (msg: string) => void = () => undefined): Promise<string[]> {
  const { pending } = await migrationStatus(db);
  const applied: string[] = [];
  for (const version of pending) {
    const m = MIGRATIONS.find((x) => x.version === version)!;
    await db.tx(async (q) => {
      await q("SELECT pg_advisory_xact_lock(724001)");
      const already = await q("SELECT 1 FROM schema_migrations WHERE version = $1", [m.version]);
      if (already.length) return;
      await q(m.sql);
      await q("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [m.version, m.name, checksum(m)]);
    });
    log(`Applied migration ${m.version}: ${m.name}`);
    applied.push(m.version);
  }
  return applied;
}

/** Throw a clear error if the schema isn't current (the app never migrates implicitly). */
export async function assertSchemaCurrent(db: Db): Promise<void> {
  const { pending } = await migrationStatus(db);
  if (pending.length) throw new SchemaOutOfDateError(pending);
}

const checked = new WeakMap<Db, Promise<void>>();
/** `assertSchemaCurrent`, memoized per handle (retried after a failure). */
export function ensureSchema(db: Db): Promise<void> {
  let p = checked.get(db);
  if (!p) {
    p = assertSchemaCurrent(db);
    p.catch(() => checked.delete(db));
    checked.set(db, p);
  }
  return p;
}

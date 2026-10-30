/** Apply pending database migrations: npm run db:migrate (uses DATABASE_URL). */
import { createDb } from "@/db/pool";
import { migrationStatus, runMigrations } from "@/db/migrate";

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL is not set. See README.md, \"Database and monitoring\".");
    process.exit(1);
  }
  const db = createDb(url, { max: 1 });
  try {
    const statusOnly = process.argv.includes("--status");
    if (statusOnly) {
      const s = await migrationStatus(db);
      console.log(`Applied: ${s.applied.join(", ") || "none"}\nPending: ${s.pending.join(", ") || "none"}`);
      return;
    }
    const applied = await runMigrations(db, (m) => console.log(m));
    console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : "The schema is up to date.");
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

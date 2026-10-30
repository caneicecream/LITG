/**
 * Import the JSON store into PostgreSQL: npm run db:import-json [-- --dry-run] [-- --file path]
 * The JSON file is only read. Re-running is safe: existing rows are never changed.
 */
import { createDb } from "@/db/pool";
import { assertSchemaCurrent } from "@/db/migrate";
import { importJsonStore } from "@/db/importJson";
import { jsonStorePath, readStoreFile } from "@/data/backends/json";

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL is not set. See README.md, \"Database and monitoring\".");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const fileArg = args.indexOf("--file");
  const file = fileArg >= 0 ? args[fileArg + 1]! : jsonStorePath();
  const data = await readStoreFile(file);
  console.log(`Reading ${file}: ${data.prices.length} price entries, ${data.trips.length} trips, ${data.conversations.length} conversations.`);
  const db = createDb(url, { max: 1 });
  try {
    await assertSchemaCurrent(db);
    const r = await importJsonStore(db, data, { dryRun });
    console.log(dryRun ? "\nDry run (nothing was written):" : "\nImport complete:");
    console.log(`  Price entries:  ${r.prices.imported} imported, ${r.prices.alreadyPresent} already present`);
    console.log(`  Observations:   ${r.observations.imported} imported${r.observations.identicalRepeatsMerged ? `, ${r.observations.identicalRepeatsMerged} identical repeats merged` : ""}`);
    console.log(`  Trips:          ${r.trips.imported} imported, ${r.trips.alreadyPresent} already present, ${r.trips.runsImported} run snapshots added`);
    console.log(`  Conversations:  ${r.conversations.imported} imported, ${r.conversations.alreadyPresent} already present`);
    for (const w of r.warnings) console.log(`  Warning: ${w}`);
    console.log(`\nThe JSON file was not modified. Keep it as a backup; the app now uses PostgreSQL while DATABASE_URL is set.`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * Run due monitor checks: npm run monitor [-- --all]
 * Intended for cron, e.g. hourly. --all checks every enabled monitor now.
 */
import { createDb } from "@/db/pool";
import { assertSchemaCurrent } from "@/db/migrate";
import { listMonitors, runDueMonitors, runMonitorCheck } from "@/monitoring/service";

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL is not set: monitoring needs PostgreSQL. See README.md, \"Database and monitoring\".");
    process.exit(1);
  }
  const db = createDb(url, { max: 2 });
  try {
    await assertSchemaCurrent(db);
    if (process.argv.includes("--all")) {
      for (const m of (await listMonitors(db)).filter((m) => m.enabled)) {
        const r = await runMonitorCheck(db, m.id, { trigger: "manual" });
        console.log(`${m.tripName}: ${r?.check.events.map((e) => e.title).join("; ") || "no changes"}`);
      }
      return;
    }
    const results = await runDueMonitors(db);
    console.log(results.length ? results.map((r) => `${r.monitorId}: ${r.ok ? `${r.events} event(s)` : `failed: ${r.error}`}`).join("\n") : "No monitors are due.");
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

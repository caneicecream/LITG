import { redact } from "@/lib/errors";
import { appDb } from "@/db/pool";
import { runDueMonitors } from "./service";

/** In-process scheduler: looks for due monitors every 15 minutes (and shortly after start). */
let timer: ReturnType<typeof setInterval> | null = null;

export function startScheduler(intervalMs = 15 * 60_000) {
  if (timer) return;
  const tick = async () => {
    const db = appDb();
    if (!db) return;
    try {
      const results = await runDueMonitors(db);
      if (results.length) console.log(`[monitoring] ran ${results.length} check(s): ${results.filter((r) => r.ok).length} ok`);
    } catch (err) {
      // A database outage must not crash the app; the next tick retries.
      console.warn(`[monitoring] scheduled run skipped: ${redact(err instanceof Error ? err.message : String(err))}`);
    }
  };
  setTimeout(tick, 30_000).unref?.();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
}

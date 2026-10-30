import { timingSafeEqual } from "node:crypto";
import { guarded, monitoringDb } from "@/lib/guarded";
import { runDueMonitors } from "@/monitoring/service";

/**
 * Run due monitors, for an external scheduler (cron). Requires the header
 * `x-monitor-secret` to equal MONITOR_CRON_SECRET; disabled when that isn't set.
 */
async function handlePOST(req: Request) {
  const secret = process.env.MONITOR_CRON_SECRET?.trim();
  if (!secret) return Response.json({ errors: ["Scheduled runs over HTTP are disabled: set MONITOR_CRON_SECRET."] }, { status: 403 });
  const given = Buffer.from(req.headers.get("x-monitor-secret") ?? "");
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return Response.json({ errors: ["Forbidden"] }, { status: 403 });
  const db = await monitoringDb();
  return Response.json({ results: await runDueMonitors(db) });
}

export const POST = guarded(handlePOST);

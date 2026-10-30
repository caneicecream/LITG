import { z } from "zod";
import { appDb } from "@/db/pool";
import { guarded, monitoringDb } from "@/lib/guarded";
import { emailConfigured, unreadCount } from "@/monitoring/notify";
import { createMonitor, listChecks, listMonitors } from "@/monitoring/service";
import { monitorSettingsSchema } from "@/monitoring/types";

/** Monitoring status and the list of monitors. Reports "not configured" (not an error) without a database. */
async function handleGET() {
  if (!appDb()) {
    return Response.json({ available: false, reason: "not_configured", emailConfigured: emailConfigured(), monitors: [], unread: 0 });
  }
  const db = await monitoringDb();
  const monitors = await listMonitors(db);
  const withLatest = await Promise.all(
    monitors.map(async (m) => {
      const latest = (await listChecks(db, m.id, 1))[0] ?? null;
      return { ...m, latest: latest && { checkedAt: latest.checkedAt, tracked: latest.snapshot.tracked && { label: latest.snapshot.tracked.label, totalCents: latest.snapshot.tracked.totalCents, complete: latest.snapshot.tracked.complete, dataStatus: latest.snapshot.tracked.dataStatus }, events: latest.events.map((e) => ({ type: e.type, title: e.title, severity: e.severity })), switching: latest.snapshot.switching && { verdict: latest.snapshot.switching.verdict, headline: latest.snapshot.switching.headline } } };
    }),
  );
  return Response.json({
    available: true,
    emailConfigured: emailConfigured(),
    scheduler: process.env.MONITOR_SCHEDULER === "on" ? "in_app" : process.env.MONITOR_CRON_SECRET ? "external" : "manual_only",
    monitors: withLatest,
    unread: await unreadCount(db),
  });
}

const createBody = z.object({ tripId: z.string().min(1).max(100), settings: monitorSettingsSchema.partial().optional() });

/** Start monitoring a saved trip (opt-in per trip). */
async function handlePOST(req: Request) {
  const parsed = createBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const db = await monitoringDb();
  const monitor = await createMonitor(db, parsed.data.tripId, parsed.data.settings ?? {});
  if (!monitor) return Response.json({ errors: ["Saved trip not found. Save the trip first."] }, { status: 404 });
  return Response.json({ monitor }, { status: 201 });
}

export const GET = guarded(handleGET);
export const POST = guarded(handlePOST);

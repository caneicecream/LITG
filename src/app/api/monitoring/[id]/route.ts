import { z } from "zod";
import { pgBackendFor } from "@/data/backends/pg";
import { guarded, monitoringDb } from "@/lib/guarded";
import { listNotifications } from "@/monitoring/notify";
import { deleteMonitor, getMonitor, listChecks, monitorHistory, updateMonitor } from "@/monitoring/service";
import { monitorSettingsSchema } from "@/monitoring/types";

type Ctx = { params: Promise<{ id: string }> };

/** Monitor detail: settings, recent checks, equivalent-configuration price history, notifications. */
async function handleGET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const db = await monitoringDb();
  const monitor = await getMonitor(db, id);
  if (!monitor) return Response.json({ errors: ["Not found"] }, { status: 404 });
  const trip = await pgBackendFor(db).getTrip(monitor.tripId);
  if (!trip) return Response.json({ errors: ["The saved trip no longer exists"] }, { status: 404 });
  const [checks, history, notifications] = await Promise.all([listChecks(db, id, 30), monitorHistory(db, monitor, trip), listNotifications(db, { monitorId: id, limit: 20 })]);
  return Response.json({ monitor, trip: { id: trip.id, name: trip.name, request: trip.request }, checks, history, notifications });
}

const patchBody = z.object({
  enabled: z.boolean().optional(),
  settings: monitorSettingsSchema.partial().extend({ notifyOn: monitorSettingsSchema.shape.notifyOn.unwrap().partial().optional() }).optional(),
});

async function handlePATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const parsed = patchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const db = await monitoringDb();
  const monitor = await updateMonitor(db, id, parsed.data as Parameters<typeof updateMonitor>[2]);
  return monitor ? Response.json({ monitor }) : Response.json({ errors: ["Not found"] }, { status: 404 });
}

async function handleDELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const db = await monitoringDb();
  return (await deleteMonitor(db, id)) ? new Response(null, { status: 204 }) : Response.json({ errors: ["Not found"] }, { status: 404 });
}

export const GET = guarded(handleGET);
export const PATCH = guarded(handlePATCH);
export const DELETE = guarded(handleDELETE);

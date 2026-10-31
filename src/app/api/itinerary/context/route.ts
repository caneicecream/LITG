import { z } from "zod";
import { CATALOG } from "@/data/catalog";
import { loadPriceData } from "@/data/sources";
import { getTrip } from "@/data/store";
import { isIsoDate, todayIso } from "@/domain/dates";
import { parseTripRequest } from "@/domain/schema";
import { demoInput, tripContextFromRequest } from "@/itinerary/context";
import { guarded } from "@/lib/guarded";

/**
 * The trip an itinerary is planned for.
 *   GET ?tripId=…   from a saved trip
 *   GET ?demo=1     the illustrative demonstration scenario (full input)
 *   POST { request, option? } from the planner's current request, or one optimized option of it
 */
async function handleGET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("demo")) return Response.json({ demo: demoInput(todayIso()) });
  const tripId = url.searchParams.get("tripId");
  if (!tripId) return Response.json({ errors: ["tripId or demo is required"] }, { status: 400 });
  const trip = await getTrip(tripId);
  if (!trip) return Response.json({ errors: ["Saved trip not found"] }, { status: 404 });
  const data = await loadPriceData({ includeIllustrative: trip.request.data.includeIllustrative });
  const r = tripContextFromRequest(trip.request, data, { kind: "saved_trip", tripId: trip.id, label: trip.name }, todayIso());
  return r.ok ? Response.json({ context: r.context }) : Response.json({ errors: r.errors }, { status: 422 });
}

const optionSchema = z
  .object({
    arrival: z.string().refine(isIsoDate),
    nights: z.number().int().min(1).max(30),
    resortId: z.string().refine((id) => CATALOG.resorts.some((r) => r.id === id), "Unknown resort"),
    roomTypeId: z.string(),
    ticketOption: z.enum(["base", "park_hopper", "park_hopper_plus"]).nullable(),
    bookingMethod: z.enum(["separate", "package", "points"]),
    dining: z.enum(["out_of_pocket", "quick_service_plan", "dining_plan"]),
  })
  .strict();

async function handlePOST(req: Request) {
  const body = (await req.json().catch(() => null)) as { request?: unknown; option?: unknown; tripId?: string } | null;
  const parsed = parseTripRequest(body?.request);
  if (!parsed.ok) return Response.json({ errors: parsed.errors }, { status: 400 });
  const option = body?.option === undefined ? undefined : optionSchema.safeParse(body.option);
  if (option && !option.success) return Response.json({ errors: option.error.issues.map((i) => `option.${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const data = await loadPriceData({ includeIllustrative: parsed.request.data.includeIllustrative });
  const o = option?.data;
  const label = o ? `Option: ${CATALOG.resorts.find((r) => r.id === o.resortId)?.name ?? o.resortId}, ${o.arrival}, ${o.nights} nights` : "Your current plan";
  const r = tripContextFromRequest(parsed.request, data, { kind: "request", label }, todayIso(), o);
  return r.ok ? Response.json({ context: r.context }) : Response.json({ errors: r.errors }, { status: 422 });
}

export const GET = guarded(handleGET);
export const POST = guarded(handlePOST);

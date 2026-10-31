import { loadPriceData } from "@/data/sources";
import { getTrip } from "@/data/store";
import { todayIso } from "@/domain/dates";
import { parseTripRequest } from "@/domain/schema";
import { demoInput, tripContextFromRequest } from "@/itinerary/context";
import { guarded } from "@/lib/guarded";

/**
 * The trip an itinerary is planned for.
 *   GET ?tripId=…   from a saved trip
 *   GET ?demo=1     the illustrative demonstration scenario (full input)
 *   POST { request } from the planner's current request
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

async function handlePOST(req: Request) {
  const body = (await req.json().catch(() => null)) as { request?: unknown } | null;
  const parsed = parseTripRequest(body?.request);
  if (!parsed.ok) return Response.json({ errors: parsed.errors }, { status: 400 });
  const data = await loadPriceData({ includeIllustrative: parsed.request.data.includeIllustrative });
  const r = tripContextFromRequest(parsed.request, data, { kind: "request", label: "Your current plan" }, todayIso());
  return r.ok ? Response.json({ context: r.context }) : Response.json({ errors: r.errors }, { status: 422 });
}

export const GET = guarded(handleGET);
export const POST = guarded(handlePOST);

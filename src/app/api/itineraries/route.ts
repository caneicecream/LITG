import { listItineraries, saveItinerary } from "@/data/store";
import { todayIso } from "@/domain/dates";
import { planItinerary } from "@/itinerary/engine";
import { saveItineraryBody as saveBody } from "@/itinerary/api";
import { guarded } from "@/lib/guarded";

async function handleGET() {
  return Response.json({ itineraries: await listItineraries() });
}


/** Save a new itinerary. The server re-plans from the inputs: a client-supplied result is never stored. */
async function handlePOST(req: Request) {
  const parsed = saveBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const result = planItinerary(parsed.data.input, { today: todayIso() });
  const saved = await saveItinerary({ ...parsed.data, result });
  return Response.json({ itinerary: saved }, { status: 201 });
}

export const GET = guarded(handleGET);
export const POST = guarded(handlePOST);

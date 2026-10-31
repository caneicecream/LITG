import { z } from "zod";
import { todayIso } from "@/domain/dates";
import { compareItineraries, compareSummary, compareVariants, planItinerary, STANDARD_VARIANTS } from "@/itinerary/engine";
import { itineraryInputSchema } from "@/itinerary/types";

/**
 * Generate an itinerary (stateless; nothing is saved). With `compare`, also
 * plans the relaxed and ride-focused variants from exactly the same facts.
 */
const body = z.object({ input: itineraryInputSchema, compare: z.boolean().default(false) });

export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const opts = { today: todayIso() };
  const itinerary = planItinerary(parsed.data.input, opts);
  if (!parsed.data.compare) return Response.json({ itinerary });
  const [a, b] = compareVariants(parsed.data.input, STANDARD_VARIANTS, opts);
  return Response.json({
    itinerary,
    comparison: {
      variants: [a, b].map((v) => ({ label: v!.label, differs: v!.differs, itinerary: v!.itinerary })),
      summary: compareSummary(a!.itinerary, b!.itinerary),
      details: compareItineraries(a!, b!),
    },
  });
}

import { deleteItinerary, getItinerary, saveItinerary } from "@/data/store";
import { todayIso } from "@/domain/dates";
import { planItinerary } from "@/itinerary/engine";
import { guarded } from "@/lib/guarded";
import { saveItineraryBody as saveBody } from "@/itinerary/api";

type Ctx = { params: Promise<{ id: string }> };

async function handleGET(_req: Request, ctx: Ctx) {
  const it = await getItinerary((await ctx.params).id);
  return it ? Response.json({ itinerary: it }) : Response.json({ errors: ["Not found"] }, { status: 404 });
}

/** Regenerate: plans again from the (edited) inputs and appends a new version; earlier versions stay as they were. */
async function handlePOST(req: Request, ctx: Ctx) {
  const parsed = saveBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const result = planItinerary(parsed.data.input, { today: todayIso() });
  const saved = await saveItinerary({ ...parsed.data, id: (await ctx.params).id, result });
  return saved ? Response.json({ itinerary: saved }) : Response.json({ errors: ["Not found"] }, { status: 404 });
}

async function handleDELETE(_req: Request, ctx: Ctx) {
  return (await deleteItinerary((await ctx.params).id)) ? new Response(null, { status: 204 }) : Response.json({ errors: ["Not found"] }, { status: 404 });
}

export const GET = guarded(handleGET);
export const POST = guarded(handlePOST);
export const DELETE = guarded(handleDELETE);

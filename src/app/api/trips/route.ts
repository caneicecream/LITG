import { z } from "zod";
import { CATALOG } from "@/data/catalog";
import { loadPriceData } from "@/data/sources";
import { deleteTrip, getTrip, listTrips, saveTrip, type RunSnapshot } from "@/data/store";
import { optimize } from "@/domain/optimizer/optimize";
import { parseTripRequest } from "@/domain/schema";
import type { OptimizationResult } from "@/domain/types";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const trip = await getTrip(id);
    return trip ? Response.json({ trip }) : Response.json({ errors: ["Not found"] }, { status: 404 });
  }
  return Response.json({ trips: await listTrips() });
}

const saveBody = z.object({ id: z.string().optional(), name: z.string().trim().min(1).max(100), request: z.unknown() });

/** Save a trip. The server re-runs the optimization so the stored snapshot reflects current data. */
export async function POST(req: Request) {
  const body = saveBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ errors: body.error.issues.map((i) => i.message) }, { status: 400 });
  const parsed = parseTripRequest(body.data.request);
  if (!parsed.ok) return Response.json({ errors: parsed.errors }, { status: 400 });
  const data = await loadPriceData({ includeIllustrative: parsed.request.data.includeIllustrative });
  const result = optimize({ catalog: CATALOG, data, request: parsed.request });
  const trip = await saveTrip({ id: body.data.id, name: body.data.name, request: parsed.request, run: snapshot(result) });
  return Response.json({ trip }, { status: 201 });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ errors: ["id is required"] }, { status: 400 });
  return (await deleteTrip(id)) ? new Response(null, { status: 204 }) : Response.json({ errors: ["Not found"] }, { status: 404 });
}

function snapshot(r: OptimizationResult): RunSnapshot {
  const find = (kind: string) => {
    const id = r.awards.find((a) => a.kind === kind)?.evaluationId;
    return r.ranked.find((e) => e.id === id);
  };
  const cheapest = find("cheapest");
  const bestValue = find("best_value");
  const alt = find("best_alternative");
  const top = r.ranked[0];
  return {
    runAt: r.runAt,
    demoMode: r.demoMode,
    comparable: r.stats.comparable,
    top: top && { evaluationId: top.id, totalCents: top.totalCents, dataStatus: top.dataStatus },
    cheapest: cheapest && { evaluationId: cheapest.id, totalCents: cheapest.totalCents, dataStatus: cheapest.dataStatus },
    bestValue: bestValue && { evaluationId: bestValue.id, totalCents: bestValue.totalCents, dataStatus: bestValue.dataStatus },
    bestAlternative: alt?.savings ? { evaluationId: alt.id, totalCents: alt.totalCents, savingsCents: alt.savings.savingsCents } : undefined,
    // Only record the baseline when it is comparable with the results (same real/illustrative class).
    baselineTotalCents:
      r.baseline?.complete && r.baseline.containsIllustrative === r.demoMode ? r.baseline.totalCents : undefined,
  };
}

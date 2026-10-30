import { CATALOG } from "@/data/catalog";
import { loadPriceData } from "@/data/sources";
import { optimize } from "@/domain/optimizer/optimize";
import { parseTripRequest } from "@/domain/schema";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = parseTripRequest(body);
  if (!parsed.ok) return Response.json({ errors: parsed.errors }, { status: 400 });
  const data = await loadPriceData({ includeIllustrative: parsed.request.data.includeIllustrative });
  // ?include=<id>&include=<id> returns those configurations' full evaluations too.
  const include = new URL(req.url).searchParams.getAll("include").slice(0, 20);
  return Response.json(optimize({ catalog: CATALOG, data, request: parsed.request, include }));
}

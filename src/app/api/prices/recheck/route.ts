import { guarded } from "@/lib/guarded";
import { z } from "zod";
import { isIsoDate, todayIso } from "@/domain/dates";
import { recheckPrice } from "@/data/store";

const body = z.object({
  id: z.string().min(1),
  observedAt: z.string().refine(isIsoDate, "Expected YYYY-MM-DD"),
  status: z.enum(["manual", "estimated"]).optional(),
  source: z.string().trim().max(200).optional(),
  sourceUrl: z.union([z.url().max(500), z.null()]).optional(),
  notes: z.union([z.string().max(1000), z.null()]).optional(),
  value: z.number().int().positive().max(10_000_000).optional(),
  taxIncluded: z.boolean().optional(),
});

/**
 * Record that a price was re-checked ("is this quote still current?"). The
 * previous observation is kept in the entry's history; omit `value` when the
 * price is unchanged.
 */
async function handlePOST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  if (parsed.data.observedAt > todayIso()) return Response.json({ errors: ["observedAt: can't be in the future"] }, { status: 400 });
  const { id, ...input } = parsed.data;
  const res = await recheckPrice(id, input);
  if (!res.ok) return Response.json({ errors: [res.error] }, { status: res.error === "Not found" ? 404 : 400 });
  return Response.json({ entry: res.entry });
}

export const POST = guarded(handlePOST);

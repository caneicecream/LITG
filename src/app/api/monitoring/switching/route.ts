import { z } from "zod";
import { isIsoDate, todayIso } from "@/domain/dates";
import { paymentTermsSchema } from "@/data/entrySchema";
import { analyzeSwitching } from "@/monitoring/switching";

/**
 * Switching-cost calculator (pure arithmetic; works without a database).
 * All amounts are integer cents. Unknown values are null, never guessed.
 */
const cents = z.number().int().min(0).max(10_000_000);
const status = z.enum(["verified", "manual", "estimated", "illustrative", "stale", "unavailable"]);
const body = z.object({
  asOf: z.string().refine(isIsoDate).optional(),
  current: z.object({ totalCents: cents.nullable(), terms: paymentTermsSchema.nullable(), status: status.default("manual") }),
  alternative: z.object({
    totalCents: cents.nullable(),
    terms: paymentTermsSchema.nullable().default(null),
    status: status.default("manual"),
    likeForLike: z.boolean(),
    differences: z.array(z.string().max(200)).max(20).default([]),
  }),
  knownFeesCents: cents.default(0),
  otherNonRefundableCents: cents.default(0),
  ticketChangeCents: z.number().int().min(-10_000_000).max(10_000_000).nullable().default(0),
  diningChangeCents: z.number().int().min(-10_000_000).max(10_000_000).nullable().default(0),
  minBenefitCents: cents.default(10_000),
});

export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  return Response.json({ analysis: analyzeSwitching({ ...parsed.data, asOf: parsed.data.asOf ?? todayIso() }) });
}

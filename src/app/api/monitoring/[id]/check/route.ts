import { guarded, monitoringDb } from "@/lib/guarded";
import { runMonitorCheck } from "@/monitoring/service";

/**
 * "Check now": re-evaluate the saved trip with the prices stored right now.
 * This is not a live price check; to record a new price, re-check the quote.
 */
async function handlePOST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await monitoringDb();
  const out = await runMonitorCheck(db, id, { trigger: "manual" });
  if (!out) return Response.json({ errors: ["Not found"] }, { status: 404 });
  return Response.json(out);
}

export const POST = guarded(handlePOST);

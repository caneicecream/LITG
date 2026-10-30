import { guarded } from "@/lib/guarded";
import { parsePriceEntries, parsePriceEntry } from "@/data/entrySchema";
import { addPrice, addPrices, deletePrice, listPrices } from "@/data/store";

async function handleGET() {
  return Response.json({ entries: await listPrices() });
}

/** Add one entry (`{...entry}`) or several at once (`{ entries: [...] }`, all-or-nothing). */
async function handlePOST(req: Request) {
  const body = await req.json().catch(() => null);
  if (body && Array.isArray(body.entries)) {
    if (body.entries.length === 0 || body.entries.length > 500) {
      return Response.json({ errors: ["Send between 1 and 500 entries"] }, { status: 400 });
    }
    const parsed = parsePriceEntries(body.entries);
    if (!parsed.ok) return Response.json({ errors: parsed.errors }, { status: 400 });
    return Response.json({ entries: await addPrices(parsed.entries) }, { status: 201 });
  }
  const parsed = parsePriceEntry(body);
  if (!parsed.ok) return Response.json({ errors: parsed.errors }, { status: 400 });
  return Response.json({ entry: await addPrice(parsed.entry) }, { status: 201 });
}

async function handleDELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ errors: ["id is required"] }, { status: 400 });
  return (await deletePrice(id)) ? new Response(null, { status: 204 }) : Response.json({ errors: ["Not found"] }, { status: 404 });
}

export const GET = guarded(handleGET);
export const POST = guarded(handlePOST);
export const DELETE = guarded(handleDELETE);

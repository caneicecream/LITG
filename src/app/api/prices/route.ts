import { parsePriceEntry } from "@/data/entrySchema";
import { addPrice, deletePrice, listPrices } from "@/data/store";

export async function GET() {
  return Response.json({ entries: await listPrices() });
}

export async function POST(req: Request) {
  const parsed = parsePriceEntry(await req.json().catch(() => null));
  if (!parsed.ok) return Response.json({ errors: parsed.errors }, { status: 400 });
  return Response.json({ entry: await addPrice(parsed.entry) }, { status: 201 });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ errors: ["id is required"] }, { status: 400 });
  return (await deletePrice(id)) ? new Response(null, { status: 204 }) : Response.json({ errors: ["Not found"] }, { status: 404 });
}

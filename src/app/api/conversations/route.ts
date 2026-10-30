import { assistantDeps } from "@/ai/server";
import { createConversation } from "@/ai/service";
import { deleteConversation, getConversation, listConversations } from "@/data/store";

/** GET: list summaries, or ?id= for one full conversation (request, messages, latest result). */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const conversation = await getConversation(id);
    return conversation ? Response.json({ conversation }) : Response.json({ errors: ["Not found"] }, { status: 404 });
  }
  return Response.json({ conversations: await listConversations() });
}

/** POST: start a conversation, optionally from the planner's request ({ request, title }). */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { request?: unknown; title?: string };
  try {
    const conversation = await createConversation(assistantDeps(), { request: body.request as never, title: body.title });
    return Response.json({ conversation }, { status: 201 });
  } catch (err) {
    return Response.json({ errors: [err instanceof Error ? err.message : "Invalid request"] }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ errors: ["id is required"] }, { status: 400 });
  return (await deleteConversation(id)) ? new Response(null, { status: 204 }) : Response.json({ errors: ["Not found"] }, { status: 404 });
}

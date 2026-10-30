import { z } from "zod";
import { getProvider } from "@/ai/providers/config";
import { assistantDeps } from "@/ai/server";
import { applyProposal, ConversationNotFound, dismissProposal, runRequest, sendMessage, updateSettings } from "@/ai/service";

/** Which assistant mode is active (never exposes keys). */
export async function GET() {
  return Response.json(getProvider().status);
}

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("message"), conversationId: z.string(), text: z.string().min(1).max(4000) }),
  z.object({ action: z.literal("apply"), conversationId: z.string(), messageId: z.string() }),
  z.object({ action: z.literal("dismiss"), conversationId: z.string(), messageId: z.string() }),
  z.object({ action: z.literal("run"), conversationId: z.string(), request: z.unknown(), reason: z.enum(["form", "restore"]) }),
  z.object({ action: z.literal("settings"), conversationId: z.string(), autoApply: z.boolean().optional(), title: z.string().max(100).optional() }),
]);

export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const deps = assistantDeps();
  const b = parsed.data;
  try {
    const conversation =
      b.action === "message"
        ? await sendMessage(deps, b.conversationId, b.text)
        : b.action === "apply"
          ? await applyProposal(deps, b.conversationId, b.messageId)
          : b.action === "dismiss"
            ? await dismissProposal(deps, b.conversationId, b.messageId)
            : b.action === "run"
              ? await runRequest(deps, b.conversationId, b.request, b.reason)
              : await updateSettings(deps, b.conversationId, { autoApply: b.autoApply, title: b.title });
    return Response.json({ conversation });
  } catch (err) {
    if (err instanceof ConversationNotFound) return Response.json({ errors: [err.message] }, { status: 404 });
    return Response.json({ errors: [err instanceof Error ? err.message : "Something went wrong"] }, { status: 400 });
  }
}

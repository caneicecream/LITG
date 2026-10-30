import { z } from "zod";
import { appDb } from "@/db/pool";
import { guarded, monitoringDb } from "@/lib/guarded";
import { listNotifications, markRead, unreadCount } from "@/monitoring/notify";

async function handleGET() {
  if (!appDb()) return Response.json({ available: false, notifications: [], unread: 0 });
  const db = await monitoringDb();
  return Response.json({ available: true, notifications: await listNotifications(db, { limit: 100 }), unread: await unreadCount(db) });
}

const body = z.object({ read: z.union([z.literal("all"), z.array(z.string().min(1).max(100)).max(200)]) });

async function handlePOST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ errors: ["Expected { read: \"all\" | [ids] }"] }, { status: 400 });
  const db = await monitoringDb();
  return Response.json({ updated: await markRead(db, parsed.data.read), unread: await unreadCount(db) });
}

export const GET = guarded(handleGET);
export const POST = guarded(handlePOST);

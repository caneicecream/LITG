import { guarded, monitoringDb } from "@/lib/guarded";
import { emailConfigured, getNotificationSettings, notificationSettingsSchema, saveNotificationSettings } from "@/monitoring/notify";

async function handleGET() {
  const db = await monitoringDb();
  return Response.json({ settings: await getNotificationSettings(db), emailConfigured: emailConfigured() });
}

async function handlePUT(req: Request) {
  const parsed = notificationSettingsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  if (parsed.data.emailEnabled && !parsed.data.emailTo) return Response.json({ errors: ["emailTo: an address is required to enable email"] }, { status: 400 });
  const db = await monitoringDb();
  return Response.json({ settings: await saveNotificationSettings(db, parsed.data), emailConfigured: emailConfigured() });
}

export const GET = guarded(handleGET);
export const PUT = guarded(handlePUT);

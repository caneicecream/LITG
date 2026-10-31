import { redact } from "@/lib/errors";
import { z } from "zod";
import type { Db } from "@/db/pool";
import type { MonitorEvent } from "./types";

/**
 * Notifications: always in-app; optionally by email. One digest per check
 * (never one message per event), and an event that was already notified is
 * never notified again (each event carries a stable dedupe key).
 */

export const notificationSettingsSchema = z.object({
  emailEnabled: z.boolean().default(false),
  emailTo: z.email().max(200).nullable().default(null),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export async function getNotificationSettings(db: Db): Promise<NotificationSettings> {
  const rows = await db.query<{ value: unknown }>("SELECT value FROM app_settings WHERE key = 'notifications'");
  const parsed = notificationSettingsSchema.safeParse(rows[0]?.value ?? {});
  return parsed.success ? parsed.data : notificationSettingsSchema.parse({});
}

export async function saveNotificationSettings(db: Db, s: NotificationSettings): Promise<NotificationSettings> {
  await db.query(
    "INSERT INTO app_settings (key, value) VALUES ('notifications', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify(s)],
  );
  return s;
}

export interface EmailSender {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

/** Email is available only when SMTP_URL is configured (server-side; credentials never reach the browser). */
export function emailConfigured(): boolean {
  return !!process.env.SMTP_URL?.trim();
}

export function smtpSender(): EmailSender | null {
  const url = process.env.SMTP_URL?.trim();
  if (!url) return null;
  const from = process.env.NOTIFY_EMAIL_FROM?.trim() || "Disney Vacation Optimizer <no-reply@localhost>";
  return {
    async send({ to, subject, text }) {
      const nodemailer = await import("nodemailer");
      await nodemailer.createTransport(url).sendMail({ from, to, subject, text });
    },
  };
}

/** The digest for one check: title and plain-text body. Pure. */
export function composeDigest(tripName: string, events: MonitorEvent[]): { title: string; body: string } {
  const important = events.filter((e) => e.severity === "important");
  const lead = important[0] ?? events[0]!;
  const title = events.length === 1 ? `${tripName}: ${lead.title}` : `${tripName}: ${lead.title} (+${events.length - 1} more)`;
  const body = [
    ...events.map((e) => `• ${e.title}\n  ${e.detail}${e.evidence.length ? `\n  ${e.evidence.join("\n  ")}` : ""}`),
    "",
    "Monitoring compares prices you have recorded; it does not check live availability. Nothing has been booked, changed or cancelled.",
  ].join("\n");
  return { title, body };
}

export interface NotificationRow {
  id: string;
  monitorId: string | null;
  createdAt: string;
  title: string;
  body: string;
  data: { checkId?: string; tripId?: string; eventKeys?: string[]; types?: string[] };
  readAt: string | null;
  delivery: { email?: { status: "sent" | "failed" | "skipped"; at: string; error?: string } };
}

/** Event keys already notified (so the same situation never notifies twice). */
export async function alreadyNotified(db: Db, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await db.query<{ k: string }>(
    "SELECT DISTINCT jsonb_array_elements_text(data->'eventKeys') AS k FROM notifications WHERE data->'eventKeys' ?| $1::text[]",
    [keys],
  );
  return new Set(rows.map((r) => r.k).filter((k) => keys.includes(k)));
}

export async function createNotification(
  db: Db,
  n: { id: string; monitorId: string; tripId: string; checkId: string; createdAt: string; tripName: string; events: MonitorEvent[] },
  email: { sender: EmailSender; to: string } | null,
): Promise<NotificationRow | null> {
  const { title, body } = composeDigest(n.tripName, n.events);
  const data = { checkId: n.checkId, tripId: n.tripId, eventKeys: n.events.map((e) => e.dedupeKey), types: n.events.map((e) => e.type) };
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO notifications (id, monitor_id, created_at, title, body, data, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [n.id, n.monitorId, n.createdAt, title, body, JSON.stringify(data), `check:${n.checkId}`],
  );
  if (!inserted.length) return null;
  let delivery: NotificationRow["delivery"] = {};
  if (email) {
    try {
      await email.sender.send({ to: email.to, subject: title, text: body });
      delivery = { email: { status: "sent", at: new Date().toISOString() } };
    } catch (err) {
      // A failed email never loses the in-app notification.
      delivery = { email: { status: "failed", at: new Date().toISOString(), error: redact(err instanceof Error ? err.message : "unknown error").slice(0, 300) } };
    }
    await db.query("UPDATE notifications SET delivery = $2 WHERE id = $1", [n.id, JSON.stringify(delivery)]);
  }
  return { id: n.id, monitorId: n.monitorId, createdAt: n.createdAt, title, body, data, readAt: null, delivery };
}

interface Row {
  id: string;
  monitor_id: string | null;
  created_at: string;
  title: string;
  body: string;
  data: NotificationRow["data"];
  read_at: string | null;
  delivery: NotificationRow["delivery"];
}
const fromRow = (r: Row): NotificationRow => ({ id: r.id, monitorId: r.monitor_id, createdAt: r.created_at, title: r.title, body: r.body, data: r.data, readAt: r.read_at, delivery: r.delivery });

export async function listNotifications(db: Db, opts: { limit?: number; monitorId?: string } = {}): Promise<NotificationRow[]> {
  const rows = opts.monitorId
    ? await db.query<Row>("SELECT * FROM notifications WHERE monitor_id = $1 ORDER BY created_at DESC LIMIT $2", [opts.monitorId, opts.limit ?? 50])
    : await db.query<Row>("SELECT * FROM notifications ORDER BY created_at DESC LIMIT $1", [opts.limit ?? 50]);
  return rows.map(fromRow);
}

export async function unreadCount(db: Db): Promise<number> {
  return (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE read_at IS NULL"))[0]?.n ?? 0;
}

export async function markRead(db: Db, ids: string[] | "all"): Promise<number> {
  const rows =
    ids === "all"
      ? await db.query("UPDATE notifications SET read_at = now() WHERE read_at IS NULL RETURNING id")
      : await db.query("UPDATE notifications SET read_at = now() WHERE read_at IS NULL AND id = ANY($1) RETURNING id", [ids]);
  return rows.length;
}

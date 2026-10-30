"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { NotificationRow } from "@/monitoring/notify";

export function NotificationsPage() {
  const [d, setD] = useState<{ available: boolean; notifications: NotificationRow[]; unread: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await fetch("/api/notifications");
    const b = await r.json().catch(() => ({}));
    if (!r.ok) setError(b.errors?.join(" ") ?? `Error ${r.status}`);
    else setD(b);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const mark = async (read: string[] | "all") => {
    await fetch("/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ read }) });
    load();
  };

  if (error) return <div className="banner banner-error">{error}</div>;
  if (!d) return <div className="card empty">Loading…</div>;
  return (
    <div className="stack" style={{ gap: 16, maxWidth: 900 }}>
      <div className="row">
        <h1>Notifications</h1>
        <span className="spacer" />
        {d.unread > 0 && <button onClick={() => mark("all")}>Mark all as read</button>}
      </div>
      {!d.available && (
        <div className="card empty">
          Notifications come from monitoring, which needs a PostgreSQL database. See <Link href="/monitoring">Monitoring</Link>.
        </div>
      )}
      {d.available && d.notifications.length === 0 && <div className="card empty">No notifications yet.</div>}
      {d.notifications.map((n) => (
        <div key={n.id} className={`card card-pad stack${n.readAt ? "" : " unread"}`}>
          <div className="row">
            <span>{n.readAt ? "" : "● "}{n.title}</span>
            <span className="spacer" />
            <span className="small muted">{new Date(n.createdAt).toLocaleString()}</span>
          </div>
          <pre className="small" style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit", fontWeight: 400 }}>{n.body}</pre>
          <div className="row small">
            {n.monitorId && <Link href={`/monitoring/${n.monitorId}`}>Open monitor</Link>}
            {!n.readAt && <button className="link" onClick={() => mark([n.id])}>Mark as read</button>}
            {n.delivery.email && <span className="muted">Email: {n.delivery.email.status}{n.delivery.email.error ? ` (${n.delivery.email.error})` : ""}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

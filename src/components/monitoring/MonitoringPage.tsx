"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatCents } from "@/domain/money";
import type { PriceStatus } from "@/domain/provenance";
import type { MonitorRecord } from "@/monitoring/service";
import { StatusChip } from "../ui";

interface Row extends MonitorRecord {
  latest: {
    checkedAt: string;
    tracked: { label: string; totalCents: number; complete: boolean; dataStatus: PriceStatus } | null;
    events: { type: string; title: string; severity: string }[];
    switching: { verdict: string; headline: string } | null;
  } | null;
}

interface Status {
  available: boolean;
  reason?: string;
  emailConfigured: boolean;
  scheduler?: "in_app" | "external" | "manual_only";
  monitors: Row[];
  unread: number;
}

export function MonitoringPage() {
  const [s, setS] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await fetch("/api/monitoring");
    const b = await r.json().catch(() => ({}));
    if (!r.ok) setError(b.errors?.join(" ") ?? `Error ${r.status}`);
    else setS(b);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <div className="banner banner-error">{error}</div>;
  if (!s) return <div className="card empty">Loading…</div>;

  return (
    <div className="stack" style={{ gap: 16, maxWidth: 1000 }}>
      <div>
        <h1>Monitoring</h1>
        <p className="muted">
          Track saved trips over time: price history for the exact configuration, meaningful changes, and whether switching to a cheaper option would actually save money after cancellation costs. Monitoring never books, changes or cancels anything.
        </p>
      </div>
      {!s.available ? (
        <NotConfigured />
      ) : (
        <>
          <div className="banner banner-info small">
            <div>
              Checks re-evaluate your saved trips with the prices stored in this app. They are not live price checks: new prices come from your quotes and re-checks (no authorized automatic price source is connected).{" "}
              {s.scheduler === "in_app" ? "Scheduled checks run inside the app." : s.scheduler === "external" ? "Scheduled checks run when your scheduler calls /api/monitoring/run." : "No scheduler is configured: use “Check now”, or run `npm run monitor` from cron."}
            </div>
          </div>
          {s.monitors.length === 0 && (
            <div className="card empty">
              No trips are monitored yet. On <Link href="/trips">Saved trips</Link>, press “Monitor” on a trip.
            </div>
          )}
          {s.monitors.map((m) => (
            <div key={m.id} className="card card-pad stack">
              <div className="row">
                <h2>
                  <Link href={`/monitoring/${m.id}`}>{m.tripName}</Link>
                </h2>
                {!m.enabled && <span className="chip chip-plain">Paused</span>}
                <span className="spacer" />
                <span className="small muted">Last check {m.latest ? new Date(m.latest.checkedAt).toLocaleString() : "never"}</span>
              </div>
              {m.latest?.tracked ? (
                <p className="small">
                  {m.latest.tracked.label}: <strong className="num">{m.latest.tracked.complete ? "" : "≥ "}{formatCents(m.latest.tracked.totalCents)}</strong> <StatusChip status={m.latest.tracked.dataStatus} />
                </p>
              ) : (
                <p className="small muted">{m.latest ? "The preferred plan is not fully specified." : "Not checked yet."}</p>
              )}
              {m.latest && m.latest.events.length > 0 && <p className="small">{m.latest.events.map((e) => e.title).join(" · ")}</p>}
              {m.latest?.switching && <p className="small">{m.latest.switching.headline}</p>}
            </div>
          ))}
          <EmailSettings emailConfigured={s.emailConfigured} />
        </>
      )}
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="card card-pad stack">
      <h2>Monitoring needs a PostgreSQL database</h2>
      <p className="small">
        The rest of the app works as before with the local JSON file. To turn on price history and monitoring:
      </p>
      <ol className="small">
        <li>
          Start PostgreSQL (for example <code>docker compose up -d db</code>) and set <code>DATABASE_URL</code> in <code>.env.local</code>.
        </li>
        <li>
          Run <code>npm run db:migrate</code>.
        </li>
        <li>
          Optionally copy your existing data with <code>npm run db:import-json</code> (your JSON file is only read, never changed).
        </li>
        <li>Restart the app.</li>
      </ol>
      <p className="small muted">See “Database and monitoring” in README.md for details.</p>
    </div>
  );
}

function EmailSettings({ emailConfigured }: { emailConfigured: boolean }) {
  const [s, setS] = useState<{ emailEnabled: boolean; emailTo: string | null } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/notifications/settings")
      .then((r) => r.json())
      .then((b) => b.settings && setS(b.settings))
      .catch(() => undefined);
  }, []);
  if (!s) return null;
  const save = async () => {
    const r = await fetch("/api/notifications/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...s, emailTo: s.emailTo || null }) });
    const b = await r.json().catch(() => ({}));
    setMsg(r.ok ? "Saved." : (b.errors?.join(" ") ?? "Could not save."));
  };
  return (
    <div className="card card-pad stack">
      <h2>Notifications</h2>
      <p className="small muted">
        Notifications always appear in the app (🔔). One digest per check, and the same situation is never notified twice. Email is optional{emailConfigured ? "" : " and needs SMTP_URL to be configured on the server"}.
      </p>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={s.emailEnabled} disabled={!emailConfigured} onChange={(e) => setS({ ...s, emailEnabled: e.target.checked })} /> Email me too
        </label>
        <input style={{ maxWidth: 280 }} type="email" placeholder="you@example.com" value={s.emailTo ?? ""} onChange={(e) => setS({ ...s, emailTo: e.target.value })} />
        <button onClick={save}>Save</button>
        {msg && <span className="small muted">{msg}</span>}
      </div>
      <p className="hint">Each monitor also has its own “also by email” switch in its preferences.</p>
    </div>
  );
}

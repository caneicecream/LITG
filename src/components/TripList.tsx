"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CATALOG } from "@/data/catalog";
import type { SavedTrip } from "@/data/store";
import { formatShortDate } from "@/domain/dates";
import { formatCents } from "@/domain/money";
import type { PriceStatus } from "@/domain/provenance";
import { StatusChip } from "./ui";

export function TripList() {
  const [trips, setTrips] = useState<SavedTrip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Monitoring (needs PostgreSQL): trip id → monitor id.
  const [monitoring, setMonitoring] = useState<{ available: boolean; byTrip: Record<string, string> }>({ available: false, byTrip: {} });

  const load = () => {
    fetch("/api/trips")
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.errors?.join(" ") ?? `Error ${r.status}`);
        setTrips(b.trips);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    fetch("/api/monitoring")
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => b && setMonitoring({ available: b.available, byTrip: Object.fromEntries((b.monitors ?? []).map((m: { tripId: string; id: string }) => [m.tripId, m.id])) }))
      .catch(() => undefined);
  };

  const monitor = async (t: SavedTrip) => {
    const r = await fetch("/api/monitoring", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tripId: t.id }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) return setError(b.errors?.join(" ") ?? `Error ${r.status}`);
    // Run a first check right away so the monitor has a baseline.
    await fetch(`/api/monitoring/${b.monitor.id}/check`, { method: "POST" });
    location.href = `/monitoring/${b.monitor.id}`;
  };
  useEffect(() => {
    load();
  }, []);

  const remove = async (t: SavedTrip) => {
    if (!confirm(`Delete “${t.name}”? This cannot be undone.`)) return;
    await fetch(`/api/trips?id=${encodeURIComponent(t.id)}`, { method: "DELETE" });
    load();
  };

  if (error) return <div className="banner banner-error">{error}</div>;
  if (!trips) return <div className="card empty">Loading…</div>;

  return (
    <div className="stack" style={{ gap: 16, maxWidth: 1000 }}>
      <div>
        <h1>Saved trips</h1>
        <p className="muted">
          Each save re-runs the optimizer and keeps a snapshot, so you can see how the best options change as you add or update prices.
          {monitoring.available ? " Press “Monitor” to track a trip's price history and changes." : ""}
        </p>
      </div>
      {trips.length === 0 && (
        <div className="card empty">
          No saved trips yet. Set up a trip on <Link href="/">Plan & compare</Link> and press “Save trip”.
        </div>
      )}
      {trips.map((t) => {
        const r = t.request;
        const pref = CATALOG.resorts.find((x) => x.id === r.preferred.resortId);
        return (
          <div key={t.id} className="card card-pad stack">
            <div className="row">
              <h2>{t.name}</h2>
              <span className="spacer" />
              <Link className="btn" href={`/?trip=${t.id}`}>
                Open
              </Link>
              {monitoring.byTrip[t.id] ? (
                <Link className="btn" href={`/monitoring/${monitoring.byTrip[t.id]}`}>
                  Monitoring ✓
                </Link>
              ) : monitoring.available ? (
                <button onClick={() => monitor(t)} title="Track this trip's prices over time (opt-in)">
                  Monitor
                </button>
              ) : null}
              <button className="danger" onClick={() => remove(t)}>
                Delete
              </button>
            </div>
            <p className="small muted">
              {r.party.adults} adult{r.party.adults > 1 ? "s" : ""}
              {r.party.children ? `, ${r.party.children} child${r.party.children > 1 ? "ren" : ""}` : ""} · arrive {formatShortDate(r.dates.earliestArrival)}–
              {formatShortDate(r.dates.latestDeparture)} · {r.dates.minNights}–{r.dates.maxNights} nights · {r.tickets.parkDays} park days
              {pref ? ` · prefers ${pref.name.replace("Disney's ", "")}` : ""} · updated {new Date(t.updatedAt).toLocaleString()}
            </p>
            {t.runs.length > 0 && (
              <div className="scroll-x">
              <table className="cmp">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th className="r">Options compared</th>
                    <th className="r">Top result</th>
                    <th className="r">Cheapest</th>
                    <th className="r">Best value</th>
                    <th className="r">Best alternative saves</th>
                    <th className="r">Your plan</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {t.runs.slice(0, 5).map((run) => (
                    <tr key={run.runAt}>
                      <td className="small">{new Date(run.runAt).toLocaleString()}</td>
                      <td className="r num">{run.comparable.toLocaleString()}</td>
                      <td className="r num">{run.top ? formatCents(run.top.totalCents) : "—"}</td>
                      <td className="r num">{run.cheapest ? formatCents(run.cheapest.totalCents) : "—"}</td>
                      <td className="r num">{run.bestValue ? formatCents(run.bestValue.totalCents) : "—"}</td>
                      <td className="r num save-pos">{run.bestAlternative ? formatCents(run.bestAlternative.savingsCents) : "—"}</td>
                      <td className="r num">{run.baselineTotalCents !== undefined ? formatCents(run.baselineTotalCents) : "—"}</td>
                      <td>
                        {run.demoMode ? <StatusChip status="illustrative" /> : run.top ? <StatusChip status={run.top.dataStatus as PriceStatus} /> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

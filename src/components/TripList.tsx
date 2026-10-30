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

  const load = () =>
    fetch("/api/trips")
      .then((r) => r.json())
      .then((b) => setTrips(b.trips))
      .catch((e) => setError(String(e)));
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
            )}
          </div>
        );
      })}
    </div>
  );
}

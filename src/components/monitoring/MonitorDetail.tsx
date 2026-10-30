"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatShortDate, todayIso } from "@/domain/dates";
import { formatCents } from "@/domain/money";
import type { PriceStatus } from "@/domain/provenance";
import type { TripRequest } from "@/domain/types";
import type { NotificationRow } from "@/monitoring/notify";
import type { CheckRecord, MonitorHistory, MonitorRecord } from "@/monitoring/service";
import type { MonitorSettings } from "@/monitoring/types";
import { MoneyInput, StatusChip } from "../ui";
import { PriceHistoryChart } from "./PriceHistoryChart";
import { SwitchingPanel, type SwitchingDefaults } from "./SwitchingPanel";

interface Detail {
  monitor: MonitorRecord;
  trip: { id: string; name: string; request: TripRequest };
  checks: CheckRecord[];
  history: MonitorHistory;
  notifications: NotificationRow[];
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export function MonitorDetail({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/monitoring/${encodeURIComponent(id)}`);
    const b = await r.json().catch(() => ({}));
    if (!r.ok) setError(b.errors?.join(" ") ?? `Error ${r.status}`);
    else {
      setError(null);
      setD(b);
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<Response>) => {
    setBusy(true);
    try {
      const r = await fn();
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        setError(b.errors?.join(" ") ?? `Error ${r.status}`);
      }
      await load();
    } finally {
      setBusy(false);
    }
  };
  const patch = (body: object) => act(() => fetch(`/api/monitoring/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  if (error && !d) return <div className="banner banner-error">{error}</div>;
  if (!d) return <div className="card empty">Loading…</div>;

  const { monitor, checks, history } = d;
  const latest = checks[0] ?? null;
  const snap = latest?.snapshot ?? null;
  const tracked = snap?.tracked ?? null;
  const primary = history.series.find((s) => tracked?.quoteId && s.points.some((p) => p.entryId === tracked.quoteId)) ?? history.series[0] ?? null;
  const today = todayIso();

  return (
    <div className="stack" style={{ gap: 16, maxWidth: 1100 }}>
      <div className="row">
        <div className="stack" style={{ gap: 2 }}>
          <Link href="/monitoring" className="small">← All monitors</Link>
          <h1>{d.trip.name}</h1>
          <p className="small muted">
            {monitor.enabled ? (monitor.settings.frequency === "manual" ? "Checked only when you ask" : `Checked ${monitor.settings.frequency}`) : "Paused"} · last check {when(monitor.lastCheckAt)}
            {monitor.enabled && monitor.nextCheckAt ? ` · next ${when(monitor.nextCheckAt)}` : ""}
          </p>
        </div>
        <span className="spacer" />
        <button className="primary" disabled={busy} onClick={() => act(() => fetch(`/api/monitoring/${id}/check`, { method: "POST" }))} title="Re-evaluate the trip with the prices stored now. This is not a live price check.">
          {busy ? "Checking…" : "Check now"}
        </button>
        <Link className="btn" href="/prices" title="Re-check a quote or enter a new one: that is what records a new price observation.">
          Record a new observation
        </Link>
        <button disabled={busy} onClick={() => patch({ enabled: !monitor.enabled })}>{monitor.enabled ? "Pause" : "Resume"}</button>
        <button
          className="danger"
          disabled={busy}
          onClick={() => confirm("Stop monitoring this trip? Its check log is removed; price observations and notifications are kept.") && act(async () => { const r = await fetch(`/api/monitoring/${id}`, { method: "DELETE" }); if (r.ok) location.href = "/monitoring"; return r; })}
        >
          Stop monitoring
        </button>
      </div>
      {error && <div className="banner banner-error">{error}</div>}
      <div className="banner banner-info small">
        <div>
          “Check now” re-evaluates your saved trip with the prices <em>stored in this app</em>; it does not fetch live prices from Disney. New prices come from your re-checks and new quotes on the Price data page.
        </div>
      </div>

      {/* ── Summary ── */}
      <div className="card card-pad stack">
        <h2>Tracked plan</h2>
        {tracked ? <p className="small">{tracked.label}</p> : <p className="small muted">{snap?.trackedNote ?? "Run a first check to start."}</p>}
        <div className="tiles">
          {primary ? (
            <>
              <Tile label="Latest observed price" value={formatCents(primary.latest.valueCents)} sub={`${formatShortDate(primary.latest.observedOn)} · ${primary.latest.source}`} status={primary.latest.effectiveStatus} />
              <Tile label="Previous observation" value={primary.previous ? formatCents(primary.previous.valueCents) : "—"} sub={primary.previous ? `${formatShortDate(primary.previous.observedOn)} · ${primary.previous.source}` : "Only one observation so far"} />
              <Tile
                label="Change"
                value={primary.changeCents === null ? "—" : formatCents(primary.changeCents, { sign: true })}
                sub={primary.changePct === null ? "Needs two observations" : `${primary.changePct > 0 ? "+" : ""}${primary.changePct}% · trend ${primary.trend}`}
              />
              <Tile label="Last observed" value={`${primary.ageDays} day${primary.ageDays === 1 ? "" : "s"} ago`} sub={primary.stale ? "Stale: re-check before relying on it" : `Fresh (within ${monitor.settings.staleAfterDays} days)`} status={primary.stale ? "stale" : undefined} />
            </>
          ) : (
            <p className="small muted">No quote has been recorded for this exact configuration yet, so there is no observed price history. Totals below are re-evaluations from stored component prices.</p>
          )}
          {tracked && <Tile label="Plan total at last check" value={formatCents(tracked.totalCents)} sub={tracked.complete ? `Re-evaluated ${when(latest!.checkedAt)}` : `Lower bound: missing ${tracked.missing.join(", ")}`} status={tracked.dataStatus} />}
        </div>
      </div>

      {/* ── Latest events ── */}
      {latest && latest.events.length > 0 && (
        <div className="card card-pad stack">
          <h2>What changed at the last check</h2>
          {latest.events.map((e) => (
            <div key={e.dedupeKey} className={`event event-${e.severity}`}>
              <strong>{e.title}</strong>
              <p className="small">{e.detail}</p>
              {e.evidence.length > 0 && (
                <ul className="notices small muted">
                  {e.evidence.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── History ── */}
      <div className="card card-pad stack">
        <h2>Price history for this exact configuration</h2>
        <p className="small muted">
          Each line connects observations of the same resort, room, dates, party, booking method, tickets and dining, with the same tax treatment. Different configurations are never joined into one trend.
        </p>
        {history.separationNotes.map((n) => (
          <p key={n} className="small">{n}</p>
        ))}
        {history.series.length === 0 && <p className="small muted">No observations yet. Enter or re-check a quote for this configuration on the Price data page.</p>}
        {history.series.map((s) => (
          <div key={s.key} className="stack" style={{ gap: 4 }}>
            <h3>
              {s.taxTreatment === "all_in" ? "Totals including tax" : "Totals before tax"} · {s.evidence === "quoted" ? "quoted prices" : "your estimates"} · {s.points.length} observation{s.points.length === 1 ? "" : "s"}
            </h3>
            {s.insufficientReason ? <p className="small muted">{s.insufficientReason}</p> : null}
            <PriceHistoryChart series={s} today={today} />
            <div className="scroll-x">
              <table className="cmp">
                <thead>
                  <tr>
                    <th>Observed</th>
                    <th className="r">Total</th>
                    <th>Source</th>
                    <th>Status</th>
                    <th>Recorded</th>
                    <th>How</th>
                  </tr>
                </thead>
                <tbody>
                  {[...s.points].reverse().map((p) => (
                    <tr key={p.observationId}>
                      <td>{formatShortDate(p.observedOn)}</td>
                      <td className="r num">{formatCents(p.valueCents)}</td>
                      <td className="small">{p.sourceUrl ? <a href={p.sourceUrl} rel="noreferrer noopener" target="_blank">{p.source}</a> : p.source}</td>
                      <td><StatusChip status={p.effectiveStatus} /></td>
                      <td className="small">{when(p.recordedAt)}</td>
                      <td className="small" title={p.assumptions.join(" ")}>{{ entry: "entered", recheck: "re-check", import: "imported", adapter: "authorized source" }[p.origin]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      {/* ── Switching ── */}
      <div className="card card-pad stack">
        <h2>Is switching worth it?</h2>
        {snap?.bestAlternative ? (
          <p className="small">
            Cheapest like-for-like option at the last check: {snap.bestAlternative.label}, {formatCents(snap.bestAlternative.totalCents)} <StatusChip status={snap.bestAlternative.dataStatus} />
          </p>
        ) : (
          <p className="small muted">No cheaper like-for-like option was found at the last check. You can still use the calculator.</p>
        )}
        {snap && !snap.reservation && (
          <p className="small muted">
            No booked reservation is recorded for this plan, so there are no switching costs: any difference is a plain price comparison. Mark your quote as “a reservation I already hold” (with its terms) on the Price data page to analyse switching.
          </p>
        )}
        <SwitchingPanel key={latest?.id ?? "none"} defaults={switchingDefaults(d)} />
      </div>

      {/* ── Checks log ── */}
      <div className="card card-pad stack">
        <h2>Check log</h2>
        <p className="small muted">Totals re-evaluated with the prices stored at each check. A changed total is labelled with its cause; only new price data counts as a price change.</p>
        <div className="scroll-x">
          <table className="cmp">
            <thead>
              <tr>
                <th>Checked</th>
                <th>Trigger</th>
                <th className="r">Plan total</th>
                <th>Data</th>
                <th>Changes</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id}>
                  <td className="small">{when(c.checkedAt)}</td>
                  <td className="small">{c.trigger}</td>
                  <td className="r num">{c.snapshot.tracked ? `${c.snapshot.tracked.complete ? "" : "≥ "}${formatCents(c.snapshot.tracked.totalCents)}` : "—"}</td>
                  <td>{c.snapshot.tracked && <StatusChip status={c.snapshot.tracked.dataStatus} />}</td>
                  <td className="small">{c.events.map((e) => e.title).join("; ") || "No change"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <SettingsForm settings={monitor.settings} busy={busy} onSave={(s) => patch({ settings: s })} />
    </div>
  );
}

function Tile({ label, value, sub, status }: { label: string; value: string; sub?: string; status?: PriceStatus }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
      {status && <div style={{ marginTop: 4 }}><StatusChip status={status} /></div>}
    </div>
  );
}

function switchingDefaults(d: Detail): SwitchingDefaults {
  const snap = d.checks[0]?.snapshot;
  const sw = snap?.switching;
  const s = d.monitor.settings;
  const alt = snap?.bestAlternative;
  return {
    originalCents: sw?.originalCostCents ?? snap?.reservation?.totalCents ?? null,
    paidCents: sw?.amountPaidCents ?? null,
    penaltyCents: sw?.cancellationPenaltyCents ?? null,
    alternativeCents: alt?.totalCents ?? null,
    depositCents: alt?.terms?.depositCents ?? null,
    likeForLike: alt?.likeForLike ?? true,
    differences: alt?.differences ?? [],
    feesCents: s.knownSwitchingFeesCents,
    otherNonRefundableCents: s.otherNonRefundableCents,
    ticketChangeCents: s.ticketChangeCents,
    diningChangeCents: s.diningChangeCents,
    minBenefitCents: s.minSavingsCents,
  };
}

function SettingsForm({ settings, busy, onSave }: { settings: MonitorSettings; busy: boolean; onSave: (s: MonitorSettings) => void }) {
  const [s, setS] = useState(settings);
  useEffect(() => setS(settings), [settings]);
  const set = <K extends keyof MonitorSettings>(k: K, v: MonitorSettings[K]) => setS((x) => ({ ...x, [k]: v }));
  const notify = (k: keyof MonitorSettings["notifyOn"], v: boolean) => setS((x) => ({ ...x, notifyOn: { ...x.notifyOn, [k]: v } }));
  return (
    <div className="card card-pad stack">
      <h2>Monitoring preferences</h2>
      <div className="grid3">
        <label className="field">
          How often
          <select value={s.frequency} onChange={(e) => set("frequency", e.target.value as MonitorSettings["frequency"])}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="manual">Only when I ask</option>
          </select>
        </label>
        <label className="field">
          Prices are stale after (days)
          <input type="number" min={1} max={365} value={s.staleAfterDays} onChange={(e) => set("staleAfterDays", Math.max(1, Number(e.target.value) || 1))} />
        </label>
        <label className="field">
          Notify on changes of at least (%)
          <input type="number" min={0} max={100} step={0.5} value={s.minChangePct} onChange={(e) => set("minChangePct", Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label className="field">
          …or at least ($)
          <MoneyInput value={s.minChangeCents} onChange={(c) => set("minChangeCents", c ?? 0)} />
        </label>
        <label className="field">
          Smallest net benefit worth switching for
          <MoneyInput value={s.minSavingsCents} onChange={(c) => set("minSavingsCents", c ?? 0)} />
        </label>
        <label className="field">
          Known switching fees
          <MoneyInput value={s.knownSwitchingFeesCents} onChange={(c) => set("knownSwitchingFeesCents", c ?? 0)} />
        </label>
        <label className="field">
          Other non-refundable amounts
          <MoneyInput value={s.otherNonRefundableCents} onChange={(c) => set("otherNonRefundableCents", c ?? 0)} />
        </label>
        <label className="field">
          Ticket change cost (blank = unknown)
          <MoneyInput optional placeholder="unknown" value={s.ticketChangeCents ?? undefined} onChange={(c) => set("ticketChangeCents", c ?? null)} />
        </label>
        <label className="field">
          Dining change cost (blank = unknown)
          <MoneyInput optional placeholder="unknown" value={s.diningChangeCents ?? undefined} onChange={(c) => set("diningChangeCents", c ?? null)} />
        </label>
      </div>
      <div className="row small">
        Notify me about:
        {(
          [
            ["decreases", "price drops"],
            ["increases", "price increases"],
            ["promotions", "promotions"],
            ["stale", "stale prices"],
            ["missing", "missing prices"],
            ["newQuotes", "new quotes"],
            ["alternatives", "cheaper alternatives"],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={s.notifyOn[k]} onChange={(e) => notify(k, e.target.checked)} /> {label}
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={s.email} onChange={(e) => set("email", e.target.checked)} /> also by email
        </label>
      </div>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => onSave(s)}>
          Save preferences
        </button>
      </div>
    </div>
  );
}

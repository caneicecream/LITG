"use client";

import { formatDate } from "@/domain/dates";
import { parkById } from "@/itinerary/catalog";
import { fmtTime } from "@/itinerary/engine";
import { INFO_STATUS_LABEL, type DayPlan, type DerivedInfoStatus, type Itinerary, type PlannedItem } from "@/itinerary/types";

const INFO_HELP: Record<DerivedInfoStatus, string> = {
  verified: "Confirmed by an authorized source.",
  manual: "You entered this (for example from an official page you checked). Not independently verified.",
  estimated: "An estimate: approximate, not a measured or official value.",
  predicted: "A prediction for a future date. Not an observation.",
  illustrative: "Demonstration data. Not real.",
  stale: "You entered this a while ago; re-check it.",
  unavailable: "Unknown: no data, so a planning assumption is used.",
};

export function InfoChip({ status, label }: { status: DerivedInfoStatus; label?: string }) {
  const cls = status === "predicted" ? "estimated" : status;
  return (
    <span className={`chip chip-${cls}`} title={INFO_HELP[status]}>
      {label ?? INFO_STATUS_LABEL[status]}
    </span>
  );
}

const KIND_ICON: Record<PlannedItem["kind"], string> = {
  attraction: "🎢",
  custom: "⭐",
  lightning_lane: "⚡",
  meal: "🍽",
  dining: "🍽",
  break: "☕",
  flexible: "🕑",
  transfer: "🚌",
};

const parkName = (id: string) => parkById.get(id)?.name ?? id;

export function StatusBadges({ it }: { it: Itinerary }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className={`chip ${it.status === "feasible" ? "chip-verified" : it.status === "partial" ? "chip-estimated" : "chip-unavailable"}`}>
        {it.status === "feasible" ? "All hard constraints met" : it.status === "partial" ? "Some must-dos left out" : "Not feasible"}
      </span>
      {it.provisional && <span className="chip chip-stale" title="Relies on assumed hours or waits, or unresolved reservations.">Provisional</span>}
      {it.demo && <span className="chip chip-illustrative">Demonstration</span>}
    </span>
  );
}

export function ItineraryView({ it, compact = false }: { it: Itinerary; compact?: boolean }) {
  return (
    <div className="stack" style={{ gap: 12 }}>
      {it.demo && (
        <div className="banner banner-demo">
          <div>
            <strong>Demonstration.</strong> Park hours, waits and the dinner reservation in this plan are <strong>illustrative</strong>: they are not real operating schedules, current waits or availability.
          </div>
        </div>
      )}
      <div className="stack" style={{ gap: 4 }}>
        <h2>{it.headline}</h2>
        <StatusBadges it={it} />
      </div>
      {it.infeasibleReasons.length > 0 && (
        <div className="banner banner-error">
          <ul className="notices">
            {it.infeasibleReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {it.conflicts.length > 0 && (
        <div className="banner banner-warn">
          <div>
            <strong>Conflicts and adjustments</strong>
            <ul className="notices small">
              {it.conflicts.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {it.score && <ScoreCard it={it} />}

      {it.coverage.must.missing.length > 0 && (
        <div className="card card-pad stack">
          <h3>Must-dos not scheduled</h3>
          <ul className="notices small">
            {it.coverage.must.missing.map((m) => (
              <li key={m.id}>
                <strong>{m.name}</strong>: {m.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {it.days.map((d) => (
        <DayCard key={d.date} d={d} />
      ))}

      {!compact && (
        <>
          <div className="card card-pad stack">
            <h3>Unknowns and assumptions</h3>
            <ul className="notices small">
              {it.unknowns.map((u) => (
                <li key={u}>{u}</li>
              ))}
              {it.assumptions.map((u) => (
                <li key={u} className="muted">
                  {u}
                </li>
              ))}
            </ul>
          </div>
          <div className="card card-pad stack">
            <h3>Information used</h3>
            <div className="scroll-x">
              <table className="cmp">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Status</th>
                    <th>Source</th>
                    <th>Observed / entered</th>
                  </tr>
                </thead>
                <tbody>
                  {it.dataUsed.map((x, i) => (
                    <tr key={i}>
                      <td className="small">{x.label}</td>
                      <td>
                        <InfoChip status={x.status} />
                      </td>
                      <td className="small">{x.source}</td>
                      <td className="small">{x.observedAt.slice(0, 10) || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">{it.search.note} Planner version {it.engineVersion}.</p>
          </div>
        </>
      )}
    </div>
  );
}

function ScoreCard({ it }: { it: Itinerary }) {
  const s = it.score!;
  return (
    <div className="card card-pad stack">
      <div className="row">
        <h3>Fit with your priorities: {s.total}/100</h3>
        <span className="spacer" />
        <span className="small muted">
          Must-dos {it.coverage.must.scheduled}/{it.coverage.must.total} · “Would like” {it.coverage.want.scheduled}/{it.coverage.want.total}
        </span>
      </div>
      <p className="hint">{s.meaning}</p>
      <div className="scroll-x">
        <table className="cmp">
          <thead>
            <tr>
              <th>Component</th>
              <th className="r">Score</th>
              <th className="r">Weight</th>
              <th>Based on</th>
            </tr>
          </thead>
          <tbody>
            {s.components.map((c) => (
              <tr key={c.key}>
                <td>{c.label}</td>
                <td className="r num">{c.score}</td>
                <td className="r num">{c.weightPct}%</td>
                <td className="small">{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DayCard({ d }: { d: DayPlan }) {
  if (d.kind === "rest" || d.kind === "no_park") {
    return (
      <div className="card card-pad">
        <strong>{formatDate(d.date)}</strong> <span className="muted small">· {d.window.detail}</span>
      </div>
    );
  }
  return (
    <div className="card card-pad stack">
      <div className="row">
        <h3>
          {formatDate(d.date)} · {d.parkIds.map(parkName).join(" → ")}
        </h3>
        <span className="spacer" />
        <span className="small muted">
          ~{d.walkingMin} min walking (est.) · {d.backtracks} backtrack{d.backtracks === 1 ? "" : "s"}
        </span>
      </div>
      <p className="small muted">{d.window.detail}</p>
      <div className="scroll-x">
        <table className="cmp itinerary-table">
          <tbody>
            {d.items.map((i, k) => (
              <tr key={k} className={`it-${i.kind}`}>
                <td className="num small" style={{ whiteSpace: "nowrap" }}>
                  {fmtTime(i.start)}–{fmtTime(i.end)}
                </td>
                <td>
                  <span aria-hidden>{KIND_ICON[i.kind]} </span>
                  <strong>{i.title}</strong>
                  {i.priority === "must" && <span className="chip chip-award" style={{ marginLeft: 6 }}>Must-do</span>}
                  {i.priority === "want" && <span className="chip chip-plain" style={{ marginLeft: 6 }}>Would like</span>}
                  <div className="small muted">
                    {[i.travelMin ? `${i.travelMin} min walk/transfer before` : null, i.waitMin
                        ? i.waitBasis === "none"
                          ? `arrive ~${i.waitMin} min early (assumed)`
                          : `${i.waitMin} min wait (${i.waitBasis === "assumed_buffer" ? "assumed" : i.waitBasis === "your_estimate" ? "estimate" : i.waitBasis === "lightning_lane" ? "Lightning Lane, assumed" : i.waitBasis})`
                        : null, i.kind === "attraction" || i.kind === "lightning_lane" ? `~${i.durationMin} min experience` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  {i.basis.length > 0 && (
                    <div className="row" style={{ gap: 4, marginTop: 2 }}>
                      {i.basis.map((b, j) => (
                        <InfoChip key={j} status={b.status} label={b.label} />
                      ))}
                    </div>
                  )}
                  {i.notes.map((n) => (
                    <div key={n} className="small">
                      {n}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.notes.length > 0 && (
        <ul className="notices small">
          {d.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {d.unscheduled.length > 0 && (
        <p className="small">
          <strong>Not fitted this day:</strong> {d.unscheduled.map((u) => `${u.name} (${u.reason})`).join("; ")}
        </p>
      )}
    </div>
  );
}

/** Two candidates from the same facts, side by side. */
export function CompareView({ variants, summary, onUse }: { variants: { label: string; differs: string[]; itinerary: Itinerary }[]; summary: string[]; onUse?: (label: string) => void }) {
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="card card-pad stack">
        <h3>
          {variants.map((v) => v.label).join(" vs ")} — same trip, same park information
        </h3>
        <ul className="notices small">
          {summary.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <p className="hint">Only the preferences listed under each plan differ. Scores reflect how each plan fits its own preferences, so compare the facts above rather than the two scores.</p>
      </div>
      <div className="split">
        {variants.map((v) => (
          <div key={v.label} className="stack" style={{ gap: 8, minWidth: 0 }}>
            <div className="card card-pad stack">
              <div className="row">
                <h3>{v.label}</h3>
                <span className="spacer" />
                {onUse && <button onClick={() => onUse(v.label)}>Use these preferences</button>}
              </div>
              <p className="small">Differs: {v.differs.join(" · ")}</p>
              <StatusBadges it={v.itinerary} />
            </div>
            <ItineraryView it={v.itinerary} compact />
          </div>
        ))}
      </div>
    </div>
  );
}

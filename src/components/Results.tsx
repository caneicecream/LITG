"use client";

import { Fragment, useMemo, useState } from "react";
import { addDays, dayOfWeek, formatShortDate, type IsoDate } from "@/domain/dates";
import { formatCents } from "@/domain/money";
import { DINING_LABEL, TICKET_LABEL } from "@/domain/pricing/calculate";
import type { Award, Evaluation, OptimizationResult, TripRequest } from "@/domain/types";
import { Breakdown } from "./Breakdown";
import { StatusChip } from "./ui";

export const METHOD_LABEL = { separate: "Separate", package: "Package", points: "DVC points" } as const;

const AWARD_LABEL: Record<Award["kind"], string> = {
  cheapest: "Cheapest",
  best_value: "Best value",
  best_alternative: "Best alternative to your plan",
};

type SortKey = "rank" | "total" | "perNight" | "value" | "arrival";

export function Results({ result, loadDetail, request }: { result: OptimizationResult; loadDetail: (id: string) => Promise<Evaluation | null>; request?: TripRequest }) {
  // Hand an optimized option to the itinerary planner (the planner shows exactly which trip it plans).
  const planDays = request
    ? (e: Evaluation) => {
        try {
          localStorage.setItem("dvo:itinerary-option", JSON.stringify({ request, option: e.config }));
        } catch {
          /* storage unavailable */
        }
        location.href = "/itinerary?option=1";
      }
    : undefined;
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("rank");
  const [picked, setPicked] = useState<{ id: string; e: Evaluation | null; loading: boolean } | null>(null);

  // A calendar date: jump to it if it's in the list, otherwise fetch it on demand.
  const pickDate = async (id: string) => {
    if (result.ranked.some((e) => e.id === id)) {
      setPicked(null);
      select(id);
      return;
    }
    setPicked({ id, e: null, loading: true });
    requestAnimationFrame(() => document.getElementById("picked-date")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    const e = await loadDetail(id);
    setPicked({ id, e, loading: false });
  };

  const all = useMemo(() => {
    const m = new Map<string, Evaluation>();
    for (const e of [...result.ranked, ...result.excluded.illustrative, ...result.excluded.incomplete, ...result.excluded.overHardLimit]) m.set(e.id, e);
    if (result.baseline) m.set(`baseline:${result.baseline.id}`, result.baseline);
    return m;
  }, [result]);

  const awardsById = useMemo(() => {
    const m = new Map<string, Award["kind"][]>();
    for (const a of result.awards) m.set(a.evaluationId, [...(m.get(a.evaluationId) ?? []), a.kind]);
    return m;
  }, [result]);

  const rows = useMemo(() => {
    const rs = result.ranked.map((e, i) => ({ e, rank: i + 1 }));
    const cmp: Record<SortKey, (a: (typeof rs)[number], b: (typeof rs)[number]) => number> = {
      rank: (a, b) => a.rank - b.rank,
      total: (a, b) => a.e.totalCents - b.e.totalCents || a.rank - b.rank,
      perNight: (a, b) => a.e.perNightCents - b.e.perNightCents || a.rank - b.rank,
      value: (a, b) => (b.e.valueScore?.total ?? 0) - (a.e.valueScore?.total ?? 0) || a.rank - b.rank,
      arrival: (a, b) => (a.e.config.arrival < b.e.config.arrival ? -1 : a.e.config.arrival > b.e.config.arrival ? 1 : a.rank - b.rank),
    };
    return [...rs].sort(cmp[sort]);
  }, [result, sort]);

  const select = (id: string) => {
    setSelected(id);
    requestAnimationFrame(() => document.getElementById(`row-${cssId(id)}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  const { stats } = result;
  const hasBaselineSavings = result.ranked.some((e) => e.savings);

  return (
    <div className="results">
      {result.demoMode && (
        <div className="banner banner-demo" role="alert">
          <div>
            <strong>Illustrative prices — not real offers.</strong> These results come from the bundled demo dataset. They show how
            the optimizer works, but none of these totals can be booked. Add real quotes on the <a href="/prices">Price data</a> page.
          </div>
        </div>
      )}

      <div className="row small muted">
        <span>
          Considered <b className="num">{stats.candidates.toLocaleString()}</b> configurations · <b className="num">{stats.infeasible.toLocaleString()}</b> broke a requirement ·{" "}
          <b className="num">{stats.priced.toLocaleString()}</b> priced in full ·{" "}
          <span title="Skipped because a lower bound on their cost proves they can't change any result shown here">
            <b className="num">{stats.pruned.toLocaleString()}</b> skipped (provably can’t change the results)
          </span>
        </span>
        <span className="spacer" />
        <span>Run {new Date(result.runAt).toLocaleString()}</span>
      </div>

      {result.notices.filter((n) => !n.startsWith("These results are based on ILLUSTRATIVE")).length > 0 && (
        <div className="banner banner-warn small">
          <ul className="notices">
            {result.notices
              .filter((n) => !n.startsWith("These results are based on ILLUSTRATIVE"))
              .map((n) => (
                <li key={n}>{n}</li>
              ))}
          </ul>
        </div>
      )}

      <div className="awards">
        {result.awards.map((a) => {
          const e = all.get(a.evaluationId);
          if (!e) return null;
          return (
            <div key={a.kind} className={`card award ${result.demoMode ? "demo" : ""}`} onClick={() => select(e.id)} role="button" tabIndex={0}>
              <div className="row">
                <span className="award-kind">{AWARD_LABEL[a.kind]}</span>
                <span className="spacer" />
                <StatusChip status={e.dataStatus} />
              </div>
              <div className="award-total">{formatCents(e.totalCents)}</div>
              <Summary e={e} />
              <ul>
                {a.explanation.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          );
        })}
        {result.baseline && (
          <div className="card award baseline" onClick={() => setSelected(`baseline:${result.baseline!.id}`)} role="button" tabIndex={0}>
            <div className="row">
              <span className="award-kind">Your preferred plan</span>
              <span className="spacer" />
              <StatusChip status={result.baseline.dataStatus} />
            </div>
            <div className={`award-total ${result.baseline.complete ? "" : "lower-bound"}`}>{formatCents(result.baseline.totalCents)}</div>
            <Summary e={result.baseline} />
            {result.baselineNote && <p className="small muted">{result.baselineNote}</p>}
          </div>
        )}
      </div>
      {!result.baseline && result.baselineNote && <p className="small muted">{result.baselineNote}</p>}

      {selected?.startsWith("baseline:") && result.baseline && (
        <div className="card">
          <div className="row card-pad" style={{ paddingBottom: 0 }}>
            <h2>Your preferred plan — cost breakdown</h2>
            <span className="spacer" />
            <button className="link" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <Breakdown e={result.baseline} onPlanDays={planDays} />
        </div>
      )}

      {result.ranked.length > 0 ? (
        <div className="card">
          <div className="row card-pad" style={{ paddingBottom: 8 }}>
            <h2>Ranked options</h2>
            <span className="muted small">
              {result.ranked.length} shown, ranked by {sort === "rank" ? "your objective" : sort}. Click a row for its full cost breakdown.
            </span>
          </div>
          <div className="table-wrap">
            <table className="cmp">
              <thead>
                <tr>
                  <SortTh k="rank" sort={sort} setSort={setSort} label="#" />
                  <SortTh k="arrival" sort={sort} setSort={setSort} label="Dates" />
                  <th>Resort & room</th>
                  <th>Tickets · Booking · Dining</th>
                  <SortTh k="total" sort={sort} setSort={setSort} label="Total" right />
                  <SortTh k="perNight" sort={sort} setSort={setSort} label="Per night" right />
                  {hasBaselineSavings && <th className="r">Vs. your plan</th>}
                  <SortTh k="value" sort={sort} setSort={setSort} label="Value" right />
                  <th>Data</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ e, rank }) => (
                  <Fragment key={e.id}>
                    <tr id={`row-${cssId(e.id)}`} className={`result-row ${selected === e.id ? "selected" : ""}`} onClick={() => setSelected(selected === e.id ? null : e.id)}>
                      <td className="num muted">{rank}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {formatShortDate(e.config.arrival)} → {formatShortDate(e.departure)}
                        <div className="small muted">{e.config.nights} nights</div>
                      </td>
                      <td>
                        {e.resortName.replace("Disney's ", "")}
                        <div className="small muted">{e.roomName}</div>
                        <div className="row" style={{ gap: 4, marginTop: 2 }}>
                          {(awardsById.get(e.id) ?? []).map((k) => (
                            <span key={k} className="chip chip-award">
                              {AWARD_LABEL[k].replace(" to your plan", "")}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="small">
                        {e.config.ticketOption ? TICKET_LABEL[e.config.ticketOption] : "No tickets"}
                        <div className="muted">
                          {METHOD_LABEL[e.config.bookingMethod]} · {DINING_LABEL[e.config.dining]}
                        </div>
                        {e.appliedPromotion && <div className="save-pos">−{formatCents(e.appliedPromotion.savingsCents)} offer</div>}
                      </td>
                      <td className="r num" style={{ fontWeight: 700 }}>
                        {formatCents(e.totalCents)}
                        {e.budget.overTargetCents !== null && e.budget.overTargetCents > 0 && <div className="small save-neg">over target</div>}
                      </td>
                      <td className="r num">{formatCents(e.perNightCents)}</td>
                      {hasBaselineSavings && (
                        <td className="r num">
                          {e.savings ? (
                            <span className={e.savings.savingsCents > 0 ? "save-pos" : e.savings.savingsCents < 0 ? "save-neg" : "muted"}>
                              {e.savings.savingsCents === 0 ? "same" : formatCents(-e.savings.savingsCents, { sign: true })}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                          {e.savings && !e.savings.likeForLike && <div className="small muted">not like-for-like</div>}
                        </td>
                      )}
                      <td className="r num">{e.valueScore?.total.toFixed(0) ?? "—"}</td>
                      <td>
                        <StatusChip status={e.dataStatus} />
                      </td>
                    </tr>
                    {selected === e.id && (
                      <tr className="detail-row">
                        <td colSpan={hasBaselineSavings ? 9 : 8}>
                          <Breakdown e={e} onPlanDays={planDays} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="card empty">No fully priced option meets your requirements. See the details below.</div>
      )}

      {result.dateMatrix.length > 1 && <DateMatrix result={result} onPick={pickDate} />}

      {picked && (
        <div className="card" id="picked-date">
          <div className="row card-pad" style={{ paddingBottom: 0 }}>
            <h2>Selected date</h2>
            {picked.e && <StatusChip status={picked.e.dataStatus} />}
            <span className="spacer" />
            <button className="link" onClick={() => setPicked(null)}>
              Close
            </button>
          </div>
          {picked.loading ? (
            <div className="empty">Loading…</div>
          ) : picked.e ? (
            <>
              <div className="card-pad" style={{ paddingBottom: 0 }}>
                <Summary e={picked.e} />
                <div className="award-total" style={{ marginTop: 6 }}>{formatCents(picked.e.totalCents)}</div>
                <p className="small muted">Not among the top options listed above; shown here for comparison.</p>
              </div>
              <Breakdown e={picked.e} onPlanDays={planDays} />
            </>
          ) : (
            <div className="empty">Could not load this option. Re-run the optimization and try again.</div>
          )}
        </div>
      )}

      <SetAside title="Set aside: illustrative prices" note="Not compared with real prices, so they can't win awards." items={result.excluded.illustrative} />
      <SetAside title="Set aside: incomplete pricing" note="At least one component has no price. Totals shown are lower bounds and are never ranked against complete totals." items={result.excluded.incomplete} />
      <SetAside title="Over your hard limit" note="Cheapest options that exceed your hard spending limit." items={result.excluded.overHardLimit} />

      {stats.infeasibleReasons.length > 0 && (
        <details className="group">
          <summary>
            Why {stats.infeasible.toLocaleString()} configurations were ruled out
          </summary>
          <div className="group-body">
            <ul className="notices small">
              {stats.infeasibleReasons.map((r) => (
                <li key={r.reason}>
                  {r.reason} <span className="muted">({r.count.toLocaleString()})</span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
    </div>
  );
}

function Summary({ e }: { e: Evaluation }) {
  return (
    <div className="small">
      <div>
        <b>{e.resortName.replace("Disney's ", "")}</b> · {e.roomName}
      </div>
      <div className="muted">
        {formatShortDate(e.config.arrival)} → {formatShortDate(e.departure)} · {e.config.nights} nights
      </div>
      <div className="muted">
        {e.config.ticketOption ? TICKET_LABEL[e.config.ticketOption] : "No tickets"} · {METHOD_LABEL[e.config.bookingMethod]} ·{" "}
        {DINING_LABEL[e.config.dining]}
      </div>
    </div>
  );
}

function SortTh({ k, sort, setSort, label, right }: { k: SortKey; sort: SortKey; setSort: (k: SortKey) => void; label: string; right?: boolean }) {
  return (
    <th className={`sortable ${right ? "r" : ""}`} onClick={() => setSort(k)} aria-sort={sort === k ? "ascending" : undefined}>
      {label}
      {sort === k ? " ▾" : ""}
    </th>
  );
}

function SetAside({ title, note, items }: { title: string; note: string; items: Evaluation[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <details className="group">
      <summary>
        {title} <span className="chip chip-plain">{items.length}</span>
      </summary>
      <div className="group-body stack">
        <p className="small muted">{note}</p>
        <table className="cmp">
          <tbody>
            {items.map((e) => (
              <Fragment key={e.id}>
                <tr className="result-row" onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {formatShortDate(e.config.arrival)} · {e.config.nights}n
                  </td>
                  <td>
                    {e.resortName.replace("Disney's ", "")} <span className="small muted">{e.roomName}</span>
                  </td>
                  <td className="small">
                    {e.config.ticketOption ? TICKET_LABEL[e.config.ticketOption] : "—"} · {METHOD_LABEL[e.config.bookingMethod]} · {DINING_LABEL[e.config.dining]}
                  </td>
                  <td className="r num">
                    {e.complete ? "" : "≥ "}
                    {formatCents(e.totalCents)}
                  </td>
                  <td>
                    <StatusChip status={e.dataStatus} />
                  </td>
                </tr>
                {open === e.id && (
                  <tr className="detail-row">
                    <td colSpan={5}>
                      <Breakdown e={e} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function DateMatrix({ result, onPick }: { result: OptimizationResult; onPick: (id: string) => void }) {
  const lengths = [...new Set(result.dateMatrix.map((d) => d.nights))].sort((a, b) => a - b);
  const [nights, setNights] = useState(lengths[0] ?? 0);
  const active = lengths.includes(nights) ? nights : (lengths[0] ?? 0);
  const cells = result.dateMatrix.filter((d) => d.nights === active);
  const byArrival = new Map(cells.map((d) => [d.arrival, d]));
  if (cells.length === 0) return null;
  // Shade relative to the cheapest/most expensive arrival for this length of stay (like-for-like).
  const min = Math.min(...cells.map((d) => d.totalCents));
  const max = Math.max(...cells.map((d) => d.totalCents));
  // Calendar weeks (Sun–Sat) spanning the arrival dates.
  const first = cells[0]!.arrival;
  const last = cells[cells.length - 1]!.arrival;
  const start = addDays(first, -dayOfWeek(first));
  const weeks: IsoDate[][] = [];
  for (let d = start; d <= last; d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));

  return (
    <details className="group" open>
      <summary>Flexible dates: cheapest total by arrival date</summary>
      <div className="group-body stack">
        <div className="row">
          {lengths.map((n) => (
            <button key={n} type="button" className={n === active ? "primary" : undefined} onClick={() => setNights(n)}>
              {n} nights
            </button>
          ))}
          <span className="small muted">
            Cheapest {formatCents(min)} · most expensive {formatCents(max)}. Green = cheaper, amber = pricier. Bold = cheapest. Click a date for its full breakdown.
          </span>
        </div>
        <div className="table-wrap">
          <table className="matrix calendar">
            <thead>
              <tr>
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                  <th key={d}>{d}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week) => (
                <tr key={week[0]}>
                  {week.map((date) => {
                    const d = byArrival.get(date);
                    if (!d) {
                      return (
                        <td key={date} className="muted empty-day">
                          <div className="day">{formatDayLabel(date)}</div>
                        </td>
                      );
                    }
                    const t = max === min ? 0 : (d.totalCents - min) / (max - min);
                    return (
                      <td
                        key={date}
                        className={`cell ${d.totalCents === min ? "best" : ""}`}
                        style={{ background: `color-mix(in srgb, var(--warn-soft) ${Math.round(t * 100)}%, var(--good-soft))` }}
                        onClick={() => onPick(d.evaluationId)}
                        title="Show this option's cost breakdown"
                      >
                        <div className="day">{formatDayLabel(date)}</div>
                        {formatCents(d.totalCents).replace(/\.\d\d$/, "")}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

function formatDayLabel(d: IsoDate): string {
  return formatShortDate(d).replace(/^\w+, /, "");
}

function cssId(id: string) {
  return id.replace(/[^a-zA-Z0-9-]/g, "_");
}

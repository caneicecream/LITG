"use client";

import { formatCents } from "@/domain/money";
import { STATUS_LABEL, type PriceStatus } from "@/domain/provenance";
import { formatShortDate } from "@/domain/dates";
import type { Evaluation, PaymentSummary, TicketUsability } from "@/domain/types";
import { StatusChip } from "./ui";

const STATUS_ORDER: PriceStatus[] = ["verified", "manual", "stale", "estimated", "illustrative"];

export function Breakdown({ e }: { e: Evaluation }) {
  const totalAbs = Object.values(e.statusTotals).reduce((a, b) => a + (b ?? 0), 0) || 1;
  return (
    <div className="breakdown">
      <div>
        <table className="lines">
          <tbody>
            {e.lines.map((l) => (
              <tr key={l.key} className={l.includedInQuote ? "included" : l.amountCents === null ? "unavailable" : undefined}>
                <td>
                  <div>{l.label}</div>
                  <div className="calc">{l.calculation}</div>
                  <div className="calc">Source: {l.source}</div>
                </td>
                <td style={{ width: 110 }}>
                  <StatusChip status={l.status} />
                </td>
                <td className="num" style={{ textAlign: "right", width: 110, whiteSpace: "nowrap" }}>
                  {l.amountCents === null ? "Unknown" : l.includedInQuote ? "Included" : formatCents(l.amountCents)}
                </td>
              </tr>
            ))}
            <tr className="total">
              <td>{e.complete ? "Total" : "Total so far (incomplete)"}</td>
              <td>
                <StatusChip status={e.dataStatus} />
              </td>
              <td className="num" style={{ textAlign: "right" }}>
                {e.complete ? "" : "≥ "}
                {formatCents(e.totalCents)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="stack" style={{ gap: 14 }}>
        <div className="stack" style={{ gap: 6 }}>
          <h3>Where the numbers come from</h3>
          <div className="statusbar" aria-label="Share of total by data status">
            {STATUS_ORDER.filter((s) => e.statusTotals[s]).map((s) => (
              <div key={s} className={`sb-${s}`} style={{ width: `${(100 * (e.statusTotals[s] ?? 0)) / totalAbs}%` }} title={`${STATUS_LABEL[s]}: ${formatCents(e.statusTotals[s] ?? 0)}`} />
            ))}
          </div>
          <div className="small muted">
            {STATUS_ORDER.filter((s) => e.statusTotals[s])
              .map((s) => `${STATUS_LABEL[s]} ${formatCents(e.statusTotals[s] ?? 0)}`)
              .join(" · ")}
          </div>
        </div>

        <dl className="kv">
          <dt>Per night</dt>
          <dd className="num">{formatCents(e.perNightCents)}</dd>
          {e.perParkDayCents !== null && (
            <>
              <dt>Per park day</dt>
              <dd className="num">{formatCents(e.perParkDayCents)}</dd>
            </>
          )}
          {e.budget.overTargetCents !== null && (
            <>
              <dt>Vs. target budget</dt>
              <dd className={e.budget.overTargetCents > 0 ? "save-neg" : "save-pos"}>
                {e.budget.overTargetCents > 0 ? `${formatCents(e.budget.overTargetCents)} over` : `${formatCents(-e.budget.overTargetCents)} under`}
              </dd>
            </>
          )}
          {e.otherBookingMethod && (
            <>
              <dt>{e.otherBookingMethod.method === "package" ? "As a package" : "Booked separately"}</dt>
              <dd className="num">
                {e.otherBookingMethod.complete ? "" : "≥ "}
                {formatCents(e.otherBookingMethod.totalCents)} ({formatCents(e.otherBookingMethod.totalCents - e.totalCents, { sign: true })})
              </dd>
            </>
          )}
        </dl>

        {e.ticketUsability && <TicketUsage u={e.ticketUsability} />}
        {e.payment && <Payment p={e.payment} />}

        {e.savings && (
          <div className="stack" style={{ gap: 4 }}>
            <h3>Compared with your preferred plan</h3>
            <p>
              <span className={e.savings.savingsCents > 0 ? "save-pos" : e.savings.savingsCents < 0 ? "save-neg" : undefined}>
                {e.savings.savingsCents > 0
                  ? `${formatCents(e.savings.savingsCents)} less`
                  : e.savings.savingsCents < 0
                    ? `${formatCents(-e.savings.savingsCents)} more`
                    : "Same total"}
              </span>{" "}
              than {formatCents(e.savings.baselineTotalCents)}.
            </p>
            <p className="small muted">{e.savings.basis}.</p>
            {e.savings.switching && (
              <p className="small">
                Your plan is an existing reservation.{" "}
                {e.savings.switching.penaltyCents === null ? (
                  <span className="save-neg">Cancelling it has an unknown cost, so no net saving can be confirmed.</span>
                ) : (
                  <>
                    Cancelling it would cost {formatCents(e.savings.switching.penaltyCents)} today, so the net difference is{" "}
                    <span className={(e.savings.switching.netSavingsCents ?? 0) > 0 ? "save-pos" : "save-neg"}>
                      {(e.savings.switching.netSavingsCents ?? 0) > 0
                        ? `${formatCents(e.savings.switching.netSavingsCents!)} saved`
                        : `${formatCents(-(e.savings.switching.netSavingsCents ?? 0))} lost`}
                    </span>
                    .
                  </>
                )}{" "}
                <span className="muted">{e.savings.switching.note}</span>
              </p>
            )}
            {!e.savings.likeForLike && (
              <p className="small muted">
                Per night:{" "}
                {e.savings.perNightDeltaCents >= 0
                  ? `${formatCents(e.savings.perNightDeltaCents)} less per night`
                  : `${formatCents(-e.savings.perNightDeltaCents)} more per night`}
                .
              </p>
            )}
          </div>
        )}

        {e.differences.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <h3>Differences from your plan</h3>
            <ul className="notices small">
              {e.differences.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </div>
        )}

        {e.appliedPromotion && (
          <div className="stack" style={{ gap: 4 }}>
            <h3>Applied offer</h3>
            <p className="small">
              {e.appliedPromotion.name} <StatusChip status={e.appliedPromotion.status} />
            </p>
            <p className="small muted">{e.appliedPromotion.terms}</p>
          </div>
        )}

        {e.potentialPromotions.length > 0 && (
          <div className="banner banner-info small">
            <div>
              <strong>Possible offers (not included):</strong>
              <ul className="notices">
                {e.potentialPromotions.map((p) => (
                  <li key={p.promotionId}>
                    {p.name}
                    {p.potentialSavingsCents !== null && ` — could save ${formatCents(p.potentialSavingsCents)}`}; {p.unknowns.join("; ")}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {e.missing.length > 0 && (
          <div className="banner banner-error small">
            <div>
              <strong>Missing prices:</strong>
              <ul className="notices">
                {e.missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {e.assumptions.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <h3>Assumptions</h3>
            <ul className="notices small muted">
              {e.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

const USABILITY_TEXT: Record<TicketUsability["status"], string> = {
  ok: "Usable for all park days",
  violated: "Can't cover the park days",
  unknown: "Usage rules not recorded",
};

function TicketUsage({ u }: { u: TicketUsability }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <h3>Ticket usability</h3>
      <p className="small">
        <span className={u.status === "ok" ? "save-pos" : u.status === "violated" ? "save-neg" : undefined}>{USABILITY_TEXT[u.status]}</span>
        {u.usableDays !== null && u.status !== "unknown" ? ` (${u.usableDays} usable days)` : ""}
        {u.source ? <span className="muted"> · rule from {u.source}</span> : null}
      </p>
      {u.reasons.length > 0 && <p className="small save-neg">{u.reasons.join("; ")}</p>}
      {u.unknowns.length > 0 && <p className="small muted">Not recorded: {u.unknowns.join(", ")}. Check the ticket terms before buying.</p>}
      {u.parkReservationRequired && <p className="small">Park reservations are required; availability is not checked here.</p>}
    </div>
  );
}

function Payment({ p }: { p: PaymentSummary }) {
  const c = p.cancellation;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <h3>Payments and cancellation</h3>
      <dl className="kv">
        <dt>Due to book</dt>
        <dd className="num">{p.dueToBookCents === null ? "Unknown (deposit not recorded)" : formatCents(p.dueToBookCents)}</dd>
        {p.paidCents > 0 && (
          <>
            <dt>Paid so far</dt>
            <dd className="num">{formatCents(p.paidCents)}</dd>
            <dt>Balance</dt>
            <dd className="num">{formatCents(p.balanceCents)}</dd>
          </>
        )}
        <dt>Cancelling on {formatShortDate(c.asOf)}</dt>
        <dd>
          {c.penaltyCents === null ? <span className="save-neg">Cost unknown</span> : c.penaltyCents === 0 ? <span className="save-pos">No cost</span> : <span className="save-neg">{formatCents(c.penaltyCents)}</span>}{" "}
          <span className="small muted">{c.note}</span>
        </dd>
      </dl>
      <table className="lines">
        <tbody>
          {p.schedule.map((s, i) => (
            <tr key={i}>
              <td className="small">
                {s.label}
                {s.state !== "upcoming" && <span className={`chip ${s.state === "paid" ? "chip-manual" : "chip-unavailable"}`} style={{ marginLeft: 6 }}>{s.state}</span>}
              </td>
              <td className="small muted">{s.dueDate ? `due ${formatShortDate(s.dueDate)}` : "due at booking / date not recorded"}</td>
              <td className="num small" style={{ textAlign: "right" }}>
                {formatCents(s.amountCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.warnings.length > 0 && <p className="small save-neg">{p.warnings.join(" ")}</p>}
    </div>
  );
}

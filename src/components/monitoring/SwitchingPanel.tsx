"use client";

import { useMemo, useState } from "react";
import { todayIso } from "@/domain/dates";
import { formatCents } from "@/domain/money";
import type { PaymentTerms } from "@/domain/types";
import { analyzeSwitching, type SwitchingAnalysis } from "@/monitoring/switching";
import { MoneyInput } from "../ui";

/**
 * "Is switching worth it?" calculator. Pre-filled from the latest check when a
 * reservation and a cheaper option exist; every figure can be edited. Leave the
 * cancellation cost empty when you don't know it: the result then says so.
 * The arithmetic is the same deterministic function the monitor uses.
 */
export interface SwitchingDefaults {
  originalCents: number | null;
  paidCents: number | null;
  penaltyCents: number | null;
  alternativeCents: number | null;
  depositCents: number | null;
  likeForLike: boolean;
  differences: string[];
  feesCents: number;
  otherNonRefundableCents: number;
  ticketChangeCents: number | null;
  diningChangeCents: number | null;
  minBenefitCents: number;
}

const termsFor = (paid: number | null, penalty: number | null, asOf: string): PaymentTerms => ({
  depositCents: null,
  installments: [],
  ...(paid !== null ? { amountPaidCents: paid } : {}),
  refundability: penalty === null ? "unknown" : "partially_refundable",
  cancellationPenalties: penalty === null ? [] : [{ fromDate: asOf, cents: penalty }],
});

export function SwitchingPanel({ defaults }: { defaults: SwitchingDefaults }) {
  const [v, setV] = useState(defaults);
  const set = <K extends keyof SwitchingDefaults>(k: K, val: SwitchingDefaults[K]) => setV((s) => ({ ...s, [k]: val }));
  const asOf = todayIso();
  const a: SwitchingAnalysis = useMemo(
    () =>
      analyzeSwitching({
        asOf,
        current: { totalCents: v.originalCents, terms: v.originalCents === null ? null : termsFor(v.paidCents, v.penaltyCents, asOf), status: "manual" },
        alternative: {
          totalCents: v.alternativeCents,
          terms: v.depositCents === null ? null : { depositCents: v.depositCents, installments: [], refundability: "unknown", cancellationPenalties: [] },
          status: "manual",
          likeForLike: v.likeForLike,
          differences: v.differences,
        },
        knownFeesCents: v.feesCents,
        otherNonRefundableCents: v.otherNonRefundableCents,
        ticketChangeCents: v.ticketChangeCents,
        diningChangeCents: v.diningChangeCents,
        minBenefitCents: v.minBenefitCents,
      }),
    [v, asOf],
  );
  const money = (c: number | null) => (c === null ? "unknown" : formatCents(c));
  // The calculator states the cancellation cost directly, so describe it in those terms.
  const reasons = [
    ...(v.penaltyCents === null ? [] : [`Cancellation cost today: ${formatCents(v.penaltyCents)}${v.penaltyCents === defaults.penaltyCents ? " (from your reservation's recorded terms)" : " (as you entered it)"}.`]),
    ...a.reasons.filter((r) => !r.startsWith("Cancelling today costs")),
  ];

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className={`verdict verdict-${a.verdict}`}>
        <strong>{a.headline}</strong>
        {a.unknowns.length > 0 && (
          <ul className="notices small">
            {a.unknowns.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="split">
        <table className="cmp">
          <tbody>
            <tr><td>Your reservation</td><td className="r num">{money(a.originalCostCents)}</td></tr>
            <tr><td>Alternative</td><td className="r num">{money(a.newCostCents)}</td></tr>
            <tr><td>Price difference <span className="hint">(not a saving by itself)</span></td><td className="r num">{money(a.priceDifferenceCents)}</td></tr>
            <tr><td>Cancellation cost today</td><td className="r num">{money(a.cancellationPenaltyCents)}</td></tr>
            <tr><td>Fees, other non-refundable, ticket &amp; dining changes</td><td className="r num">{a.ticketChangeCents === null || a.diningChangeCents === null ? "unknown" : formatCents(a.feesCents + a.otherNonRefundableCents + a.ticketChangeCents + a.diningChangeCents)}</td></tr>
            <tr><td><strong>Net difference after switching costs</strong></td><td className="r num"><strong>{money(a.netBenefitCents)}</strong></td></tr>
          </tbody>
        </table>
        <table className="cmp">
          <tbody>
            <tr><td>Paid so far on your reservation</td><td className="r num">{money(a.amountPaidCents)}</td></tr>
            <tr><td>Expected refund if you cancel</td><td className="r num">{money(a.refundCents)}</td></tr>
            <tr><td>Due now for the new booking (deposit + fees)</td><td className="r num">{money(a.dueNowCents)}</td></tr>
            <tr><td>Left to pay on the new booking</td><td className="r num">{money(a.remainingBalanceAfterCents)}</td></tr>
            <tr><td>Left to pay if you keep your reservation</td><td className="r num">{money(a.remainingBalanceIfKeptCents)}</td></tr>
          </tbody>
        </table>
      </div>
      <details>
        <summary className="small">Edit the figures</summary>
        <div className="grid3" style={{ marginTop: 8 }}>
          <Money label="Reservation total" value={v.originalCents} onChange={(c) => set("originalCents", c)} />
          <Money label="Amount paid" value={v.paidCents} onChange={(c) => set("paidCents", c)} />
          <Money label="Cancellation cost today (blank = unknown)" value={v.penaltyCents} onChange={(c) => set("penaltyCents", c)} />
          <Money label="Alternative total" value={v.alternativeCents} onChange={(c) => set("alternativeCents", c)} />
          <Money label="New deposit (blank = unknown)" value={v.depositCents} onChange={(c) => set("depositCents", c)} />
          <Money label="Known switching fees" value={v.feesCents} onChange={(c) => set("feesCents", c ?? 0)} />
          <Money label="Other non-refundable amounts" value={v.otherNonRefundableCents} onChange={(c) => set("otherNonRefundableCents", c ?? 0)} />
          <Money label="Ticket change cost (blank = unknown)" value={v.ticketChangeCents} onChange={(c) => set("ticketChangeCents", c)} />
          <Money label="Dining change cost (blank = unknown)" value={v.diningChangeCents} onChange={(c) => set("diningChangeCents", c)} />
        </div>
        <label className="check" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={v.likeForLike} onChange={(e) => set("likeForLike", e.target.checked)} /> Same trip apart from price (like-for-like)
        </label>
      </details>
      {reasons.length > 0 && (
        <ul className="notices small">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <ul className="notices small muted">
        {a.assumptions.map((r) => (
          <li key={r}>{r}</li>
        ))}
        <li>Nothing is booked, changed or cancelled by this app.</li>
      </ul>
    </div>
  );
}

function Money({ label, value, onChange }: { label: string; value: number | null; onChange: (c: number | null) => void }) {
  return (
    <label className="field">
      {label}
      <MoneyInput value={value ?? undefined} optional placeholder="unknown" onChange={(c) => onChange(c ?? null)} />
    </label>
  );
}

import type { IsoDate } from "../dates";
import { formatCents, percentOf, sumCents, type Cents } from "../money";
import type { PaymentSummary, PaymentTerms } from "../types";

/**
 * Payment schedule and cancellation exposure for a quoted total under the
 * given terms, as of `asOf`. Pure and deterministic. Unknown terms produce
 * nulls, never guesses.
 */
export function summarizePayments(terms: PaymentTerms, totalCents: Cents, asOf: IsoDate): PaymentSummary {
  const warnings: string[] = [];
  const paid = Math.min(terms.amountPaidCents ?? 0, totalCents);
  if ((terms.amountPaidCents ?? 0) > totalCents) warnings.push("Amount paid exceeds the quoted total.");

  // Build the schedule: deposit, installments, then whatever balance remains.
  const items: { dueDate: IsoDate | null; label: string; amountCents: Cents }[] = [];
  if (terms.depositCents !== null) items.push({ dueDate: terms.depositDueDate ?? null, label: "Deposit", amountCents: terms.depositCents });
  for (const i of [...terms.installments].sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))) {
    items.push({ dueDate: i.dueDate, label: i.label ?? "Installment", amountCents: i.amountCents });
  }
  const scheduled = sumCents(items.map((i) => i.amountCents));
  if (scheduled > totalCents) warnings.push(`Scheduled payments (${formatCents(scheduled)}) exceed the total (${formatCents(totalCents)}).`);
  const remainder = totalCents - scheduled;
  if (remainder > 0) {
    items.push({ dueDate: terms.finalPaymentDueDate ?? null, label: "Final balance", amountCents: remainder });
    if (!terms.finalPaymentDueDate) warnings.push("The due date of the remaining balance is not recorded.");
  }

  // Allocate what has been paid to the earliest items.
  let toAllocate = paid;
  const schedule = items.map((i) => {
    const covered = Math.min(toAllocate, i.amountCents);
    toAllocate -= covered;
    const state: PaymentSummary["schedule"][number]["state"] =
      covered >= i.amountCents ? "paid" : i.dueDate !== null && i.dueDate < asOf ? "overdue" : "upcoming";
    return { ...i, state };
  });

  return {
    totalCents,
    paidCents: paid,
    balanceCents: totalCents - paid,
    dueToBookCents: paid > 0 ? 0 : terms.depositCents,
    schedule,
    cancellation: cancellationExposure(terms, totalCents, paid, asOf),
    warnings,
  };
}

/**
 * What cancelling on `asOf` would cost. Rules, in order:
 *   - a penalty tier in effect on `asOf` (latest `fromDate` ≤ asOf) sets the penalty;
 *   - otherwise, a refundable booking inside its free-cancellation window costs 0;
 *   - non-refundable: everything paid is lost (or the full total for an unpaid quote, once paid);
 *   - anything else is unknown (null).
 */
export function cancellationExposure(
  terms: PaymentTerms,
  totalCents: Cents,
  paidCents: Cents,
  asOf: IsoDate,
): PaymentSummary["cancellation"] {
  const base = { asOf, refundability: terms.refundability, freeCancellationUntil: terms.freeCancellationUntil };
  const tier = [...terms.cancellationPenalties]
    .filter((t) => t.fromDate <= asOf)
    .sort((a, b) => (a.fromDate < b.fromDate ? 1 : -1))[0];
  if (tier) {
    const penalty = Math.min(totalCents, tier.cents ?? percentOf(totalCents, tier.pct ?? 0));
    return { ...base, penaltyCents: penalty, note: `Penalty tier from ${tier.fromDate}${tier.note ? ` (${tier.note})` : ""}.` };
  }
  switch (terms.refundability) {
    case "refundable":
      if (!terms.freeCancellationUntil || asOf <= terms.freeCancellationUntil) {
        return { ...base, penaltyCents: 0, note: terms.freeCancellationUntil ? `Free cancellation until ${terms.freeCancellationUntil}.` : "Refundable." };
      }
      return { ...base, penaltyCents: null, note: `Free cancellation ended ${terms.freeCancellationUntil}; the penalty after that is not recorded.` };
    case "non_refundable":
      return paidCents > 0
        ? { ...base, penaltyCents: paidCents, note: "Non-refundable: amounts paid are lost on cancellation." }
        : { ...base, penaltyCents: totalCents, note: "Non-refundable: once paid, the full amount would be lost on cancellation." };
    case "partially_refundable":
      return { ...base, penaltyCents: null, note: "Partially refundable, but no penalty applies to this date in the recorded terms." };
    case "unknown":
      return { ...base, penaltyCents: null, note: "Cancellation terms are not recorded." };
  }
}

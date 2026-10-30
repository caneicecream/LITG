import { daysBetween, type IsoDate } from "@/domain/dates";
import { formatCents, type Cents } from "@/domain/money";
import { cancellationExposure } from "@/domain/pricing/payments";
import type { PriceStatus } from "@/domain/provenance";
import type { PaymentTerms } from "@/domain/types";

/**
 * "Is switching worth it?" Pure, deterministic arithmetic on what is known
 * about the current reservation and the alternative. A lower quoted total is
 * not a saving until the cost of switching is subtracted; when that cost
 * can't be established, no recommendation is made.
 *
 * Sign conventions: all costs are positive amounts; `netBenefitCents` > 0
 * means switching leaves you better off by that much.
 */

export interface SwitchingInput {
  asOf: IsoDate;
  current: {
    /** All-in total of the reservation you hold (null = unknown). */
    totalCents: Cents | null;
    /** Payment and cancellation terms of that reservation (null = not recorded). */
    terms: PaymentTerms | null;
    status: PriceStatus;
  };
  alternative: {
    /** All-in total of the alternative (null = unknown). */
    totalCents: Cents | null;
    /** Terms of the alternative, for its deposit (null = not recorded). */
    terms: PaymentTerms | null;
    status: PriceStatus;
    /** Same configuration as the reservation, apart from price? */
    likeForLike: boolean;
    differences: string[];
  };
  /** Known one-off fees for switching (e.g. a change fee). */
  knownFeesCents: Cents;
  /** Other non-refundable amounts lost by cancelling that the reservation terms don't cover (e.g. separately bought add-ons). */
  otherNonRefundableCents: Cents;
  /** Extra cost (+) or credit (−) for changing tickets that are not part of either total; null = unknown. */
  ticketChangeCents: Cents | null;
  /** Same for dining; null = unknown. */
  diningChangeCents: Cents | null;
  /** Smallest net benefit worth acting on. */
  minBenefitCents: Cents;
}

export type SwitchingVerdict =
  /** Switching leaves you better off by at least your threshold, on known figures. */
  | "worth_considering"
  /** Switching would cost at least as much as it saves. */
  | "not_worth_it"
  /** Figures are known but something needs your judgement (small benefit, different trip, prices to re-check). */
  | "review"
  /** Key information is missing: no reliable recommendation can be made. */
  | "unknown";

export interface SwitchingAnalysis {
  verdict: SwitchingVerdict;
  headline: string;
  originalCostCents: Cents | null;
  newCostCents: Cents | null;
  /** Original − new. NOT a saving by itself. */
  priceDifferenceCents: Cents | null;
  cancellationPenaltyCents: Cents | null;
  feesCents: Cents;
  otherNonRefundableCents: Cents;
  ticketChangeCents: Cents | null;
  diningChangeCents: Cents | null;
  /** Everything switching costs (null when any part is unknown). */
  switchingCostCents: Cents | null;
  /** Price difference − switching cost (null when unknown). */
  netBenefitCents: Cents | null;
  /** Already paid on the reservation (null = not recorded). */
  amountPaidCents: Cents | null;
  /** Expected refund from cancelling: paid − penalty, never below 0 (null = unknown). */
  refundCents: Cents | null;
  /** Cash needed to make the new booking now: its deposit plus known fees (null = deposit unknown). */
  dueNowCents: Cents | null;
  /** What would remain to pay on the new booking after the deposit (null = unknown). */
  remainingBalanceAfterCents: Cents | null;
  /** What remains to pay on the reservation if you keep it (null = unknown). */
  remainingBalanceIfKeptCents: Cents | null;
  freeCancellationUntil: IsoDate | null;
  daysUntilFreeCancellationEnds: number | null;
  /** Why the verdict is what it is. */
  reasons: string[];
  /** Information that is missing. */
  unknowns: string[];
  /** Assumptions the arithmetic relies on. */
  assumptions: string[];
}

const UNRELIABLE: PriceStatus[] = ["illustrative", "unavailable"];

export function analyzeSwitching(i: SwitchingInput): SwitchingAnalysis {
  const unknowns: string[] = [];
  const reasons: string[] = [];
  const assumptions: string[] = [
    "Assumes cancelling the current reservation and booking the alternative separately. Disney can sometimes modify an existing booking or apply a new offer instead; ask before cancelling.",
    "Book the alternative first and confirm its price before cancelling anything.",
  ];

  const orig = i.current.totalCents;
  const alt = i.alternative.totalCents;
  if (orig === null) unknowns.push("The total of your current reservation is not known.");
  if (alt === null) unknowns.push("The alternative's total is not known.");

  // Cancellation cost of the current reservation.
  const terms = i.current.terms;
  const paid = terms?.amountPaidCents ?? null;
  let penalty: Cents | null = null;
  let freeUntil: IsoDate | null = null;
  if (!terms) {
    unknowns.push("Your reservation's payment and cancellation terms are not recorded.");
  } else if (orig !== null) {
    freeUntil = terms.freeCancellationUntil ?? null;
    if (paid === null) assumptions.push("The amount already paid is not recorded; a non-refundable reservation is treated as fully lost.");
    const exposure = cancellationExposure(terms, orig, paid ?? 0, i.asOf);
    penalty = exposure.penaltyCents;
    if (penalty === null) unknowns.push(`The cost of cancelling is unknown: ${exposure.note}`);
    else reasons.push(`Cancelling today costs ${formatCents(penalty)}. ${exposure.note}`);
    if (terms.refundability === "unknown" && penalty === null) unknowns.push("Whether the reservation is refundable is not recorded.");
  }
  if (i.ticketChangeCents === null) unknowns.push("The cost of changing tickets is unknown.");
  if (i.diningChangeCents === null) unknowns.push("The cost of changing dining is unknown.");

  const switching =
    penalty === null || i.ticketChangeCents === null || i.diningChangeCents === null
      ? null
      : penalty + i.knownFeesCents + i.otherNonRefundableCents + i.ticketChangeCents + i.diningChangeCents;
  const diff = orig !== null && alt !== null ? orig - alt : null;
  const net = diff !== null && switching !== null ? diff - switching : null;

  const deposit = i.alternative.terms ? i.alternative.terms.depositCents : null;
  if (deposit === null) assumptions.push("The alternative's deposit is not recorded, so the amount due now is unknown.");

  const refund = paid !== null && penalty !== null ? Math.max(0, paid - penalty) : null;

  // Verdict. Unknowns first: never recommend switching without the cost of switching.
  let verdict: SwitchingVerdict;
  let headline: string;
  const unreliable = [i.current.status, i.alternative.status].find((s) => UNRELIABLE.includes(s));
  if (unreliable) {
    verdict = "unknown";
    headline = "No recommendation: one of the prices is illustrative or unavailable, not a real quote.";
    reasons.push("Switching decisions need real quotes for both the reservation and the alternative.");
  } else if (net === null) {
    verdict = "unknown";
    headline = "No reliable recommendation can be made: key information is missing.";
  } else if (net <= 0) {
    verdict = "not_worth_it";
    headline =
      diff !== null && diff > 0
        ? `Not worth switching: the alternative is ${formatCents(diff)} cheaper, but switching would cost ${formatCents(switching!)}.`
        : "Not worth switching: the alternative is not cheaper.";
  } else if (!i.alternative.likeForLike) {
    verdict = "review";
    headline = `Review: switching would leave ${formatCents(net)} after known costs, but the alternative is a different trip.`;
    reasons.push(`Differences: ${i.alternative.differences.join("; ") || "not like-for-like"}.`);
  } else if (i.alternative.status === "stale" || i.current.status === "stale" || i.alternative.status === "estimated") {
    verdict = "review";
    headline = `Review: ${formatCents(net)} better after known costs, but a price is ${i.alternative.status === "estimated" ? "an estimate" : "stale"}. Re-check before acting.`;
  } else if (net < i.minBenefitCents) {
    verdict = "review";
    headline = `Small benefit: ${formatCents(net)} after known costs, below your ${formatCents(i.minBenefitCents)} threshold.`;
  } else {
    verdict = "worth_considering";
    headline = `Worth considering: switching would leave you ${formatCents(net)} better off after known switching costs.`;
  }

  const daysLeft = freeUntil ? daysBetween(i.asOf, freeUntil) : null;
  if (daysLeft !== null && daysLeft >= 0 && daysLeft <= 14) reasons.push(`Free cancellation ends ${freeUntil} (${daysLeft} day${daysLeft === 1 ? "" : "s"} from now).`);

  return {
    verdict,
    headline,
    originalCostCents: orig,
    newCostCents: alt,
    priceDifferenceCents: diff,
    cancellationPenaltyCents: penalty,
    feesCents: i.knownFeesCents,
    otherNonRefundableCents: i.otherNonRefundableCents,
    ticketChangeCents: i.ticketChangeCents,
    diningChangeCents: i.diningChangeCents,
    switchingCostCents: switching,
    netBenefitCents: net,
    amountPaidCents: paid,
    refundCents: refund,
    dueNowCents: deposit === null ? null : deposit + i.knownFeesCents,
    remainingBalanceAfterCents: alt !== null && deposit !== null ? Math.max(0, alt - deposit) : null,
    remainingBalanceIfKeptCents: orig !== null && paid !== null ? Math.max(0, orig - paid) : null,
    freeCancellationUntil: freeUntil,
    daysUntilFreeCancellationEnds: daysLeft,
    reasons,
    unknowns,
    assumptions,
  };
}

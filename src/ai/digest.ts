import { addDays, daysBetween, formatShortDate } from "@/domain/dates";
import { formatCents, type Cents } from "@/domain/money";
import { DINING_LABEL, TICKET_LABEL } from "@/domain/pricing/calculate";
import { STATUS_LABEL } from "@/domain/provenance";
import type { Evaluation, OptimizationResult, TripRequest } from "@/domain/types";
import type { Fact, RunSummary } from "./types";

/**
 * The facts digest: everything the assistant may say about money, derived
 * deterministically from an OptimizationResult. The model explains these facts;
 * it never computes. Differences it might want to mention (vs the previous run,
 * between variants, between arrival dates) are precomputed here.
 */

const METHOD = { separate: "room + tickets separately", package: "Disney package", points: "DVC points" } as const;

export function optionLabel(e: Evaluation): string {
  const c = e.config;
  return `${e.resortName.replace("Disney's ", "")} (${e.roomName}), ${formatShortDate(c.arrival)} → ${formatShortDate(e.departure)} (${c.nights} nights), ${c.ticketOption ? TICKET_LABEL[c.ticketOption] : "no tickets"}, ${METHOD[c.bookingMethod]}, ${DINING_LABEL[c.dining]}`;
}

const find = (r: OptimizationResult, kind: string) => {
  const id = r.awards.find((a) => a.kind === kind)?.evaluationId;
  return id ? r.ranked.find((e) => e.id === id) : undefined;
};

export function summarizeRun(r: OptimizationResult): RunSummary {
  const cheapest = find(r, "cheapest") ?? (r.ranked.length === 1 ? r.ranked[0] : undefined);
  const bestValue = find(r, "best_value");
  const alt = find(r, "best_alternative");
  return {
    runAt: r.runAt,
    demoMode: r.demoMode,
    comparable: r.stats.comparable,
    cheapest: cheapest ? { id: cheapest.id, label: optionLabel(cheapest), totalCents: cheapest.totalCents, perNightCents: cheapest.perNightCents, dataStatus: cheapest.dataStatus } : null,
    bestValue: bestValue ? { id: bestValue.id, label: optionLabel(bestValue), totalCents: bestValue.totalCents, score: bestValue.valueScore?.total ?? null } : null,
    bestAlternative: alt?.savings ? { id: alt.id, label: optionLabel(alt), totalCents: alt.totalCents, savingsCents: alt.savings.savingsCents } : null,
    baselineTotalCents: r.baseline?.complete ? r.baseline.totalCents : null,
  };
}

/** "$X less than <what>", "$X more than <what>" or "the same as <what>". */
const vs = (from: Cents, to: Cents, what: string) =>
  to === from ? `the same as ${what}` : to < from ? `${formatCents(from - to)} less than ${what}` : `${formatCents(to - from)} more than ${what}`;

export interface DigestInput {
  result: OptimizationResult;
  request: TripRequest;
  previous?: RunSummary | null;
  variants?: { label: string; summary: RunSummary | null; error?: string }[];
  /** Recorded price history and switching facts (see history.ts). */
  history?: string[];
}

export function buildDigest({ result: r, request, previous, variants, history }: DigestInput): Fact[] {
  const texts: string[] = [];
  const add = (t: string) => texts.push(t);

  // Data basis
  if (r.demoMode) add("These results use ILLUSTRATIVE demo prices. They demonstrate the optimizer and are not real offers or bookable prices.");
  else if (r.ranked.length > 0) add("These results are based on prices you entered (manually entered quotes or rates), plus clearly labelled estimates such as taxes.");
  if (r.ranked.length === 0) add("No option could be fully priced and compared with the current requirements and price data.");

  // Awards
  const cheapest = find(r, "cheapest");
  const bestValue = find(r, "best_value");
  const alt = find(r, "best_alternative");
  for (const [kind, e] of [
    ["Cheapest option", cheapest],
    ["Best-value option", bestValue],
    ["Best alternative to your preferred plan", alt],
  ] as const) {
    if (!e) continue;
    add(`${kind}: ${optionLabel(e)}. Total ${formatCents(e.totalCents)} (${formatCents(e.perNightCents)} per night). Data: ${STATUS_LABEL[e.dataStatus]}.`);
    const award = r.awards.find((a) => a.evaluationId === e.id && a.kind === { "Cheapest option": "cheapest", "Best-value option": "best_value", "Best alternative to your preferred plan": "best_alternative" }[kind]);
    if (award) add(`Optimizer's reasoning for "${kind}": ${award.explanation.join(" ")}`);
  }
  if (!cheapest && r.ranked.length === 1) {
    const e = r.ranked[0]!;
    add(`Only one option is fully priced: ${optionLabel(e)}, total ${formatCents(e.totalCents)}. There is nothing to compare it against yet.`);
  }
  if (bestValue?.valueScore) {
    add(`Best-value score ${bestValue.valueScore.total}/100 from: ${bestValue.valueScore.parts.filter((p) => p.weightPct > 0).map((p) => `${p.label} ${p.score}/100 (weight ${p.weightPct}%)`).join(", ")}.`);
  }

  // Baseline
  if (r.baseline) {
    add(
      r.baseline.complete
        ? `Your preferred plan: ${optionLabel(r.baseline)}, total ${formatCents(r.baseline.totalCents)}.`
        : `Your preferred plan (${optionLabel(r.baseline)}) could not be fully priced; missing: ${r.baseline.missing.join("; ")}.`,
    );
  }
  if (r.baselineNote) add(r.baselineNote);

  // Top ranked options
  r.ranked.slice(0, 5).forEach((e, i) => {
    const s = e.savings;
    add(
      `Ranked #${i + 1}: ${optionLabel(e)} — ${formatCents(e.totalCents)}` +
        (s ? `; vs your preferred plan: ${s.savingsCents >= 0 ? `${formatCents(s.savingsCents)} less` : `${formatCents(-s.savingsCents)} more`}${s.likeForLike ? " (like-for-like)" : " (not like-for-like: " + s.basis.replace(/^Not like-for-like \(/, "").replace(/\).*$/, "") + ")"}` : "") +
        (e.budget.overTargetCents !== null ? `; ${e.budget.overTargetCents > 0 ? `${formatCents(e.budget.overTargetCents)} over` : `${formatCents(-e.budget.overTargetCents)} under`} your budget target` : "") +
        ".",
    );
  });

  // Cost breakdown and conditions of the leading option
  const lead = cheapest ?? r.ranked[0];
  if (lead) {
    add(
      `Cost breakdown of ${cheapest ? "the cheapest" : "the top"} option: ` +
        lead.lines
          .filter((l) => l.amountCents !== 0 || l.includedInQuote)
          .map((l) => `${l.label} ${l.includedInQuote ? "included" : l.amountCents === null ? "unknown" : formatCents(l.amountCents)} [${STATUS_LABEL[l.status]}]`)
          .join("; ") +
        ".",
    );
    if (lead.appliedPromotion) add(`Applied offer on that option: ${lead.appliedPromotion.name}, saving ${formatCents(lead.appliedPromotion.savingsCents)}. Terms: ${lead.appliedPromotion.terms}`);
    for (const p of lead.potentialPromotions) {
      add(`Possible offer NOT included in any total: ${p.name}${p.potentialSavingsCents !== null ? ` (could save ${formatCents(p.potentialSavingsCents)})` : ""}; ${p.unknowns.join("; ")}.`);
    }
    if (lead.ticketUsability && lead.ticketUsability.status !== "ok") {
      add(`Ticket usability for that option: ${lead.ticketUsability.status === "unknown" ? `usage rules not recorded (${lead.ticketUsability.unknowns.join(", ")})` : lead.ticketUsability.reasons.join("; ")}.`);
    }
    if (lead.payment) {
      const c = lead.payment.cancellation;
      add(
        `Payment terms for that option: ${lead.payment.dueToBookCents === null ? "deposit not recorded" : `${formatCents(lead.payment.dueToBookCents)} due to book`}; cancelling on ${c.asOf} would cost ${c.penaltyCents === null ? "an unknown amount" : formatCents(c.penaltyCents)} (${c.note})`,
      );
    }
    for (const a of lead.assumptions.slice(0, 4)) add(`Assumption: ${a}`);
  }

  // Flexible dates around the preferred arrival
  const nights = request.preferred.nights ?? lead?.config.nights;
  const center = request.preferred.arrival ?? lead?.config.arrival;
  if (nights && center) {
    const cells = r.dateMatrix.filter((d) => d.nights === nights);
    const centerCell = cells.find((d) => d.arrival === center);
    const near = cells.filter((d) => Math.abs(daysBetween(center, d.arrival)) <= 3 && d.arrival !== center);
    for (const d of near) {
      const diff = daysBetween(center, d.arrival);
      add(
        `Arriving ${formatShortDate(d.arrival)} (${Math.abs(diff)} day${Math.abs(diff) === 1 ? "" : "s"} ${diff < 0 ? "earlier" : "later"}) for ${nights} nights: cheapest ${formatCents(d.totalCents)}` +
          (centerCell ? `, ${vs(centerCell.totalCents, d.totalCents, `arriving ${formatShortDate(center)} (${formatCents(centerCell.totalCents)})`)}` : "") +
          ".",
      );
    }
    const best = [...cells].sort((a, b) => a.totalCents - b.totalCents)[0];
    if (best) add(`Cheapest arrival for ${nights} nights in the date window: ${formatShortDate(best.arrival)} (departing ${formatShortDate(addDays(best.arrival, nights))}), ${formatCents(best.totalCents)}.`);
  }
  for (const n of [...new Set(r.dateMatrix.map((d) => d.nights))].sort((a, b) => a - b)) {
    const best = r.dateMatrix.filter((d) => d.nights === n).sort((a, b) => a.totalCents - b.totalCents)[0]!;
    add(`Cheapest ${n}-night option: ${formatCents(best.totalCents)}, arriving ${formatShortDate(best.arrival)}.`);
  }

  // Exclusions and what's missing
  if (r.excluded.illustrative.length) add(`Options priced with illustrative data were set aside and are not compared with your real prices.`);
  for (const e of r.excluded.incomplete.slice(0, 3)) add(`Not ranked (incomplete pricing): ${optionLabel(e)}; missing: ${e.missing.join("; ")}.`);
  if (r.excluded.overHardLimit[0]) add(`Cheapest option over your hard limit: ${optionLabel(r.excluded.overHardLimit[0])} at ${formatCents(r.excluded.overHardLimit[0].totalCents)}.`);
  for (const x of r.stats.infeasibleReasons.slice(0, 3)) add(`Ruled out ${x.count.toLocaleString()} configuration(s): ${x.reason}.`);
  for (const n of r.notices) add(`Optimizer notice: ${n}`);

  // Changes since the previous run
  if (previous) {
    const now = summarizeRun(r);
    if (previous.cheapest && now.cheapest) add(`Before this change the cheapest option was ${formatCents(previous.cheapest.totalCents)} (${previous.cheapest.label}); now it is ${formatCents(now.cheapest.totalCents)}, ${vs(previous.cheapest.totalCents, now.cheapest.totalCents, "before")}.`);
    if (previous.bestValue && now.bestValue) add(`Before this change the best-value option was ${formatCents(previous.bestValue.totalCents)}; now it is ${formatCents(now.bestValue.totalCents)} (${vs(previous.bestValue.totalCents, now.bestValue.totalCents, "before")}).`);
    if (previous.baselineTotalCents !== null && now.baselineTotalCents !== null) add(`Your preferred plan was ${formatCents(previous.baselineTotalCents)} before this change and is ${formatCents(now.baselineTotalCents)} now (${vs(previous.baselineTotalCents, now.baselineTotalCents, "before")}).`);
    if (previous.demoMode !== now.demoMode) add(`The previous results were ${previous.demoMode ? "illustrative" : "based on real prices"} and these are ${now.demoMode ? "illustrative" : "based on real prices"}, so the two are not directly comparable.`);
  }

  // Side-by-side variants
  const main = summarizeRun(r);
  for (const v of variants ?? []) {
    if (!v.summary) {
      add(`Comparison "${v.label}" could not be run: ${v.error ?? "invalid request"}.`);
      continue;
    }
    const s = v.summary;
    if (s.cheapest) {
      add(
        `Comparison "${v.label}": cheapest ${formatCents(s.cheapest.totalCents)} (${s.cheapest.label})` +
          (main.cheapest ? `, ${vs(main.cheapest.totalCents, s.cheapest.totalCents, `the main plan's cheapest (${formatCents(main.cheapest.totalCents)})`)}` : "") +
          (s.demoMode !== main.demoMode ? ". Note: one of these uses illustrative prices, so they are not directly comparable" : "") +
          ".",
      );
    } else add(`Comparison "${v.label}": no option could be fully priced.`);
    if (s.bestValue) add(`Comparison "${v.label}": best value ${formatCents(s.bestValue.totalCents)}${s.bestValue.score !== null ? ` (score ${s.bestValue.score}/100)` : ""} — ${s.bestValue.label}.`);
  }

  for (const h of history ?? []) add(h);

  return texts.map((text, i) => ({ id: `F${i + 1}`, text }));
}

import { formatShortDate, todayIso } from "@/domain/dates";
import { formatCents } from "@/domain/money";
import { STATUS_LABEL } from "@/domain/provenance";
import { baselineConfiguration } from "@/domain/optimizer/optimize";
import type { OptimizationResult, PriceData, TripRequest } from "@/domain/types";
import { buildSnapshot } from "@/monitoring/detect";
import { configKey, fingerprint } from "@/monitoring/fingerprint";
import type { ObservationRecord } from "@/monitoring/observations";
import { buildSeries, seriesSeparationNotes, type PriceSeries } from "@/monitoring/series";
import { defaultMonitorSettings, type MonitorSettings } from "@/monitoring/types";

/**
 * Facts about recorded price history and switching costs for the assistant.
 * Deterministic: built from stored observations and the same switching
 * arithmetic the monitor uses. Every amount and percentage the assistant may
 * mention is stated here, so the grounding check can verify it.
 */

const seriesName = (s: PriceSeries) => `${s.taxTreatment === "all_in" ? "totals including tax" : "totals before tax"}${s.evidence === "estimated" ? ", your estimates" : ""}`;

export function historyFacts(input: {
  request: TripRequest;
  result: OptimizationResult;
  data: PriceData;
  observations: ObservationRecord[];
  settings?: MonitorSettings;
}): string[] {
  const out: string[] = [];
  const add = (t: string) => out.push(t);
  const settings = input.settings ?? defaultMonitorSettings();
  const today = input.result.today ?? todayIso();
  const base = baselineConfiguration(input.request);
  if (!("config" in base)) {
    add("Price history: your preferred plan is not fully specified (arrival, nights, resort, room and tickets), so there is no exact configuration to report a price history for.");
    return out;
  }
  const fp = fingerprint(configKey(base.config, input.request));
  const series = buildSeries(
    input.observations.filter((o) => o.fingerprint === fp),
    today,
    settings.staleAfterDays,
  );
  const label = input.result.baseline ? "your preferred plan's exact configuration" : "your preferred configuration";
  if (series.length === 0) {
    add(`Price history: no quote has been recorded for ${label}, so there is no price history to report. Recorded history starts when you enter or re-check a quote for exactly this configuration.`);
  }
  for (const s of series) {
    const name = seriesName(s);
    add(
      `Price history (${name}) for ${label}: ${s.points.length} recorded observation${s.points.length === 1 ? "" : "s"} from ${formatShortDate(s.points[0]!.observedOn)} to ${formatShortDate(s.latest.observedOn)}. Latest: ${formatCents(s.latest.valueCents)} observed ${formatShortDate(s.latest.observedOn)} (${s.latest.source}, ${STATUS_LABEL[s.latest.effectiveStatus]}).`,
    );
    if (s.previous) {
      add(
        `Price history (${name}): the previous observation was ${formatCents(s.previous.valueCents)} on ${formatShortDate(s.previous.observedOn)} (${s.previous.source}); the latest is ${s.changeCents === 0 ? "the same" : `${formatCents(Math.abs(s.changeCents!))} ${s.changeCents! < 0 ? "lower" : "higher"}`}${s.changePct !== null && s.changeCents !== 0 ? ` (${s.changePct > 0 ? "+" : ""}${s.changePct}%)` : ""}.`,
      );
      add(`Price history (${name}): lowest recorded ${formatCents(s.lowest.valueCents)} on ${formatShortDate(s.lowest.observedOn)} (${s.lowest.source}); highest recorded ${formatCents(s.highest.valueCents)} on ${formatShortDate(s.highest.observedOn)}.`);
    } else if (s.insufficientReason) {
      add(`Price history (${name}): ${s.insufficientReason}`);
    }
    add(
      `Price history (${name}): the latest observation is ${s.ageDays} day${s.ageDays === 1 ? "" : "s"} old${s.stale ? `, older than ${settings.staleAfterDays} days, so it is stale and should be re-checked before relying on it` : ""}. Recorded observations are not live prices.`,
    );
  }
  for (const n of seriesSeparationNotes(series)) add(`Price history: ${n}`);

  // Switching analysis against a booked reservation, using the monitor's arithmetic.
  const snap = buildSnapshot({
    result: input.result,
    request: input.request,
    quotes: input.data.stayQuotes,
    checkedAt: new Date().toISOString(),
    requestHash: "",
    dataHash: "",
    engineVersion: "",
    catalogHash: "",
    settings,
    newObservations: [],
  });
  const alt = snap.bestAlternative;
  if (!snap.reservation) {
    add(
      `Switching analysis: no booked reservation is recorded for your preferred plan, so there are no cancellation or switching costs to consider${alt?.likeForLike ? `; the cheapest like-for-like option (${alt.label}) is simply ${formatCents(alt.savingsCents)} less than your plan` : ""}.`,
    );
  } else if (!snap.switching) {
    add(`Switching analysis: you hold a reservation for your preferred plan (${formatCents(snap.reservation.totalCents)}), and no cheaper option was found in the current results.`);
  } else {
    const a = snap.switching;
    const known = (c: number | null) => (c === null ? "unknown" : formatCents(c));
    add(`Switching analysis: ${a.headline}`);
    add(
      `Switching analysis figures: your reservation ${known(a.originalCostCents)}; alternative (${alt!.label}) ${known(a.newCostCents)}; price difference ${known(a.priceDifferenceCents)} (not a saving by itself); cancellation cost today ${known(a.cancellationPenaltyCents)}; total switching cost ${known(a.switchingCostCents)}; net difference after switching costs ${known(a.netBenefitCents)}.`,
    );
    add(
      `Switching analysis cash flow: paid so far ${known(a.amountPaidCents)}; expected refund ${known(a.refundCents)}; due now for the new booking ${known(a.dueNowCents)}; left to pay on the new booking ${known(a.remainingBalanceAfterCents)}.`,
    );
    for (const u of a.unknowns) add(`Switching analysis unknown: ${u}`);
    add("Switching analysis: nothing is booked, changed or cancelled by the app; book the alternative and confirm its price before cancelling anything.");
  }
  return out;
}

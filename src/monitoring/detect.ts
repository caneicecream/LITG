import { daysBetween, type IsoDate } from "@/domain/dates";
import { formatCents } from "@/domain/money";
import { STATUS_LABEL } from "@/domain/provenance";
import type { Evaluation, OptimizationResult, StayQuote, TripRequest } from "@/domain/types";
import { optionLabel } from "@/ai/digest";
import { configKey, fingerprint } from "./fingerprint";
import { pctChange } from "./series";
import { analyzeSwitching } from "./switching";
import type { CheckSnapshot, EvalSummary, MonitorEvent, MonitorSettings } from "./types";

/**
 * Change detection between two monitor checks. Pure: given the previous and
 * current snapshots, it classifies what changed and why. A total that moved is
 * only called a price change when new price data caused it, and only between
 * equivalent configurations; everything else is labelled for what it is
 * (a configuration change, a recalculation, a source update).
 */

export function summarizeEvaluation(e: Evaluation, req: TripRequest): EvalSummary {
  return {
    evaluationId: e.id,
    label: optionLabel(e),
    fingerprint: fingerprint(configKey(e.config, req)),
    totalCents: e.totalCents,
    complete: e.complete,
    missing: e.missing,
    dataStatus: e.dataStatus,
    containsIllustrative: e.containsIllustrative,
    quoteId: e.quoteId,
    promotion: e.appliedPromotion ? { id: e.appliedPromotion.promotionId, name: e.appliedPromotion.name, savingsCents: e.appliedPromotion.savingsCents } : null,
    potentialPromotions: e.potentialPromotions.map((p) => ({ id: p.promotionId, name: p.name })),
    lines: e.lines.map((l) => ({ key: l.key, label: l.label, amountCents: l.amountCents, status: l.status, source: l.source })),
    terms: null,
  };
}

export interface SnapshotInput {
  result: OptimizationResult;
  request: TripRequest;
  quotes: StayQuote[];
  checkedAt: string;
  requestHash: string;
  dataHash: string;
  engineVersion: string;
  catalogHash: string;
  settings: MonitorSettings;
  newObservations: CheckSnapshot["newObservations"];
  adapters?: CheckSnapshot["adapters"];
}

export function buildSnapshot(i: SnapshotInput): CheckSnapshot {
  const r = i.result;
  const quoteById = new Map(i.quotes.map((q) => [q.id, q]));
  const withTerms = (e: Evaluation): EvalSummary => ({ ...summarizeEvaluation(e, i.request), terms: (e.quoteId && quoteById.get(e.quoteId)?.terms) || null });
  const find = (kind: string) => {
    const id = r.awards.find((a) => a.kind === kind)?.evaluationId;
    return id ? r.ranked.find((e) => e.id === id) : undefined;
  };
  const tracked = r.baseline ? withTerms(r.baseline) : null;
  const bookedQuote = r.baseline?.quoteId ? quoteById.get(r.baseline.quoteId) : undefined;
  const reservation =
    r.baseline && bookedQuote?.booked && r.baseline.complete
      ? { quoteId: bookedQuote.id, totalCents: r.baseline.totalCents, terms: bookedQuote.terms ?? null, status: r.baseline.dataStatus }
      : null;
  // The cheapest like-for-like option below the plan (the "best alternative" award is omitted when it is also the cheapest).
  const altEval =
    find("best_alternative") ??
    r.ranked
      .filter((e) => e.savings && e.savings.likeForLike && e.savings.savingsCents > 0)
      .reduce<Evaluation | undefined>((best, e) => (!best || e.totalCents < best.totalCents ? e : best), undefined);
  const bestAlternative =
    altEval?.savings && altEval.savings.likeForLike
      ? { ...withTerms(altEval), savingsCents: altEval.savings.savingsCents, likeForLike: true, differences: altEval.differences }
      : altEval?.savings
        ? { ...withTerms(altEval), savingsCents: altEval.savings.savingsCents, likeForLike: false, differences: altEval.differences }
        : null;
  const cheapestEval = find("cheapest");
  const s = i.settings;
  const switching =
    reservation && bestAlternative
      ? analyzeSwitching({
          asOf: r.today,
          current: { totalCents: reservation.totalCents, terms: reservation.terms, status: reservation.status },
          alternative: {
            totalCents: bestAlternative.totalCents,
            terms: bestAlternative.terms,
            status: bestAlternative.dataStatus,
            likeForLike: bestAlternative.likeForLike,
            differences: bestAlternative.differences,
          },
          knownFeesCents: s.knownSwitchingFeesCents,
          otherNonRefundableCents: s.otherNonRefundableCents,
          ticketChangeCents: s.ticketChangeCents,
          diningChangeCents: s.diningChangeCents,
          minBenefitCents: s.minSavingsCents,
        })
      : null;
  return {
    version: 1,
    checkedAt: i.checkedAt,
    today: r.today,
    requestHash: i.requestHash,
    dataHash: i.dataHash,
    engineVersion: i.engineVersion,
    catalogHash: i.catalogHash,
    demoMode: r.demoMode,
    tracked,
    trackedNote: r.baseline ? null : (r.baselineNote ?? "Your preferred plan is not fully specified, so there is no configuration to track."),
    reservation,
    bestAlternative,
    cheapest: cheapestEval ? withTerms(cheapestEval) : null,
    switching,
    newObservations: i.newObservations,
    adapters: i.adapters ?? [],
  };
}

const fmtPct = (p: number | null) => (p === null ? "" : ` (${p > 0 ? "+" : ""}${p}%)`);

/** Lines whose amount changed between two evaluations of the same configuration. */
function changedLines(a: EvalSummary, b: EvalSummary): string[] {
  const out: string[] = [];
  const before = new Map(a.lines.map((l) => [l.key, l]));
  for (const l of b.lines) {
    const p = before.get(l.key);
    if (!p) {
      if (l.amountCents) out.push(`${l.label}: new line ${formatCents(l.amountCents)} (${l.source})`);
      continue;
    }
    if (p.amountCents !== l.amountCents) {
      out.push(`${l.label}: ${p.amountCents === null ? "unpriced" : formatCents(p.amountCents)} → ${l.amountCents === null ? "unpriced" : formatCents(l.amountCents)} (${l.source})`);
    }
  }
  for (const p of a.lines) if (!b.lines.some((l) => l.key === p.key) && p.amountCents) out.push(`${p.label}: no longer charged (was ${formatCents(p.amountCents)})`);
  return out;
}

function provenanceChanges(a: EvalSummary, b: EvalSummary): { status: string[]; source: string[] } {
  const status: string[] = [];
  const source: string[] = [];
  const before = new Map(a.lines.map((l) => [l.key, l]));
  for (const l of b.lines) {
    const p = before.get(l.key);
    if (!p || p.amountCents !== l.amountCents) continue;
    if (p.status !== l.status) status.push(`${l.label}: ${STATUS_LABEL[p.status]} → ${STATUS_LABEL[l.status]}`);
    else if (p.source !== l.source) source.push(`${l.label}: ${p.source} → ${l.source}`);
  }
  return { status, source };
}

export interface DetectContext {
  monitorId: string;
  settings: MonitorSettings;
}

export function detectEvents(prev: CheckSnapshot | null, cur: CheckSnapshot, ctx: DetectContext): MonitorEvent[] {
  const s = ctx.settings;
  const k = (...parts: (string | number)[]) => [ctx.monitorId, ...parts].join(":");
  const events: MonitorEvent[] = [];
  const t = cur.tracked;
  const p = prev?.tracked ?? null;

  if (!prev) {
    events.push({
      type: "first_check",
      severity: "info",
      title: "Monitoring started",
      detail: t?.complete
        ? `First check: your plan totals ${formatCents(t.totalCents)} with the prices stored today. Later checks are compared with this one.`
        : `First check. ${t ? `Your plan is missing prices: ${t.missing.join(", ")}.` : (cur.trackedNote ?? "")}`,
      notify: false,
      dedupeKey: k("first", cur.checkedAt),
      evidence: [],
    });
  }

  // ── The tracked configuration ──
  if (prev && p && t) {
    if (p.fingerprint !== t.fingerprint || prev.requestHash !== cur.requestHash) {
      events.push({
        type: "configuration_changed",
        severity: "info",
        title: "Trip settings changed",
        detail:
          p.fingerprint !== t.fingerprint
            ? `The tracked plan changed from "${p.label}" to "${t.label}". Totals before and after are not compared as a price change.`
            : "The saved trip's settings changed since the last check, so a change in the total is not treated as a price change.",
        notify: false,
        dedupeKey: k("config", cur.requestHash),
        evidence: [],
      });
    } else if (p.complete && t.complete && p.containsIllustrative === t.containsIllustrative) {
      const delta = t.totalCents - p.totalCents;
      const pct = pctChange(p.totalCents, t.totalCents);
      const dataChanged = prev.dataHash !== cur.dataHash;
      const lines = changedLines(p, t);
      if (delta !== 0 && dataChanged) {
        const up = delta > 0;
        const meets = Math.abs(delta) >= s.minChangeCents || (s.minChangePct > 0 && pct !== null && Math.abs(pct) >= s.minChangePct);
        events.push({
          type: up ? "price_increase" : "price_decrease",
          severity: meets ? "important" : "notice",
          title: `${up ? "Price up" : "Price down"} ${formatCents(Math.abs(delta))}${fmtPct(pct)}`,
          detail: `Your plan now totals ${formatCents(t.totalCents)} (was ${formatCents(p.totalCents)}), because of new or updated price data. Same configuration: ${t.label}.${t.dataStatus === "stale" ? " Some prices are stale." : ""}`,
          deltaCents: delta,
          deltaPct: pct,
          notify: meets && (up ? s.notifyOn.increases : s.notifyOn.decreases),
          dedupeKey: k("total", t.fingerprint, t.totalCents, cur.dataHash),
          evidence: lines,
        });
      } else if (delta !== 0) {
        const why =
          prev.engineVersion !== cur.engineVersion || prev.catalogHash !== cur.catalogHash
            ? "the calculation rules or reference data (taxes, catalog) were updated"
            : "date-dependent rules changed (for example a promotion's booking window or the staleness of a price)";
        events.push({
          type: "recalculated",
          severity: "info",
          title: `Total recalculated: ${formatCents(delta, { sign: true })}`,
          detail: `No new price was recorded; the total moved because ${why}. This is not a change in Disney's price.`,
          deltaCents: delta,
          deltaPct: pct,
          notify: false,
          dedupeKey: k("recalc", t.totalCents, cur.engineVersion, cur.catalogHash, cur.today),
          evidence: lines,
        });
      } else if (dataChanged) {
        const pc = provenanceChanges(p, t);
        if (pc.status.length) {
          events.push({
            type: "provenance_changed",
            severity: "info",
            title: "Price status changed",
            detail: "The total is unchanged, but the status of some prices changed.",
            notify: false,
            dedupeKey: k("prov", cur.dataHash),
            evidence: pc.status,
          });
        }
        if (pc.source.length) {
          events.push({
            type: "price_confirmed",
            severity: "info",
            title: "Price confirmed",
            detail: `A newer observation confirmed the same total (${formatCents(t.totalCents)}).`,
            notify: false,
            dedupeKey: k("confirm", cur.dataHash),
            evidence: pc.source,
          });
        }
      }
    } else if (p.complete && t.complete) {
      events.push({
        type: "provenance_changed",
        severity: "info",
        title: "Not comparable with the last check",
        detail: `The last check ${p.containsIllustrative ? "used" : "did not use"} illustrative demo prices and this one ${t.containsIllustrative ? "does" : "doesn't"}, so the totals are not compared.`,
        notify: false,
        dedupeKey: k("illus", cur.dataHash),
        evidence: [],
      });
    }

    // Promotions on the tracked plan.
    if (p.fingerprint === t.fingerprint) {
      if (t.promotion && t.promotion.id !== p.promotion?.id) {
        events.push({
          type: "promotion_applied",
          severity: "notice",
          title: `Promotion now applies: ${t.promotion.name}`,
          detail: `${t.promotion.name} reduces your plan by ${formatCents(t.promotion.savingsCents)}. Check the offer's terms before relying on it.`,
          notify: s.notifyOn.promotions,
          dedupeKey: k("promo+", t.promotion.id, t.fingerprint),
          evidence: [],
        });
      }
      if (p.promotion && p.promotion.id !== t.promotion?.id) {
        events.push({
          type: "promotion_ended",
          severity: "notice",
          title: `Promotion no longer applies: ${p.promotion.name}`,
          detail: "It expired, was removed, or its conditions are no longer met for this plan.",
          notify: s.notifyOn.promotions,
          dedupeKey: k("promo-", p.promotion.id, t.fingerprint, cur.checkedAt.slice(0, 10)),
          evidence: [],
        });
      }
      for (const pp of t.potentialPromotions.filter((x) => !p.potentialPromotions.some((y) => y.id === x.id))) {
        events.push({
          type: "promotion_possible",
          severity: "info",
          title: `Possible promotion: ${pp.name}`,
          detail: "You may be eligible, but eligibility isn't confirmed, so it isn't applied.",
          notify: s.notifyOn.promotions,
          dedupeKey: k("promo?", pp.id, t.fingerprint),
          evidence: [],
        });
      }
    }
  }

  // Missing / newly available prices.
  if (t && !t.complete && (!p || p.complete || p.fingerprint !== t.fingerprint)) {
    events.push({
      type: "price_missing",
      severity: "notice",
      title: "Your plan can't be fully priced",
      detail: `Missing: ${t.missing.join(", ")}. Add or re-check a quote for this configuration.`,
      notify: !!prev && s.notifyOn.missing,
      dedupeKey: k("missing", t.fingerprint, t.missing.join(",")),
      evidence: [],
    });
  }
  if (prev && p && t && !p.complete && t.complete && p.fingerprint === t.fingerprint) {
    events.push({
      type: "price_available",
      severity: "notice",
      title: "Your plan is now fully priced",
      detail: `Total ${formatCents(t.totalCents)}.`,
      notify: s.notifyOn.newQuotes,
      dedupeKey: k("available", t.fingerprint, cur.dataHash),
      evidence: [],
    });
  }

  // Stale evidence.
  if (t?.dataStatus === "stale") {
    // Lines covered by a package quote ($0 here) are represented by the quote's own line.
    const staleLines = t.lines.filter((l) => l.status === "stale" && l.amountCents !== 0);
    events.push({
      type: "stale",
      severity: "notice",
      title: "Prices need re-checking",
      detail: `Some prices behind your plan are older than your staleness setting. A stored price is not a current price: re-check ${staleLines.map((l) => l.label).join(", ") || "them"}.`,
      notify: s.notifyOn.stale,
      dedupeKey: k("stale", t.fingerprint, cur.dataHash),
      evidence: staleLines.map((l) => `${l.label}: ${l.source}`),
    });
  }

  // New observations of the same configuration (other than the one now pricing the plan).
  for (const o of cur.newObservations) {
    if (t && o.entryId === t.quoteId) continue;
    events.push({
      type: "new_comparable_quote",
      severity: "notice",
      title: "New quote for the same configuration",
      detail: `${o.valueCents === null ? "A quote" : formatCents(o.valueCents)} observed ${o.observedOn} (${o.source}, ${o.status})${o.taxTreatment === "pre_tax" ? "; it excludes tax, so it is not directly comparable with tax-inclusive totals" : ""}.`,
      notify: s.notifyOn.newQuotes,
      dedupeKey: k("obs", o.id),
      evidence: [],
    });
  }

  // A cheaper like-for-like alternative.
  const alt = cur.bestAlternative;
  const prevAlt = prev?.bestAlternative;
  const isNew = !prevAlt || !alt || prevAlt.evaluationId !== alt.evaluationId || prevAlt.totalCents !== alt.totalCents || prev?.switching?.verdict !== cur.switching?.verdict;
  // Reported when it first appears or changes (the same alternative isn't repeated every check).
  if (alt && alt.likeForLike && alt.savingsCents > 0 && isNew) {
    const sw = cur.switching;
    const benefit = sw ? sw.netBenefitCents : alt.savingsCents;
    const meets = sw ? sw.verdict === "worth_considering" || sw.verdict === "review" || sw.verdict === "unknown" : alt.savingsCents >= s.minSavingsCents;
    events.push({
      type: "cheaper_alternative",
      severity: sw?.verdict === "worth_considering" ? "important" : "notice",
      title: sw ? `Cheaper option found: ${sw.headline}` : `A like-for-like option costs ${formatCents(alt.savingsCents)} less`,
      detail: sw
        ? `${alt.label}: ${formatCents(alt.totalCents)}. The price difference is ${formatCents(alt.savingsCents)}; ${benefit === null ? "the cost of switching is not known, so no saving is claimed" : `after switching costs the net difference is ${formatCents(benefit)}`}.`
        : `${alt.label}: ${formatCents(alt.totalCents)} vs your plan ${formatCents(t?.totalCents ?? 0)}. You haven't recorded a booked reservation for this plan, so there are no switching costs to subtract.`,
      notify: meets && s.notifyOn.alternatives && (sw ? sw.verdict !== "not_worth_it" : true),
      dedupeKey: k("alt", alt.evaluationId, alt.totalCents, sw?.verdict ?? "plain"),
      evidence: alt.differences,
    });
  }

  return events;
}

/** When the monitor should next run, given its frequency. */
export function nextCheckAt(frequency: MonitorSettings["frequency"], from: Date): string | null {
  if (frequency === "manual") return null;
  const d = new Date(from.getTime() + (frequency === "daily" ? 1 : 7) * 86_400_000);
  return d.toISOString();
}

/** Days since an ISO date (for display). */
export const ageInDays = (d: IsoDate, today: IsoDate) => daysBetween(d, today);

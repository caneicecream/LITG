import { addDays, daysBetween, todayIso } from "../dates";
import { formatCents, type Cents } from "../money";
import { STATUS_LABEL } from "../provenance";
import { priceConfiguration, type PricingContext } from "../pricing/calculate";
import type { ResolveOptions } from "../pricing/resolve";
import type {
  Award,
  BookingMethod,
  Catalog,
  Configuration,
  CostCategory,
  DiningChoice,
  Evaluation,
  OptimizationResult,
  PriceData,
  Resort,
  Savings,
  TicketOption,
  TripRequest,
} from "../types";
import { checkHardConstraints } from "./constraints";
import { compareByCost, compareByValue, differencesFromPreferred, valueScore, WEIGHT_LABEL } from "./scoring";

export interface OptimizeInput {
  catalog: Catalog;
  data: PriceData;
  request: TripRequest;
  now?: Date;
}

const RANKED_LIMIT = 50;
const EXCLUDED_LIMIT = 10;

export function configId(c: Configuration): string {
  return [c.arrival, c.nights, c.resortId, c.roomTypeId, c.ticketOption ?? "none", c.bookingMethod, c.dining].join("|");
}

/** Enumerate structurally valid configurations within the user's date window and choices. */
export function enumerateConfigurations(catalog: Catalog, req: TripRequest): Configuration[] {
  const out: Configuration[] = [];
  const { earliestArrival, latestDeparture, minNights, maxNights } = req.dates;
  const ticketOptions: (TicketOption | null)[] = req.tickets.parkDays > 0 ? req.tickets.allowedOptions : [null];
  const diningChoices: DiningChoice[] =
    req.dining.policy === "require"
      ? ["quick_service_plan", "dining_plan"]
      : req.dining.policy === "exclude"
        ? ["out_of_pocket"]
        : ["out_of_pocket", "quick_service_plan", "dining_plan"];

  for (let arrival = earliestArrival; daysBetween(arrival, latestDeparture) >= minNights; arrival = addDays(arrival, 1)) {
    for (let nights = minNights; nights <= maxNights; nights++) {
      if (addDays(arrival, nights) > latestDeparture) break;
      for (const resort of catalog.resorts) {
        for (const room of resort.roomTypes) {
          for (const ticketOption of ticketOptions) {
            for (const dining of diningChoices) {
              const methods: BookingMethod[] = [];
              // Dining plans and packages require tickets and a Disney resort.
              const packageable = ticketOption !== null && resort.onProperty;
              if (dining === "out_of_pocket") methods.push("separate");
              if (packageable) methods.push("package");
              for (const bookingMethod of methods) {
                out.push({ arrival, nights, resortId: resort.id, roomTypeId: room.id, ticketOption, bookingMethod, dining });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/** The user's preferred plan as a concrete configuration, or a reason it can't be built. */
export function baselineConfiguration(req: TripRequest): { config: Configuration } | { missing: string[] } {
  const p = req.preferred;
  const missing: string[] = [];
  if (!p.arrival) missing.push("arrival date");
  if (!p.nights) missing.push("number of nights");
  if (!p.resortId) missing.push("resort");
  if (!p.roomTypeId) missing.push("room");
  if (req.tickets.parkDays > 0 && !p.ticketOption) missing.push("ticket type");
  if (missing.length > 0) return { missing };
  const dining: DiningChoice = p.dining ?? "out_of_pocket";
  return {
    config: {
      arrival: p.arrival!,
      nights: p.nights!,
      resortId: p.resortId!,
      roomTypeId: p.roomTypeId!,
      ticketOption: req.tickets.parkDays > 0 ? p.ticketOption! : null,
      bookingMethod: dining !== "out_of_pocket" ? "package" : (p.bookingMethod ?? "separate"),
      dining,
    },
  };
}

function evaluate(config: Configuration, resort: Resort, ctx: PricingContext): Evaluation {
  const req = ctx.request;
  const priced = priceConfiguration(config, ctx);
  const room = resort.roomTypes.find((r) => r.id === config.roomTypeId)!;
  const parkDays = config.ticketOption ? req.tickets.parkDays : 0;
  const { targetCents, hardLimitCents } = req.budget;
  return {
    id: configId(config),
    config,
    departure: addDays(config.arrival, config.nights),
    resortName: resort.name,
    roomName: room.name,
    ...priced,
    violations: checkHardConstraints(config, resort, req),
    budget: {
      overTargetCents: targetCents === undefined ? null : priced.totalCents - targetCents,
      withinHardLimit:
        hardLimitCents === undefined
          ? true
          : priced.totalCents > hardLimitCents
            ? false
            : priced.complete
              ? true
              : "unknown",
    },
    perNightCents: Math.round(priced.totalCents / config.nights),
    perParkDayCents: parkDays > 0 ? Math.round(priced.totalCents / parkDays) : null,
    valueScore: null,
    differences: differencesFromPreferred(config, req, ctx.catalog),
    savings: null,
    otherBookingMethod: null,
  };
}

/**
 * For the same trip (dates, room, tickets, dining), keep only the better of
 * "separate" vs "package", and record what the other method would cost.
 * Ties go to "separate" (more flexible: tickets and room can be changed independently).
 * Options are only collapsed within the same trust class, so a cheaper
 * illustrative price can never hide a real quote.
 */
function collapseBookingMethods(evals: Evaluation[]): Evaluation[] {
  const groups = new Map<string, Evaluation[]>();
  for (const e of evals) {
    const { bookingMethod: _m, ...rest } = e.config;
    const key = JSON.stringify(rest) + (e.containsIllustrative ? "|demo" : "|real");
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }
  const out: Evaluation[] = [];
  for (const g of groups.values()) {
    g.sort(
      (a, b) =>
        Number(b.complete) - Number(a.complete) ||
        a.totalCents - b.totalCents ||
        (a.config.bookingMethod === "separate" ? -1 : 1),
    );
    const [winner, other] = g;
    if (other) winner!.otherBookingMethod = { method: other.config.bookingMethod, totalCents: other.totalCents, complete: other.complete };
    out.push(winner!);
  }
  return out;
}

const BUCKETS: { label: string; categories: CostCategory[] }[] = [
  { label: "Package quote", categories: ["package"] },
  { label: "Lodging", categories: ["room", "room_tax"] },
  { label: "Discounts", categories: ["discount"] },
  { label: "Tickets", categories: ["tickets", "ticket_tax"] },
  { label: "Dining", categories: ["dining", "dining_tax"] },
  { label: "Transportation", categories: ["transport", "rental_car"] },
  { label: "Other", categories: ["other"] },
];

/** Per-bucket cost differences (candidate − baseline), largest first. */
export function bucketDeltas(e: Evaluation, base: Evaluation): { label: string; deltaCents: Cents }[] {
  const sum = (ev: Evaluation, cats: CostCategory[]) =>
    ev.lines.filter((l) => cats.includes(l.category)).reduce((a, l) => a + (l.amountCents ?? 0), 0);
  return BUCKETS.map((b) => ({ label: b.label, deltaCents: sum(e, b.categories) - sum(base, b.categories) }))
    .filter((d) => d.deltaCents !== 0)
    .sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents));
}

function computeSavings(e: Evaluation, base: Evaluation): Savings {
  const likeForLike =
    e.config.nights === base.config.nights &&
    e.config.ticketOption === base.config.ticketOption &&
    e.config.dining === base.config.dining;
  const diffs: string[] = [];
  if (e.config.nights !== base.config.nights) diffs.push(`${e.config.nights} vs ${base.config.nights} nights`);
  if (e.config.ticketOption !== base.config.ticketOption) diffs.push("different ticket type");
  if (e.config.dining !== base.config.dining) diffs.push("different dining choice");
  return {
    baselineTotalCents: base.totalCents,
    savingsCents: base.totalCents - e.totalCents,
    likeForLike,
    basis: likeForLike
      ? "Same nights, park days, ticket type and dining as your preferred plan"
      : `Not like-for-like (${diffs.join(", ")}); compare per-night costs too`,
    perNightDeltaCents: base.perNightCents - e.perNightCents,
  };
}

export function optimize(input: OptimizeInput): OptimizationResult {
  const { catalog, data, request: req } = input;
  const now = input.now ?? new Date();
  const today = todayIso(now);
  const opts: ResolveOptions = {
    today,
    staleAfterDays: req.data.staleAfterDays,
    includeIllustrative: req.data.includeIllustrative,
  };
  const ctx: PricingContext = { catalog, data, request: req, opts, bookingDate: req.bookingDate ?? today };
  const resortById = new Map(catalog.resorts.map((r) => [r.id, r]));
  const notices: string[] = [];

  // 1. Enumerate and filter by hard constraints (cheap) before pricing (more expensive).
  const configs = enumerateConfigurations(catalog, req);
  const reasonCounts = new Map<string, number>();
  const feasible: Configuration[] = [];
  for (const c of configs) {
    const v = checkHardConstraints(c, resortById.get(c.resortId)!, req);
    if (v.length === 0) feasible.push(c);
    else for (const r of v) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  }

  // 2. Price every feasible configuration, then collapse package vs separate.
  const evaluated = collapseBookingMethods(feasible.map((c) => evaluate(c, resortById.get(c.resortId)!, ctx)));

  // 3. Partition: only complete, within-hard-limit results are comparable. If any
  //    comparable result uses no illustrative data, illustrative ones are set aside
  //    so demo prices are never ranked alongside real ones.
  const complete = evaluated.filter((e) => e.complete);
  const comparable = complete.filter((e) => e.budget.withinHardLimit === true);
  const real = comparable.filter((e) => !e.containsIllustrative);
  const pool = real.length > 0 ? real : comparable;
  const demoMode = pool.some((e) => e.containsIllustrative);
  const setAsideIllustrative = real.length > 0 ? comparable.filter((e) => e.containsIllustrative) : [];

  // 4. Value scores (relative to the pool's price range).
  const totals = pool.map((e) => e.totalCents);
  const priceRange = { min: Math.min(...totals), max: Math.max(...totals) };
  for (const e of complete) {
    e.valueScore = valueScore(e, resortById.get(e.config.resortId)!, req, catalog, priceRange);
  }

  // 5. Baseline (the user's preferred plan) and savings.
  let baseline: Evaluation | null = null;
  let baselineNote: string | null = null;
  const b = baselineConfiguration(req);
  if ("missing" in b) {
    baselineNote = `Set your preferred ${b.missing.join(", ")} to measure savings against your own plan.`;
  } else {
    const resort = resortById.get(b.config.resortId);
    const room = resort?.roomTypes.find((r) => r.id === b.config.roomTypeId);
    if (!resort || !room) {
      baselineNote = "Your preferred resort or room is not in the catalog.";
    } else {
      baseline = evaluate(b.config, resort, ctx);
      if (baseline.complete) {
        baseline.valueScore = valueScore(baseline, resort, req, catalog, priceRange);
        if (baseline.violations.length > 0) {
          baselineNote = `Note: your preferred plan breaks your own requirements (${baseline.violations.join("; ")}).`;
        }
      } else {
        baselineNote = `Your preferred plan could not be fully priced (${baseline.missing.join("; ")}), so savings cannot be calculated.`;
      }
    }
  }
  const savingsComparable = (e: Evaluation) =>
    baseline !== null && baseline.complete && e.complete && baseline.containsIllustrative === e.containsIllustrative;
  for (const e of [...complete]) if (savingsComparable(e)) e.savings = computeSavings(e, baseline!);
  if (baseline?.complete && pool.length > 0 && baseline.containsIllustrative !== demoMode) {
    notices.push(
      baseline.containsIllustrative
        ? "Your preferred plan is priced with illustrative data while the ranked options use real prices, so savings are not calculated."
        : "Your preferred plan uses real prices but the ranked options are illustrative, so savings are not calculated.",
    );
  }

  // 6. Awards.
  const byCost = compareByCost(req);
  const byValue = compareByValue(req);
  const awards: Award[] = [];
  const priceLabel = demoMode ? " (illustrative prices)" : "";
  const sortedByCost = [...pool].sort(byCost);
  const cheapest = sortedByCost[0];
  if (cheapest) {
    const why = [`Lowest total of ${pool.length} fully priced option${pool.length === 1 ? "" : "s"}: ${formatCents(cheapest.totalCents)}${priceLabel}.`];
    if (cheapest.savings && baseline) why.push(...savingsExplanation(cheapest, baseline));
    if (cheapest.appliedPromotion) why.push(`Includes ${cheapest.appliedPromotion.name} (−${formatCents(cheapest.appliedPromotion.savingsCents)}).`);
    awards.push({ kind: "cheapest", evaluationId: cheapest.id, explanation: why });
  }
  const bestValue = [...pool].sort(byValue)[0];
  if (bestValue?.valueScore) {
    const top = [...bestValue.valueScore.parts]
      .filter((p) => p.weightPct > 0)
      .sort((a, b) => b.score * b.weightPct - a.score * a.weightPct)
      .slice(0, 3)
      .map((p) => `${p.label} ${p.score}/100`);
    const why = [
      `Highest value score with your weights: ${bestValue.valueScore.total}/100 (${top.join(", ")}).`,
      `Weights: ${bestValue.valueScore.parts.filter((p) => p.weightPct > 0).map((p) => `${WEIGHT_LABEL[p.key]} ${p.weightPct}%`).join(", ")}.`,
    ];
    if (bestValue.id !== cheapest?.id && cheapest) {
      why.push(`Costs ${formatCents(bestValue.totalCents - cheapest.totalCents)} more than the cheapest option.`);
    }
    awards.push({ kind: "best_value", evaluationId: bestValue.id, explanation: why });
  }
  if (baseline?.complete) {
    const alt = sortedByCost.find((e) => e.id !== baseline!.id && e.savings?.likeForLike && e.savings.savingsCents > 0);
    if (alt) {
      awards.push({
        kind: "best_alternative",
        evaluationId: alt.id,
        explanation: [
          `Same length of stay, tickets and dining as your plan, for ${formatCents(alt.savings!.savingsCents)} less${priceLabel}.`,
          ...savingsExplanation(alt, baseline),
        ],
      });
    } else if (pool.some(savingsComparable)) {
      notices.push("No like-for-like option is cheaper than your preferred plan with the available prices.");
    }
  }

  // 7. Ranked list and set-aside groups.
  const ranked = [...pool].sort(req.objective === "best_value" ? byValue : byCost).slice(0, RANKED_LIMIT);
  const excluded = {
    illustrative: setAsideIllustrative.sort(byCost).slice(0, EXCLUDED_LIMIT),
    incomplete: evaluated
      .filter((e) => !e.complete && e.budget.withinHardLimit !== false)
      .sort(byCost)
      .slice(0, EXCLUDED_LIMIT),
    overHardLimit: evaluated
      .filter((e) => e.budget.withinHardLimit === false)
      .sort(byCost)
      .slice(0, EXCLUDED_LIMIT),
  };

  // 8. Flexible-date matrix: cheapest comparable total for each arrival/length.
  const matrix = new Map<string, OptimizationResult["dateMatrix"][number]>();
  for (const e of sortedByCost) {
    const k = `${e.config.arrival}|${e.config.nights}`;
    if (!matrix.has(k)) matrix.set(k, { arrival: e.config.arrival, nights: e.config.nights, totalCents: e.totalCents, evaluationId: e.id });
  }

  // 9. Notices.
  if (demoMode) {
    notices.unshift("These results are based on ILLUSTRATIVE demo prices. They show how the optimizer works and are not real offers.");
  }
  if (setAsideIllustrative.length > 0) {
    notices.push(`${setAsideIllustrative.length} option(s) priced with illustrative data were set aside so they are not compared with real prices.`);
  }
  if (pool.length === 0) {
    if (req.budget.hardLimitCents !== undefined && excluded.overHardLimit.length > 0) {
      notices.push(`No fully priced option fits your hard limit of ${formatCents(req.budget.hardLimitCents)}. The least expensive options over the limit are listed below.`);
    } else if (excluded.incomplete.length > 0) {
      notices.push("No option could be fully priced. Add quotes or prices on the Price data page, or include illustrative data.");
    } else if (feasible.length === 0) {
      notices.push("No configuration satisfies all of your hard requirements. See the reasons below.");
    }
  }
  const potential = pool.filter((e) => e.potentialPromotions.length > 0).length;
  if (potential > 0) {
    notices.push(`${potential} ranked option(s) might qualify for additional offers if you confirm eligibility (see each option's details). They are not included in totals.`);
  }
  const staleCount = pool.filter((e) => Object.keys(e.statusTotals).includes("stale")).length;
  if (staleCount > 0) {
    notices.push(`${staleCount} ranked option(s) use prices older than ${req.data.staleAfterDays} days (${STATUS_LABEL.stale}). Re-check them before booking.`);
  }

  return {
    runAt: now.toISOString(),
    today,
    demoMode,
    awards,
    ranked,
    baseline,
    baselineNote,
    excluded,
    dateMatrix: [...matrix.values()].sort((a, b) => (a.arrival < b.arrival ? -1 : a.arrival > b.arrival ? 1 : a.nights - b.nights)),
    stats: {
      candidates: configs.length,
      infeasible: configs.length - feasible.length,
      infeasibleReasons: [...reasonCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      priced: evaluated.length,
      complete: complete.length,
      comparable: pool.length,
    },
    notices,
  };
}

function savingsExplanation(e: Evaluation, base: Evaluation): string[] {
  const s = e.savings;
  if (!s) return [];
  const out: string[] = [];
  if (s.savingsCents > 0) out.push(`${formatCents(s.savingsCents)} less than your preferred plan (${formatCents(base.totalCents)}). ${s.basis}.`);
  else if (s.savingsCents < 0) out.push(`${formatCents(-s.savingsCents)} more than your preferred plan. ${s.basis}.`);
  else out.push(`Same total as your preferred plan.`);
  const deltas = bucketDeltas(e, base);
  if (deltas.length > 0) out.push(`Where the difference comes from: ${deltas.map((d) => `${d.label} ${formatCents(d.deltaCents, { sign: true })}`).join(", ")}.`);
  if (e.differences.length > 0) out.push(`Changes: ${e.differences.join("; ")}.`);
  return out;
}


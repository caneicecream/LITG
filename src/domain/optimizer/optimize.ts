import { addDays, daysBetween, todayIso } from "../dates";
import { formatCents, type Cents } from "../money";
import { STATUS_LABEL, STATUS_RANK } from "../provenance";
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
import { createBounder, type Bound } from "./bound";
import { checkHardConstraints } from "./constraints";
import { compareByCost, compareByValue, differencesFromPreferred, valueScore, WEIGHT_LABEL } from "./scoring";

export interface OptimizeInput {
  catalog: Catalog;
  data: PriceData;
  request: TripRequest;
  now?: Date;
  /** Configuration ids to return in `included` even if they fall outside the ranked list. */
  include?: string[];
  /**
   * Skip pricing configurations whose lower bound proves they cannot appear in
   * any result (default true). Results are identical either way; only `stats`
   * differ. Tests compare both modes.
   */
  prune?: boolean;
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
              // Dining plans and packages require tickets and a Disney-owned resort.
              const packageable = ticketOption !== null && resort.disneyOwned;
              if (dining === "out_of_pocket") methods.push("separate");
              if (packageable) methods.push("package");
              // DVC villas can also be reserved with points (no dining plan or package).
              if (dining === "out_of_pocket" && resort.dvcPoints && req.resorts.considerPoints) methods.push("points");
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
    violations: [...checkHardConstraints(config, resort, req), ...priced.violations],
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

/** Configurations that differ only in "separate" vs "package" booking are priced (and pruned) together. */
function groupKey(c: Configuration): string {
  if (c.bookingMethod === "points") return configId(c);
  return [c.arrival, c.nights, c.resortId, c.roomTypeId, c.ticketOption ?? "none", c.dining].join("|");
}

/**
 * Within one group, keep only the better of "separate" vs "package", and record
 * what the other method would cost. Ties go to "separate" (more flexible: tickets
 * and room can be changed independently). Options are only collapsed within the
 * same trust class, so a cheaper illustrative price can never hide a real quote.
 */
function collapseGroup(evals: Evaluation[]): Evaluation[] {
  const byClass = new Map<string, Evaluation[]>();
  for (const e of evals) {
    const k = e.containsIllustrative ? "demo" : "real";
    byClass.set(k, [...(byClass.get(k) ?? []), e]);
  }
  const out: Evaluation[] = [];
  for (const g of byClass.values()) {
    // Complete beats incomplete; between incomplete options, fewer missing prices
    // beats a lower partial total (a partial total understates the real cost).
    g.sort(
      (a, b) =>
        Number(b.complete) - Number(a.complete) ||
        a.missing.length - b.missing.length ||
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
  { label: "Lodging", categories: ["room", "room_tax", "fees"] },
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

/** The cancellation cost of switching away from the baseline, when it is an existing reservation. */
interface Switching {
  penaltyCents: Cents | null;
  note: string;
}

function computeSavings(e: Evaluation, base: Evaluation, switching: Switching | null): Savings {
  const likeForLike =
    e.config.nights === base.config.nights &&
    e.config.ticketOption === base.config.ticketOption &&
    e.config.dining === base.config.dining;
  const diffs: string[] = [];
  if (e.config.nights !== base.config.nights) diffs.push(`${e.config.nights} vs ${base.config.nights} nights`);
  if (e.config.ticketOption !== base.config.ticketOption) diffs.push("different ticket type");
  if (e.config.dining !== base.config.dining) diffs.push("different dining choice");
  const savingsCents = base.totalCents - e.totalCents;
  return {
    baselineTotalCents: base.totalCents,
    savingsCents,
    likeForLike,
    basis: likeForLike
      ? "Same nights, park days, ticket type and dining as your preferred plan"
      : `Not like-for-like (${diffs.join(", ")})${e.config.nights !== base.config.nights ? "; compare per-night costs too" : ""}`,
    perNightDeltaCents: base.perNightCents - e.perNightCents,
    switching: switching && {
      penaltyCents: switching.penaltyCents,
      netSavingsCents: switching.penaltyCents === null ? null : savingsCents - switching.penaltyCents,
      note: switching.note,
    },
  };
}

/** Keeps the best `k` items under a comparator; exposes the current k-th (worst kept) item. */
class TopK<T> {
  private items: T[] = [];
  constructor(
    private readonly k: number,
    private readonly cmp: (a: T, b: T) => number,
  ) {}
  add(x: T) {
    if (this.items.length === this.k && this.cmp(x, this.items[this.k - 1]!) >= 0) return;
    let i = this.items.length;
    while (i > 0 && this.cmp(x, this.items[i - 1]!) < 0) i--;
    this.items.splice(i, 0, x);
    if (this.items.length > this.k) this.items.pop();
  }
  get full() {
    return this.items.length >= this.k;
  }
  get worst(): T | undefined {
    return this.items[this.items.length - 1];
  }
}

type TrustClass = "real" | "demo";

/** Math.min over an array without spreading it (large arrays overflow the call stack). */
function minOf(xs: readonly number[]): number {
  let m = Infinity;
  for (const x of xs) if (x < m) m = x;
  return m;
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
  const byCost = compareByCost(req);
  const byValue = compareByValue(req);
  const hardLimit = req.budget.hardLimitCents;

  // 1. Enumerate and filter by hard constraints (cheap) before pricing (more expensive).
  const configs = enumerateConfigurations(catalog, req);
  const reasonCounts = new Map<string, number>();
  const countReason = (r: string) => reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  const feasible: Configuration[] = [];
  for (const c of configs) {
    const v = checkHardConstraints(c, resortById.get(c.resortId)!, req);
    if (v.length === 0) feasible.push(c);
    else v.forEach(countReason);
  }

  // 2. The baseline (the user's preferred plan) is priced first: savings and the
  //    best-alternative bound depend on it.
  let baseline: Evaluation | null = null;
  let baselineNote: string | null = null;
  const b = baselineConfiguration(req);
  if ("missing" in b) {
    baselineNote = `Set your preferred ${b.missing.join(", ")} to measure savings against your own plan.`;
  } else {
    const resort = resortById.get(b.config.resortId);
    const room = resort?.roomTypes.find((r) => r.id === b.config.roomTypeId);
    if (!resort || !room) baselineNote = "Your preferred resort or room is not in the catalog.";
    else baseline = evaluate(b.config, resort, ctx);
  }
  const baselineComplete = baseline?.complete ? baseline : null;
  const baselineClass: TrustClass | null = baselineComplete ? (baselineComplete.containsIllustrative ? "demo" : "real") : null;

  // 3. Group, bound, and price in order of lower bound, skipping groups that
  //    provably cannot change any result (see docs/ARCHITECTURE.md, "Pruning").
  const prune = input.prune ?? true;
  const bounder = createBounder(ctx);
  const forced = new Set(input.include ?? []);
  const groupMap = new Map<string, Configuration[]>();
  for (const c of feasible) {
    const k = groupKey(c);
    const g = groupMap.get(k);
    if (g) g.push(c);
    else groupMap.set(k, [c]);
  }
  interface Group extends Bound {
    key: string;
    configs: Configuration[];
    forced: boolean;
  }
  const groups: Group[] = [...groupMap.entries()].map(([key, cs]) => {
    const bounds = cs.map((c) => bounder(c, resortById.get(c.resortId)!));
    return {
      key,
      configs: cs,
      forced: cs.some((c) => forced.has(configId(c))),
      lb: minOf(bounds.map((x) => x.lb)),
      quoted: bounds.some((x) => x.quoted),
      mayBeComplete: bounds.some((x) => x.mayBeComplete),
      mayBeIncomplete: bounds.some((x) => x.mayBeIncomplete),
      mayBeIllustrative: bounds.some((x) => x.mayBeIllustrative),
      mayBeReal: bounds.some((x) => x.mayBeReal),
    };
  });
  groups.sort((a, b) => a.lb - b.lb || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // Trackers for every output a configuration could enter.
  const costK = req.objective === "lowest_cost" ? RANKED_LIMIT : EXCLUDED_LIMIT;
  const valueK = req.objective === "best_value" ? RANKED_LIMIT : 1;
  const costTop: Record<TrustClass, TopK<Evaluation>> = { real: new TopK(costK, byCost), demo: new TopK(costK, byCost) };
  const valueTop: Record<TrustClass, TopK<number>> = { real: new TopK(valueK, (a, b) => b - a), demo: new TopK(valueK, (a, b) => b - a) };
  const cellMin: Record<TrustClass, Map<string, number>> = { real: new Map(), demo: new Map() };
  const classMin: Record<TrustClass, number> = { real: Infinity, demo: Infinity };
  const incompleteTop = new TopK<Evaluation>(EXCLUDED_LIMIT, byCost);
  const overTop = new TopK<Evaluation>(EXCLUDED_LIMIT, byCost);
  let bestAltTotal = Infinity;
  // Lower bound on the final cheapest comparable total (for conservative value scores).
  const unquotedMinLb = minOf(groups.filter((g) => !g.quoted).map((g) => g.lb));
  let floorMin = Infinity;
  const pendingValue: { cls: TrustClass; e: Evaluation }[] = [];
  const classOf = (e: Evaluation): TrustClass => (e.containsIllustrative ? "demo" : "real");
  const round1 = (x: number) => Math.round(x * 10) / 10;

  const record = (e: Evaluation) => {
    if (e.budget.withinHardLimit === false) return overTop.add(e);
    if (!e.complete) return incompleteTop.add(e);
    const cls = classOf(e);
    costTop[cls].add(e);
    const cell = `${e.config.arrival}|${e.config.nights}`;
    cellMin[cls].set(cell, Math.min(cellMin[cls].get(cell) ?? Infinity, e.totalCents));
    classMin[cls] = Math.min(classMin[cls], e.totalCents);
    if (e.savings?.likeForLike && cls === baselineClass && e.totalCents < baselineComplete!.totalCents) {
      bestAltTotal = Math.min(bestAltTotal, e.totalCents);
    }
    if (floorMin === Infinity) pendingValue.push({ cls, e });
    else valueTop[cls].add(valueScore(e, resortById.get(e.config.resortId)!, req, catalog, floorMin).total);
  };

  const mustPrice = (g: Group): boolean => {
    if (!prune || g.quoted || g.forced) return true;
    const c0 = g.configs[0]!;
    const cell = `${c0.arrival}|${c0.nights}`;
    const resort = resortById.get(c0.resortId)!;
    const classes: TrustClass[] = [];
    if (g.mayBeReal) classes.push("real");
    if (g.mayBeIllustrative) classes.push("demo");
    const withinLimit = hardLimit === undefined || g.lb <= hardLimit;
    if (g.mayBeComplete && withinLimit) {
      const likeForLike =
        baselineComplete !== null &&
        c0.nights === baselineComplete.config.nights &&
        c0.ticketOption === baselineComplete.config.ticketOption &&
        c0.dining === baselineComplete.config.dining;
      for (const cls of classes) {
        const ct = costTop[cls];
        if (!ct.full || g.lb <= ct.worst!.totalCents) return true;
        const cm = cellMin[cls].get(cell);
        if (cm === undefined || g.lb <= cm) return true;
        const vt = valueTop[cls];
        if (!vt.full || floorMin === Infinity) return true;
        const ub = valueScore({ config: c0, totalCents: g.lb }, resort, req, catalog, classMin[cls]).total;
        if (round1(ub) >= vt.worst!) return true;
        if (likeForLike && cls === baselineClass && g.lb < baselineComplete!.totalCents && g.lb <= bestAltTotal) return true;
      }
    }
    if (g.mayBeIncomplete && withinLimit && (!incompleteTop.full || g.lb <= incompleteTop.worst!.totalCents)) return true;
    if (hardLimit !== undefined && (!overTop.full || g.lb <= overTop.worst!.totalCents)) return true;
    return false;
  };

  const evaluated: Evaluation[] = [];
  let priced = 0;
  let pruned = 0;
  const switching = switchingCost(baseline, data);
  for (const g of groups) {
    if (floorMin === Infinity && !g.quoted) {
      // All quoted groups (lb = −∞) come first; their totals are now known.
      floorMin = Math.min(unquotedMinLb, minOf(evaluated.filter((e) => e.complete).map((e) => e.totalCents)));
      for (const { cls, e } of pendingValue.splice(0)) {
        valueTop[cls].add(valueScore(e, resortById.get(e.config.resortId)!, req, catalog, floorMin).total);
      }
    }
    if (!mustPrice(g)) {
      pruned += g.configs.length;
      continue;
    }
    priced += g.configs.length;
    const evals = g.configs.map((c) => evaluate(c, resortById.get(c.resortId)!, ctx));
    const ok = evals.filter((e) => {
      if (e.violations.length === 0) return true;
      e.violations.forEach(countReason);
      return false;
    });
    for (const w of collapseGroup(ok)) {
      if (baselineComplete && w.complete && baselineComplete.containsIllustrative === w.containsIllustrative) {
        w.savings = computeSavings(w, baselineComplete, switching);
      }
      evaluated.push(w);
      record(w);
    }
  }

  // 4. Partition: only complete, within-hard-limit results are comparable. If any
  //    comparable result uses no illustrative data, illustrative ones are set aside
  //    so demo prices are never ranked alongside real ones.
  const complete = evaluated.filter((e) => e.complete);
  const comparable = complete.filter((e) => e.budget.withinHardLimit === true);
  const real = comparable.filter((e) => !e.containsIllustrative);
  const pool = real.length > 0 ? real : comparable;
  const demoMode = pool.some((e) => e.containsIllustrative);
  const setAsideIllustrative = real.length > 0 ? comparable.filter((e) => e.containsIllustrative) : [];

  // 5. Value scores, relative to the cheapest option in the pool.
  const cheapestTotal = pool.length ? minOf(pool.map((e) => e.totalCents)) : 0;
  for (const e of complete) e.valueScore = valueScore(e, resortById.get(e.config.resortId)!, req, catalog, cheapestTotal);

  if (baseline) {
    if (baseline.complete) {
      baseline.valueScore = valueScore(baseline, resortById.get(baseline.config.resortId)!, req, catalog, cheapestTotal);
      if (baseline.violations.length > 0) {
        baselineNote = `Note: your preferred plan breaks your own requirements (${baseline.violations.join("; ")}).`;
      }
    } else {
      baselineNote = `Your preferred plan could not be fully priced (${baseline.missing.join("; ")}), so savings cannot be calculated.`;
    }
  }
  const savingsComparable = (e: Evaluation) =>
    baselineComplete !== null && e.complete && baselineComplete.containsIllustrative === e.containsIllustrative;
  if (baselineComplete && pool.length > 0 && baselineComplete.containsIllustrative !== demoMode) {
    notices.push(
      baselineComplete.containsIllustrative
        ? "Your preferred plan is priced with illustrative data while the ranked options use real prices, so savings are not calculated."
        : "Your preferred plan uses real prices but the ranked options are illustrative, so savings are not calculated.",
    );
  }

  // 6. Awards.
  const awards: Award[] = [];
  const priceLabel = demoMode ? " (illustrative prices)" : "";
  const sortedByCost = [...pool].sort(byCost);
  // "Cheapest" and "best value" are comparative claims: they need at least two options.
  // (The best alternative is compared against the user's own plan, so it can stand alone.)
  const canCompare = pool.length >= 2;
  if (pool.length === 1) {
    notices.push("Only one option is fully priced with comparable data, so there is nothing to rank it against yet. Add more quotes or prices to compare.");
  }
  const cheapest = canCompare ? sortedByCost[0] : undefined;
  if (cheapest) {
    const why = [`Lowest total among the fully priced options: ${formatCents(cheapest.totalCents)}${priceLabel}.`];
    if (cheapest.savings && baseline) why.push(...savingsExplanation(cheapest, baseline));
    if (cheapest.appliedPromotion) why.push(`Includes ${cheapest.appliedPromotion.name} (−${formatCents(cheapest.appliedPromotion.savingsCents)}).`);
    awards.push({ kind: "cheapest", evaluationId: cheapest.id, explanation: why });
  }
  const bestValue = canCompare ? [...pool].sort(byValue)[0] : undefined;
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
  if (baselineComplete) {
    const alt = sortedByCost.find((e) => e.id !== baselineComplete.id && e.savings?.likeForLike && e.savings.savingsCents > 0);
    const net = alt?.savings?.switching;
    if (alt && net && (net.netSavingsCents === null || net.netSavingsCents <= 0)) {
      // The plan is an existing reservation: a cheaper option is only a saving after cancellation costs.
      notices.push(
        net.netSavingsCents === null
          ? `A like-for-like option is ${formatCents(alt.savings!.savingsCents)} cheaper than your existing reservation, but its cancellation cost is unknown, so no net saving can be confirmed. ${net.note}`
          : `A like-for-like option is ${formatCents(alt.savings!.savingsCents)} cheaper than your existing reservation, but cancelling would cost ${formatCents(net.penaltyCents!)}, so switching would not save money.`,
      );
    } else if (alt) {
      awards.push({
        kind: "best_alternative",
        evaluationId: alt.id,
        explanation: [
          `Same length of stay, tickets and dining as your plan, for ${formatCents(alt.savings!.savingsCents)} less${priceLabel}.`,
          ...(net ? [`After the ${formatCents(net.penaltyCents!)} cost of cancelling your existing reservation, the net saving is ${formatCents(net.netSavingsCents!)}.`] : []),
          ...savingsExplanation(alt, baselineComplete),
        ],
      });
    } else if (pool.some(savingsComparable)) {
      notices.push("No like-for-like option is cheaper than your preferred plan with the available prices.");
    }
  }

  // 7. Ranked list and set-aside groups.
  // Top N by the chosen objective, plus any award winner that falls outside it.
  const awardIds = new Set(awards.map((a) => a.evaluationId));
  const ranked = [...pool]
    .sort(req.objective === "best_value" ? byValue : byCost)
    .filter((e, i) => i < RANKED_LIMIT || awardIds.has(e.id));
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

  // 9. Notices (phrased from the outputs, which are identical with or without pruning).
  if (demoMode) {
    notices.unshift("These results are based on ILLUSTRATIVE demo prices. They show how the optimizer works and are not real offers.");
  }
  if (demoMode && excluded.overHardLimit.some((e) => !e.containsIllustrative)) {
    notices.push("Some options priced with your real quotes exceed your hard limit (see “Over your hard limit”), so only illustrative options remain below it.");
  }
  if (excluded.illustrative.length > 0) {
    notices.push("Options priced with illustrative data were set aside so they are not compared with real prices.");
  }
  if (pool.length === 0) {
    if (hardLimit !== undefined && excluded.overHardLimit.length > 0) {
      notices.push(`No fully priced option fits your hard limit of ${formatCents(hardLimit)}. The least expensive options over the limit are listed below.`);
    } else if (excluded.incomplete.length > 0) {
      notices.push("No option could be fully priced. Add quotes or prices on the Price data page, or include illustrative data.");
    } else if (feasible.length === 0 || evaluated.length === 0) {
      notices.push("No configuration satisfies all of your hard requirements. See the reasons below.");
    }
  }
  const potential = ranked.filter((e) => e.potentialPromotions.length > 0).length;
  if (potential > 0) {
    notices.push(`${potential} of the ${ranked.length} ranked option(s) might qualify for additional offers if you confirm eligibility (e.g. residency). Those offers are not included in any total; see an option's details.`);
  }
  const staleCount = ranked.filter((e) => Object.keys(e.statusTotals).includes("stale")).length;
  if (staleCount > 0) {
    notices.push(`${staleCount} ranked option(s) use prices older than ${req.data.staleAfterDays} days (${STATUS_LABEL.stale}). Re-check them on the Price data page before booking.`);
  }
  const unknownUsage = ranked.filter((e) => e.ticketUsability?.status === "unknown").length;
  if (unknownUsage > 0) {
    notices.push(`${unknownUsage} ranked option(s) use tickets whose usage rules (e.g. how many days you have to use them) are not recorded. Check the ticket terms before buying.`);
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
    included: evaluated.filter((e) => forced.has(e.id)),
    dateMatrix: [...matrix.values()].sort((a, b) => (a.arrival < b.arrival ? -1 : a.arrival > b.arrival ? 1 : a.nights - b.nights)),
    stats: {
      candidates: configs.length,
      infeasible: configs.length - feasible.length,
      infeasibleReasons: [...reasonCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      priced,
      pruned,
      complete: complete.length,
      comparable: pool.length,
    },
    notices,
  };
}

/** If the baseline is priced from a reservation the user already holds, what would cancelling it cost today? */
function switchingCost(baseline: Evaluation | null, data: PriceData): Switching | null {
  if (!baseline?.quoteId) return null;
  const quote = data.stayQuotes.find((q) => q.id === baseline.quoteId);
  if (!quote?.booked) return null;
  if (!baseline.payment) {
    return { penaltyCents: null, note: "Your reservation's cancellation terms are not recorded." };
  }
  return { penaltyCents: baseline.payment.cancellation.penaltyCents, note: baseline.payment.cancellation.note };
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


import { daysBetween, formatShortDate } from "../dates";
import { STATUS_RANK } from "../provenance";
import { DINING_LABEL, TICKET_LABEL } from "../pricing/calculate";
import type { Catalog, Configuration, Evaluation, Resort, TripRequest, ValueScore, ValueWeights } from "../types";

export const WEIGHT_LABEL: Record<keyof ValueWeights, string> = {
  price: "Price",
  resort: "Resort preference",
  convenience: "Convenience",
  ticket: "Ticket preference",
  dining: "Dining preference",
  dates: "Date preference",
};

/** Arrival-day difference plus nights difference from the preferred plan (0 when unspecified). */
export function dateDistance(config: Configuration, req: TripRequest): number {
  const p = req.preferred;
  const arrival = p.arrival ? Math.abs(daysBetween(p.arrival, config.arrival)) : 0;
  const nights = p.nights ? Math.abs(config.nights - p.nights) : 0;
  return arrival + nights;
}

/**
 * Best-value score (0–100). Deliberately simple and transparent: each factor is
 * scored 0–100 by an explicit rule and combined by the user's weights.
 *
 * Price is scored as cheapest ÷ this total (the cheapest comparable option
 * scores 100; one costing 25% more scores 80). Unlike min–max scaling this does
 * not depend on the most expensive option, so an outlier can't distort the
 * scores of everything else, and an upper bound can be computed before pricing.
 */
export function valueScore(
  e: { config: Configuration; totalCents: number },
  resort: Resort,
  req: TripRequest,
  catalog: Catalog,
  cheapestTotalCents: number,
): ValueScore {
  const { config } = e;
  const price = e.totalCents <= 0 ? 100 : clamp((100 * cheapestTotalCents) / e.totalCents);

  const preferred = req.resorts.preferredResortIds;
  const preferredTiers = new Set(
    catalog.resorts.filter((r) => preferred.includes(r.id)).map((r) => r.tier),
  );
  const resortScore =
    preferred.length === 0 || preferred.includes(resort.id) ? 100 : preferredTiers.has(resort.tier) ? 60 : 25;

  const convenience = clamp(((resort.convenience - 1) / 4) * 100);

  const prefTicket = req.preferred.ticketOption;
  const ticket = !prefTicket || !config.ticketOption || prefTicket === config.ticketOption ? 100 : 50;

  const dining = req.dining.policy === "prefer" ? (config.dining === "out_of_pocket" ? 40 : 100) : 100;

  const p = req.preferred;
  const dates =
    p.arrival || p.nights
      ? clamp(
          100 -
            10 * (p.arrival ? Math.abs(daysBetween(p.arrival, config.arrival)) : 0) -
            15 * (p.nights ? Math.abs(config.nights - p.nights) : 0),
        )
      : 100;

  const scores: Record<keyof ValueWeights, number> = { price, resort: resortScore, convenience, ticket, dining, dates };
  const wSum = Object.values(req.weights).reduce((a, b) => a + b, 0) || 1;
  const parts = (Object.keys(scores) as (keyof ValueWeights)[]).map((key) => ({
    key,
    label: WEIGHT_LABEL[key],
    score: Math.round(scores[key]),
    weightPct: Math.round((req.weights[key] / wSum) * 100),
  }));
  const total = (Object.keys(scores) as (keyof ValueWeights)[]).reduce(
    (acc, k) => acc + (scores[k] * req.weights[k]) / wSum,
    0,
  );
  return { total: Math.round(total * 10) / 10, parts };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** Human-readable differences between a configuration and the user's preferred plan. */
export function differencesFromPreferred(config: Configuration, req: TripRequest, catalog: Catalog): string[] {
  const p = req.preferred;
  const out: string[] = [];
  const name = (id: string) => catalog.resorts.find((r) => r.id === id)?.name ?? id;
  if (p.arrival && p.arrival !== config.arrival) {
    const d = daysBetween(p.arrival, config.arrival);
    out.push(`Arrives ${formatShortDate(config.arrival)} (${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} ${d > 0 ? "later" : "earlier"} than preferred)`);
  }
  if (p.nights && p.nights !== config.nights) out.push(`${config.nights} nights instead of ${p.nights}`);
  if (p.resortId && p.resortId !== config.resortId) out.push(`${name(config.resortId)} instead of ${name(p.resortId)}`);
  else if (p.roomTypeId && p.roomTypeId !== config.roomTypeId) {
    const resort = catalog.resorts.find((r) => r.id === config.resortId);
    const rn = (id: string) => resort?.roomTypes.find((r) => r.id === id)?.name ?? id;
    out.push(`${rn(config.roomTypeId)} instead of ${rn(p.roomTypeId)}`);
  }
  if (p.ticketOption && config.ticketOption && p.ticketOption !== config.ticketOption) {
    out.push(`${TICKET_LABEL[config.ticketOption]} instead of ${TICKET_LABEL[p.ticketOption]}`);
  }
  const prefMethod = p.dining && p.dining !== "out_of_pocket" ? "package" : (p.bookingMethod ?? "separate");
  if (prefMethod !== config.bookingMethod) {
    out.push(config.bookingMethod === "package" ? "Booked as a package" : "Room and tickets booked separately");
  }
  if (p.dining && p.dining !== config.dining) out.push(`${DINING_LABEL[config.dining]} instead of ${DINING_LABEL[p.dining]}`);
  return out;
}

/** Deterministic lowest-cost ordering with explicit tie-breakers. */
export function compareByCost(req: TripRequest) {
  return (a: Evaluation, b: Evaluation): number =>
    a.totalCents - b.totalCents ||
    STATUS_RANK[a.dataStatus] - STATUS_RANK[b.dataStatus] ||
    dateDistance(a.config, req) - dateDistance(b.config, req) ||
    (a.config.arrival < b.config.arrival ? -1 : a.config.arrival > b.config.arrival ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Deterministic best-value ordering; ties fall back to the cost ordering. */
export function compareByValue(req: TripRequest) {
  const byCost = compareByCost(req);
  return (a: Evaluation, b: Evaluation): number =>
    (b.valueScore?.total ?? -1) - (a.valueScore?.total ?? -1) || byCost(a, b);
}

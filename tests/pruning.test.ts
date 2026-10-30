import { describe, expect, it } from "vitest";
import { CATALOG } from "@/data/catalog";
import { defaultTripRequest } from "@/data/defaults";
import { ILLUSTRATIVE_DATA } from "@/data/illustrative";
import { TAX_RATES, TRANSPORT } from "@/data/reference";
import { mergePriceData } from "@/data/sources";
import { addDays } from "@/domain/dates";
import { optimize } from "@/domain/optimizer/optimize";
import type { OptimizationResult, PriceData, TicketOption, TripRequest } from "@/domain/types";

/**
 * Pruning must never change results. For many randomized requests and datasets,
 * the optimizer's output with pruning must equal the output without it
 * (everything except `stats`, which reports how much work was skipped).
 * All prices here are fictional test data.
 */

const NOW = new Date("2026-10-30T12:00:00Z");

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomData(r: () => number): PriceData {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const prov = (status: "manual" | "estimated" = "manual") => ({ status, source: "TEST DATA (fictional)", observedAt: r() < 0.2 ? "2026-08-01" : "2026-10-29" });
  const resorts = CATALOG.resorts;
  const extra: Partial<PriceData> = { roomRates: [], stayQuotes: [], ticketPrices: [], promotions: [], pointCosts: [], ticketRules: [] };
  for (let i = 0; i < 6; i++) {
    const resort = pick(resorts);
    const start = addDays("2027-01-01", Math.floor(r() * 60));
    extra.roomRates!.push({
      id: `t-rate-${i}`,
      kind: "room_rate",
      resortId: resort.id,
      roomTypeId: pick(resort.roomTypes).id,
      validFrom: start,
      validTo: addDays(start, 5 + Math.floor(r() * 40)),
      nightlyCents: 8_000 + Math.floor(r() * 60_000),
      taxIncluded: r() < 0.2,
      provenance: prov(),
    });
  }
  for (let i = 0; i < 4; i++) {
    const resort = pick(resorts.filter((x) => x.disneyOwned));
    const pkg = r() < 0.6;
    extra.stayQuotes!.push({
      id: `t-quote-${i}`,
      kind: "stay_quote",
      label: `Test quote ${i}`,
      resortId: resort.id,
      roomTypeId: resort.roomTypes[0]!.id,
      checkIn: addDays("2027-01-04", Math.floor(r() * 20)),
      nights: 3 + Math.floor(r() * 3),
      adults: 2,
      children: 0,
      bookingMethod: pkg ? "package" : "separate",
      ticket: pkg ? { option: pick(["base", "park_hopper"] as TicketOption[]), days: 2 + Math.floor(r() * 2) } : undefined,
      dining: "out_of_pocket",
      totalCents: 150_000 + Math.floor(r() * 300_000),
      taxIncluded: r() < 0.7,
      provenance: prov(),
    });
  }
  for (const days of [1, 2, 3]) {
    extra.ticketPrices!.push({
      id: `t-tp-${days}`,
      kind: "ticket_price",
      option: "base",
      days,
      age: "adult",
      validFrom: "2027-01-01",
      validTo: "2027-03-31",
      cents: 10_000 * days + Math.floor(r() * 8_000),
      taxIncluded: r() < 0.5,
      channel: "third_party",
      usage: r() < 0.5 ? { useWithinDays: days + Math.floor(r() * 3), parkReservationRequired: null } : undefined,
      provenance: prov(),
    });
  }
  extra.promotions!.push({
    id: "t-promo",
    name: "Test promo",
    discount: r() < 0.5 ? { type: "room_percent", pct: 15 } : { type: "package_fixed", cents: 20_000 },
    travel: { from: "2027-01-05", to: "2027-02-10", rule: pick(["all_nights", "arrival_date", "per_night"] as const) },
    requiresPackage: r() < 0.3,
    terms: "test",
    provenance: prov(),
  });
  extra.pointCosts!.push({ id: "t-points", kind: "point_cost", label: "Test rental", type: "rental", centsPerPoint: 1_800 + Math.floor(r() * 800), provenance: prov() });
  extra.ticketRules!.push({
    id: "t-rule",
    kind: "ticket_rule",
    option: "park_hopper",
    days: null,
    channel: "disney",
    usage: { useWithinDays: 4, parkReservationRequired: false },
    provenance: prov(),
  });
  return mergePriceData([{ taxRates: TAX_RATES, transport: TRANSPORT }, ILLUSTRATIVE_DATA, extra]);
}

function randomRequest(r: () => number): TripRequest {
  const base = defaultTripRequest();
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const earliest = addDays("2027-01-02", Math.floor(r() * 40));
  const minNights = 2 + Math.floor(r() * 3);
  const maxNights = minNights + Math.floor(r() * 3);
  const window = maxNights + Math.floor(r() * 18);
  const parkDays = Math.floor(r() * 4);
  const options = (["base", "park_hopper", "park_hopper_plus"] as TicketOption[]).filter(() => r() < 0.6);
  const allowed = r() < 0.4 ? [] : CATALOG.resorts.filter(() => r() < 0.4).map((x) => x.id);
  const resortIds = CATALOG.resorts.map((x) => x.id);
  const prefResort = pick(CATALOG.resorts);
  return {
    ...base,
    party: { adults: 1 + Math.floor(r() * 3), children: r() < 0.3 ? 1 : 0, infants: 0 },
    dates: { earliestArrival: earliest, latestDeparture: addDays(earliest, window), minNights, maxNights },
    preferred:
      r() < 0.7
        ? {
            arrival: addDays(earliest, Math.floor(r() * 5)),
            nights: minNights,
            resortId: prefResort.id,
            roomTypeId: prefResort.roomTypes[0]!.id,
            ticketOption: options[0] ?? "base",
            bookingMethod: pick(["separate", "package"] as const),
            dining: "out_of_pocket",
          }
        : {},
    resorts: {
      allowedResortIds: allowed,
      requireOnProperty: r() < 0.5,
      preferredResortIds: r() < 0.5 ? [pick(resortIds)] : [],
      considerPoints: r() < 0.5,
    },
    tickets: {
      parkDays,
      allowedOptions: options.length ? options : ["base"],
      parkOnArrivalDay: r() < 0.3,
      parkOnDepartureDay: r() < 0.3,
      allowThirdParty: r() < 0.7,
    },
    dining: { ...base.dining, policy: pick(["consider", "prefer", "exclude", "require"] as const) },
    transport: { mode: pick(["no_car", "own_car", "rental_car"] as const), rentalPerDayCents: 5_500 },
    budget: r() < 0.4 ? { hardLimitCents: 150_000 + Math.floor(r() * 500_000) } : r() < 0.5 ? { targetCents: 300_000 } : {},
    objective: r() < 0.5 ? "lowest_cost" : "best_value",
    weights: {
      price: Math.floor(r() * 100),
      resort: Math.floor(r() * 50),
      convenience: Math.floor(r() * 50),
      ticket: Math.floor(r() * 30),
      dining: Math.floor(r() * 30),
      dates: Math.floor(r() * 50) + 1,
    },
    eligibility: { florida_resident: pick(["yes", "no", "unknown"] as const), annual_passholder: "unknown", military: "unknown" },
    data: { includeIllustrative: r() < 0.85, staleAfterDays: 14 },
  };
}

const comparable = (res: OptimizationResult) => {
  const { stats: _s, runAt: _r, ...rest } = res;
  return JSON.parse(JSON.stringify(rest));
};

describe("lower-bound pruning", () => {
  it("never changes results (randomized requests and data)", () => {
    let prunedTotal = 0;
    let pricedTotal = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const r = rng(seed);
      const data = randomData(r);
      const request = randomRequest(r);
      const withPruning = optimize({ catalog: CATALOG, data, request, now: NOW, prune: true });
      const without = optimize({ catalog: CATALOG, data, request, now: NOW, prune: false });
      expect(comparable(withPruning), `seed ${seed}`).toEqual(comparable(without));
      expect(without.stats.pruned).toBe(0);
      prunedTotal += withPruning.stats.pruned;
      pricedTotal += withPruning.stats.priced;
    }
    // The test is only meaningful if pruning actually happened.
    expect(prunedTotal).toBeGreaterThan(pricedTotal);
  }, 120_000);

  it("never prunes a configuration requested for detail", () => {
    const request = defaultTripRequest();
    const data = mergePriceData([{ taxRates: TAX_RATES, transport: TRANSPORT }, ILLUSTRATIVE_DATA]);
    const full = optimize({ catalog: CATALOG, data, request, now: NOW, prune: false });
    const deep = full.dateMatrix[full.dateMatrix.length - 1]!.evaluationId;
    const res = optimize({ catalog: CATALOG, data, request, now: NOW, include: [deep] });
    expect(res.included.map((e) => e.id)).toEqual([deep]);
  });
});

import { describe, expect, it } from "vitest";
import { CATALOG } from "@/data/catalog";
import { defaultTripRequest } from "@/data/defaults";
import { ILLUSTRATIVE_DATA } from "@/data/illustrative";
import { applyRecheck } from "@/data/observations";
import { TAX_RATES, TRANSPORT } from "@/data/reference";
import { mergePriceData } from "@/data/sources";
import { optimize } from "@/domain/optimizer/optimize";
import type { Provenance } from "@/domain/provenance";
import type { Evaluation, PaymentTerms, PriceData, StayQuote, TicketPrice, TripRequest } from "@/domain/types";

/**
 * Known-scenario regression tests. Every quote and price below is FICTIONAL TEST
 * DATA with round numbers so each expected total can be checked by hand. They
 * run against the real catalog (so tax jurisdictions apply) and the reference
 * tax estimates: Orange County lodging 12.5%, sales 6.5%; Osceola lodging 13.5%.
 */

const NOW = new Date("2026-10-30T12:00:00Z");
const TEST: Provenance = { status: "manual", source: "TEST DATA (fictional)", observedAt: "2026-10-29" };

const hopper5 = (cents: number, over: Partial<TicketPrice> = {}): TicketPrice => ({
  id: `tp-${cents}-${over.channel ?? "d"}-${over.option ?? "ph"}`,
  kind: "ticket_price",
  option: "park_hopper",
  days: 5,
  age: "adult",
  validFrom: "2027-01-01",
  validTo: "2027-03-31",
  cents,
  taxIncluded: false,
  channel: "disney",
  provenance: TEST,
  ...over,
});

const quote = (over: Partial<StayQuote>): StayQuote => ({
  id: `q-${Math.random().toString(36).slice(2, 8)}`,
  kind: "stay_quote",
  label: "TEST quote",
  resortId: "pop-century",
  roomTypeId: "standard",
  checkIn: "2027-01-17",
  nights: 6,
  adults: 2,
  children: 0,
  bookingMethod: "separate",
  dining: "out_of_pocket",
  totalCents: 150_000,
  taxIncluded: true,
  provenance: TEST,
  ...over,
});

const data = (extra: Partial<PriceData>, withIllustrative = false): PriceData =>
  mergePriceData([{ taxRates: TAX_RATES, transport: TRANSPORT }, ...(withIllustrative ? [ILLUSTRATIVE_DATA] : []), extra]);

/** 2 adults, Jan 17–23 2027 (6 nights), 5 park days, Park Hopper, no food or car costs, real data only. */
function request(over: Partial<TripRequest> = {}): TripRequest {
  const base = defaultTripRequest();
  return {
    ...base,
    dates: { earliestArrival: "2027-01-17", latestDeparture: "2027-01-23", minNights: 6, maxNights: 6 },
    preferred: {},
    resorts: { allowedResortIds: ["pop-century"], requireOnProperty: true, preferredResortIds: [] },
    tickets: { ...base.tickets, parkDays: 5, allowedOptions: ["park_hopper"] },
    dining: { policy: "exclude", outOfPocketPerAdultPerNightCents: 0, outOfPocketPerChildPerNightCents: 0 },
    budget: {},
    data: { includeIllustrative: false, staleAfterDays: 14 },
    bookingDate: "2026-10-30",
    ...over,
  };
}

const run = (req: TripRequest, d: PriceData) => optimize({ catalog: CATALOG, data: d, request: req, now: NOW });
const line = (e: Evaluation, key: string) => e.lines.find((l) => l.key === key);
const find = (es: Evaluation[], f: (e: Evaluation) => boolean) => {
  const e = es.find(f);
  if (!e) throw new Error("expected evaluation not found");
  return e;
};

describe("scenario: room-only quote (tax-inclusive) + separately bought tickets", () => {
  it("adds tickets and ticket tax to the quoted room total, with no estimated room tax", () => {
    const res = run(request(), data({ stayQuotes: [quote({ totalCents: 150_000 })], ticketPrices: [hopper5(60_000)] }));
    const e = res.ranked[0]!;
    expect(e.quoteId).not.toBeNull();
    expect(line(e, "room")!.amountCents).toBe(150_000);
    expect(line(e, "room_tax")).toBeUndefined();
    expect(line(e, "tickets")!.amountCents).toBe(120_000);
    expect(line(e, "ticket_tax")!.amountCents).toBe(7_800); // 6.5% Orange County
    expect(e.totalCents).toBe(277_800);
    expect(e.dataStatus).toBe("estimated"); // the sales-tax rate is an estimate
  });
});

describe("scenario: package quote with a dining plan included", () => {
  it("uses the package total and shows room, tickets and dining as included (no double counting)", () => {
    const pkg = quote({ bookingMethod: "package", ticket: { option: "park_hopper", days: 5 }, dining: "quick_service_plan", totalCents: 390_000 });
    const req = request({ dining: { policy: "require", outOfPocketPerAdultPerNightCents: 9_000, outOfPocketPerChildPerNightCents: 0 } });
    const res = run(req, data({ stayQuotes: [pkg] }));
    const e = res.ranked[0]!;
    expect(e.config).toMatchObject({ bookingMethod: "package", dining: "quick_service_plan" });
    expect(e.totalCents).toBe(390_000);
    expect(e.lines.filter((l) => l.includedInQuote).map((l) => l.key).sort()).toEqual(["dining", "room", "tickets"]);
    expect(e.dataStatus).toBe("manual");
  });
});

describe("scenario: tax jurisdictions", () => {
  const roomOnlyPreTax = (resortId: string) =>
    quote({ id: `pre-${resortId}`, resortId, totalCents: 100_000, taxIncluded: false });

  it("estimates 13.5% at an Osceola County resort and 12.5% in Orange County on pre-tax quotes", () => {
    const req = request({
      resorts: { allowedResortIds: ["pop-century", "all-star-sports"], requireOnProperty: true, preferredResortIds: [] },
      tickets: { ...request().tickets, parkDays: 0 },
    });
    const res = run(req, data({ stayQuotes: [roomOnlyPreTax("pop-century"), roomOnlyPreTax("all-star-sports")] }));
    const pop = find(res.ranked, (e) => e.config.resortId === "pop-century");
    const allStar = find(res.ranked, (e) => e.config.resortId === "all-star-sports");
    expect(line(pop, "quote_tax")!.amountCents).toBe(12_500);
    expect(line(allStar, "quote_tax")!.amountCents).toBe(13_500);
    expect(line(allStar, "quote_tax")!.calculation).toMatch(/Osceola County/);
    expect(line(pop, "quote_tax")!.status).toBe("estimated");
  });

  it("adds separately quoted taxes exactly, without estimating", () => {
    const res = run(request({ tickets: { ...request().tickets, parkDays: 0 } }), data({ stayQuotes: [quote({ totalCents: 100_000, taxIncluded: false, taxCents: 12_345 })] }));
    const e = res.ranked[0]!;
    expect(line(e, "quote_tax")).toMatchObject({ amountCents: 12_345, status: "manual" });
    expect(e.totalCents).toBe(112_345);
  });

  it("applies the resort's jurisdiction to component (nightly-rate) pricing too", () => {
    const req = request({
      resorts: { allowedResortIds: ["all-star-music"], requireOnProperty: true, preferredResortIds: [] },
      tickets: { ...request().tickets, parkDays: 0 },
      dates: { earliestArrival: "2027-01-17", latestDeparture: "2027-01-21", minNights: 4, maxNights: 4 },
    });
    const rate = { id: "r", kind: "room_rate" as const, resortId: "all-star-music", roomTypeId: "standard", validFrom: "2027-01-01", validTo: "2027-01-31", nightlyCents: 15_000, taxIncluded: false, provenance: TEST };
    const e = run(req, data({ roomRates: [rate] })).ranked[0]!;
    expect(line(e, "room_tax")!.amountCents).toBe(8_100); // 13.5% of $600
  });

  it("never ranks a pre-tax package quote whose taxes can't be split", () => {
    const pkg = quote({ bookingMethod: "package", ticket: { option: "park_hopper", days: 5 }, totalCents: 250_000, taxIncluded: false });
    const res = run(request(), data({ stayQuotes: [pkg] }));
    expect(res.ranked).toHaveLength(0);
    // Shown as the incomplete option for this trip (it has fewer missing prices than component pricing).
    const e = find(res.excluded.incomplete, (x) => x.config.bookingMethod === "package");
    expect(e.quoteId).toBe(pkg.id);
    expect(line(e, "quote_tax")!.amountCents).toBeNull();
    expect(e.missing.join()).toMatch(/can't be split/);
  });
});

describe("scenario: different ticket configurations", () => {
  it("picks the cheaper accepted ticket type, and only like-for-like options count as alternatives", () => {
    const tickets = [hopper5(60_000), hopper5(45_000, { option: "base" })];
    const rq = quote({ totalCents: 150_000 });
    const req = request({
      tickets: { ...request().tickets, allowedOptions: ["base", "park_hopper"] },
      preferred: { arrival: "2027-01-17", nights: 6, resortId: "pop-century", roomTypeId: "standard", ticketOption: "park_hopper", bookingMethod: "separate", dining: "out_of_pocket" },
    });
    const res = run(req, data({ stayQuotes: [rq], ticketPrices: tickets }));
    const cheapest = res.ranked[0]!;
    expect(cheapest.config.ticketOption).toBe("base");
    expect(cheapest.totalCents).toBe(150_000 + 90_000 + 5_850);
    expect(cheapest.savings).toMatchObject({ savingsCents: 31_950, likeForLike: false });
    expect(res.awards.find((a) => a.kind === "best_alternative")).toBeUndefined();
  });

  it("skips a cheaper ticket whose recorded usage window can't cover the park days", () => {
    const tooShort = hopper5(50_000, { channel: "third_party", usage: { useWithinDays: 4, parkReservationRequired: false } });
    const res = run(request(), data({ stayQuotes: [quote({})], ticketPrices: [hopper5(60_000), tooShort] }));
    const e = res.ranked[0]!;
    expect(line(e, "tickets")!.amountCents).toBe(120_000); // the Disney ticket, not the unusable cheaper one
    expect(e.ticketUsability?.status).toBe("unknown"); // the Disney price has no recorded usage rule
  });

  it("rules a trip out when no ticket is usable, and says why", () => {
    const tooShort = hopper5(50_000, { usage: { useWithinDays: 4, parkReservationRequired: false } });
    const res = run(request(), data({ stayQuotes: [quote({})], ticketPrices: [tooShort] }));
    expect(res.ranked).toHaveLength(0);
    expect(res.stats.infeasibleReasons.some((r) => /No 5-day Park Hopper can cover 5 park days/.test(r.reason))).toBe(true);
  });

  it("applies product-level usage rules to matching tickets", () => {
    const rule = { id: "rule", kind: "ticket_rule" as const, option: "park_hopper" as const, days: null, channel: "disney" as const, usage: { useWithinDays: 8, parkReservationRequired: true }, provenance: TEST };
    const e = run(request(), data({ stayQuotes: [quote({})], ticketPrices: [hopper5(60_000)], ticketRules: [rule] })).ranked[0]!;
    expect(e.ticketUsability).toMatchObject({ status: "ok", parkReservationRequired: true });
  });
});

describe("scenario: promotions on component pricing", () => {
  it("applies an eligible 20% room offer and taxes the discounted room", () => {
    const rate = { id: "r", kind: "room_rate" as const, resortId: "pop-century", roomTypeId: "standard", validFrom: "2027-01-01", validTo: "2027-01-31", nightlyCents: 20_000, taxIncluded: false, provenance: TEST };
    const promo = { id: "p", name: "TEST 20% off", discount: { type: "room_percent" as const, pct: 20 }, travel: { from: "2027-01-01", to: "2027-01-31", rule: "all_nights" as const }, requiresPackage: false, terms: "test", provenance: TEST };
    const e = run(request({ tickets: { ...request().tickets, parkDays: 0 } }), data({ roomRates: [rate], promotions: [promo] })).ranked[0]!;
    expect(line(e, "room")!.amountCents).toBe(120_000);
    expect(line(e, "discount")!.amountCents).toBe(-24_000);
    expect(line(e, "room_tax")!.amountCents).toBe(12_000); // 12.5% of $960
    expect(e.totalCents).toBe(108_000);
  });
});

describe("scenario: DVC point stays", () => {
  const chart = (pointsPerNight: number) => ({
    id: `chart-${pointsPerNight}`,
    kind: "point_chart" as const,
    resortId: "saratoga-springs",
    roomTypeId: "studio",
    validFrom: "2027-01-01",
    validTo: "2027-01-31",
    pointsPerNight,
    provenance: TEST,
  });
  const nonRefundable: PaymentTerms = { depositCents: null, installments: [], refundability: "non_refundable", cancellationPenalties: [] };
  const rental = { id: "rent", kind: "point_cost" as const, label: "TEST broker", type: "rental" as const, centsPerPoint: 2_000, feeCents: 5_000, terms: nonRefundable, provenance: TEST };
  const cash = { id: "cash", kind: "room_rate" as const, resortId: "saratoga-springs", roomTypeId: "studio", validFrom: "2027-01-01", validTo: "2027-01-31", nightlyCents: 40_000, taxIncluded: false, provenance: TEST };
  const req = request({
    resorts: { allowedResortIds: ["saratoga-springs"], requireOnProperty: true, preferredResortIds: [], considerPoints: true },
    tickets: { ...request().tickets, parkDays: 0 },
  });

  it("prices points × cost per point plus fees, with no lodging tax, beside the cash option", () => {
    const res = run(req, data({ pointCharts: [chart(16)], pointCosts: [rental], roomRates: [cash] }));
    const points = find(res.ranked, (e) => e.config.bookingMethod === "points");
    const cashStay = find(res.ranked, (e) => e.config.bookingMethod === "separate");
    expect(line(points, "room")!.amountCents).toBe(96 * 2_000);
    expect(line(points, "points_fee")!.amountCents).toBe(5_000);
    expect(line(points, "room_tax")).toBeUndefined();
    expect(points.totalCents).toBe(197_000);
    expect(points.assumptions.join()).toMatch(/no per-stay lodging tax/);
    expect(cashStay.totalCents).toBe(240_000 + 30_000);
    expect(res.ranked[0]!.config.bookingMethod).toBe("points");
    // Booking terms travel with the point rental: non-refundable means the full amount is at risk.
    expect(points.payment?.cancellation).toMatchObject({ refundability: "non_refundable", penaltyCents: 197_000 });
  });

  it("is not offered when point stays are not enabled, or when no cost per point is recorded", () => {
    const off = run({ ...req, resorts: { ...req.resorts, considerPoints: false } }, data({ pointCharts: [chart(16)], pointCosts: [rental], roomRates: [cash] }));
    expect(off.ranked.every((e) => e.config.bookingMethod !== "points")).toBe(true);
    const noCost = run(req, data({ pointCharts: [chart(16)], roomRates: [cash] }));
    const studio = find(noCost.excluded.incomplete, (e) => e.config.bookingMethod === "points" && e.config.roomTypeId === "studio");
    expect(studio.missing.join()).toMatch(/no price per point/);
    expect(noCost.ranked.every((e) => e.config.bookingMethod !== "points")).toBe(true);
  });

  it("uses a point-rental quote as-is when one matches", () => {
    const q = quote({ resortId: "saratoga-springs", roomTypeId: "studio", bookingMethod: "points", totalCents: 180_000, points: { pointsRequired: 96, centsPerPoint: 1_875 } });
    const res = run(req, data({ stayQuotes: [q], pointCharts: [chart(16)], pointCosts: [rental] }));
    const e = find(res.ranked, (x) => x.config.bookingMethod === "points");
    expect(e.totalCents).toBe(180_000);
    expect(line(e, "room")!.calculation).toMatch(/96 points/);
  });
});

describe("scenario: deposits and cancellation exposure of an existing reservation", () => {
  const booked = (t: Partial<PaymentTerms>) =>
    quote({
      id: "mine",
      bookingMethod: "package",
      ticket: { option: "park_hopper", days: 5 },
      totalCents: 300_000,
      booked: true,
      terms: { depositCents: 20_000, installments: [], finalPaymentDueDate: "2026-12-18", amountPaidCents: 20_000, refundability: "refundable", cancellationPenalties: [], ...t },
    });
  const cheaper = quote({ id: "new", checkIn: "2027-01-18", bookingMethod: "package", ticket: { option: "park_hopper", days: 5 }, totalCents: 285_000 });
  const req = request({
    dates: { earliestArrival: "2027-01-17", latestDeparture: "2027-01-24", minNights: 6, maxNights: 6 },
    preferred: { arrival: "2027-01-17", nights: 6, resortId: "pop-century", roomTypeId: "standard", ticketOption: "park_hopper", bookingMethod: "package", dining: "out_of_pocket" },
  });

  it("keeps the amount due separate from the total, and nets cancellation costs out of savings", () => {
    const res = run(req, data({ stayQuotes: [booked({ cancellationPenalties: [{ fromDate: "2026-10-01", cents: 5_000 }] }), cheaper] }));
    expect(res.baseline!.payment).toMatchObject({ totalCents: 300_000, paidCents: 20_000, balanceCents: 280_000, dueToBookCents: 0 });
    const alt = res.awards.find((a) => a.kind === "best_alternative")!;
    const e = find(res.ranked, (x) => x.id === alt.evaluationId);
    expect(e.savings).toMatchObject({ savingsCents: 15_000, switching: { penaltyCents: 5_000, netSavingsCents: 10_000 } });
    expect(alt.explanation.join()).toMatch(/net saving is \$100\.00/);
  });

  it("does not claim a saving when cancelling would cost more than the price difference", () => {
    const res = run(req, data({ stayQuotes: [booked({ cancellationPenalties: [{ fromDate: "2026-10-01", cents: 20_000 }] }), cheaper] }));
    expect(res.awards.find((a) => a.kind === "best_alternative")).toBeUndefined();
    expect(res.notices.join()).toMatch(/switching would not save money/);
  });

  it("does not claim a saving when the cancellation cost is unknown", () => {
    const res = run(req, data({ stayQuotes: [booked({ refundability: "unknown" }), cheaper] }));
    expect(res.awards.find((a) => a.kind === "best_alternative")).toBeUndefined();
    expect(res.notices.join()).toMatch(/cancellation cost is unknown/);
  });

  it("treats an unbooked preferred quote normally (no switching cost)", () => {
    const res = run(req, data({ stayQuotes: [{ ...booked({}), booked: false }, cheaper] }));
    const alt = res.awards.find((a) => a.kind === "best_alternative");
    expect(alt).toBeDefined();
    expect(find(res.ranked, (x) => x.id === alt!.evaluationId).savings!.switching).toBeNull();
  });
});

describe("scenario: stale and refreshed observations", () => {
  it("marks an old quote stale, and a re-check refreshes it while keeping history", () => {
    const old = quote({ id: "old", provenance: { ...TEST, observedAt: "2026-09-01" } });
    const req = request({ tickets: { ...request().tickets, parkDays: 0 } });
    const before = run(req, data({ stayQuotes: [old] }));
    expect(before.ranked[0]!.dataStatus).toBe("stale");
    expect(before.notices.join()).toMatch(/older than 14 days/);

    const rechecked = applyRecheck(old, { observedAt: "2026-10-30", value: 155_000 }, "2026-10-30T12:00:00Z");
    if (!rechecked.ok) throw new Error(rechecked.error);
    const after = run(req, data({ stayQuotes: [rechecked.entry as StayQuote] }));
    expect(after.ranked[0]!.dataStatus).toBe("manual");
    expect(after.ranked[0]!.totalCents).toBe(155_000);
    expect((rechecked.entry as StayQuote).history![0]).toMatchObject({ observedAt: "2026-09-01", value: 150_000 });
  });
});

describe("scenario: flexible-date comparison", () => {
  it("finds the cheapest arrival among quotes for different dates and fills the date calendar", () => {
    const quotes = [
      quote({ id: "d17", checkIn: "2027-01-17", totalCents: 150_000 }),
      quote({ id: "d18", checkIn: "2027-01-18", totalCents: 138_000 }),
      quote({ id: "d19", checkIn: "2027-01-19", totalCents: 161_000 }),
    ];
    const req = request({
      dates: { earliestArrival: "2027-01-17", latestDeparture: "2027-01-25", minNights: 6, maxNights: 6 },
      tickets: { ...request().tickets, parkDays: 0 },
      preferred: { arrival: "2027-01-17", nights: 6, resortId: "pop-century", roomTypeId: "standard", bookingMethod: "separate", dining: "out_of_pocket" },
    });
    const res = run(req, data({ stayQuotes: quotes }));
    expect(res.ranked.map((e) => e.config.arrival)).toEqual(["2027-01-18", "2027-01-17", "2027-01-19"]);
    expect(res.dateMatrix.map((d) => d.totalCents)).toEqual([150_000, 138_000, 161_000]);
    const alt = res.awards.find((a) => a.kind === "best_alternative")!;
    expect(alt.evaluationId).toContain("2027-01-18");
    expect(alt.explanation.join()).toMatch(/\$120\.00 less/);
  });
});

describe("scenario: real quotes are never compared with illustrative prices", () => {
  it("sets illustrative options aside and bases awards on real quotes only", () => {
    const quotes = [quote({ id: "a", totalCents: 150_000 }), quote({ id: "b", checkIn: "2027-01-18", totalCents: 140_000 })];
    const req = request({
      dates: { earliestArrival: "2027-01-17", latestDeparture: "2027-01-25", minNights: 6, maxNights: 6 },
      resorts: { allowedResortIds: [], requireOnProperty: true, preferredResortIds: [] },
      tickets: { ...request().tickets, parkDays: 0 },
      data: { includeIllustrative: true, staleAfterDays: 14 },
    });
    const res = run(req, data({ stayQuotes: quotes }, true));
    expect(res.demoMode).toBe(false);
    expect(res.ranked.every((e) => !e.containsIllustrative)).toBe(true);
    expect(res.ranked.map((e) => e.totalCents)).toEqual([140_000, 150_000]);
    expect(res.excluded.illustrative.length).toBeGreaterThan(0);
    expect(res.awards.find((a) => a.kind === "cheapest")!.evaluationId).toContain("2027-01-18");
  });
});

// ── Milestone 6: hand-checked high-risk combinations ──────────────────────────

describe("scenario (M6): family with a child, component pricing", () => {
  const rate = { id: "r6", kind: "room_rate" as const, resortId: "pop-century", roomTypeId: "standard", validFrom: "2027-01-01", validTo: "2027-01-31", nightlyCents: 20_000, taxIncluded: false, provenance: TEST };
  const child = hopper5(55_000, { id: "tp-child", age: "child" });
  const req = request({ party: { adults: 2, children: 1, infants: 1 } });

  it("totals every component by hand: 6×$200 room + 12.5% + 2×$600 + $550 tickets + 6.5%", () => {
    const e = run(req, data({ roomRates: [rate], ticketPrices: [hopper5(60_000), child] })).ranked[0]!;
    // Room $1,200.00; lodging tax 12.5% = $150.00; tickets $1,200 + $550 = $1,750.00; sales tax 6.5% = $113.75. Infant: free.
    expect(line(e, "room")!.amountCents).toBe(120_000);
    expect(line(e, "room_tax")!.amountCents).toBe(15_000);
    expect(line(e, "tickets")!.amountCents).toBe(175_000);
    expect(line(e, "ticket_tax")!.amountCents).toBe(11_375);
    expect(e.totalCents).toBe(120_000 + 15_000 + 175_000 + 11_375);
    expect(e.complete).toBe(true);
  });

  it("a missing child price makes the option incomplete, never cheaper", () => {
    const r = run(req, data({ roomRates: [rate], ticketPrices: [hopper5(60_000)] }));
    expect(r.ranked).toHaveLength(0);
    const e = r.excluded.incomplete[0]!;
    expect(e.complete).toBe(false);
    expect(e.missing.join()).toMatch(/No child price/);
    expect(line(e, "tickets")!.amountCents).toBeNull();
  });
});

describe("scenario (M6): a tax-exclusive package quote with an eligible promotion", () => {
  it("uses quote + quoted taxes and never re-applies the promotion to the quote", () => {
    const pkg = quote({ bookingMethod: "package", ticket: { option: "park_hopper", days: 5 }, totalCents: 300_000, taxIncluded: false, taxCents: 31_000 });
    const promo = { id: "p6", name: "TEST 30% off rooms", discount: { type: "room_percent" as const, pct: 30 }, travel: { from: "2027-01-01", to: "2027-01-31", rule: "all_nights" as const }, requiresPackage: false, terms: "test", provenance: TEST };
    const r = run(request(), data({ stayQuotes: [pkg], promotions: [promo] }));
    const e = find(r.ranked, (x) => x.quoteId === pkg.id);
    // $3,000.00 + $310.00 quoted taxes; no discount line, no estimated taxes on top.
    expect(e.totalCents).toBe(331_000);
    expect(line(e, "discount")).toBeUndefined();
    expect(e.lines.filter((l) => l.key === "room_tax" && l.status === "estimated")).toHaveLength(0);
  });
});

describe("scenario (M6): preference scoring depends on the alternatives present", () => {
  it("price score is cheapest ÷ this total, so adding a cheaper option lowers others' price scores (documented behaviour)", () => {
    const a = quote({ id: "qa", totalCents: 200_000 });
    const b = quote({ id: "qb", resortId: "all-star-movies", totalCents: 100_000 });
    const req2 = request({ objective: "best_value", resorts: { allowedResortIds: ["pop-century", "all-star-movies"], requireOnProperty: true, preferredResortIds: [] } });
    const priceScore = (r: ReturnType<typeof run>, id: string) => find(r.ranked, (e) => e.quoteId === id).valueScore!.parts.find((p) => p.key === "price")!.score;
    const tickets = [hopper5(50_000)];
    const alone = run(req2, data({ stayQuotes: [a], ticketPrices: tickets }));
    const both = run(req2, data({ stayQuotes: [a, b], ticketPrices: tickets }));
    expect(priceScore(alone, "qa")).toBe(100);
    // Totals: A $2,000 + tickets $1,000 + 6.5% tax $65 = $3,065; B $1,000 + $1,065 = $2,065. Score = round(100 × 2,065 ÷ 3,065) = 67.
    expect(priceScore(both, "qa")).toBe(67);
    expect(priceScore(both, "qb")).toBe(100);
  });
});

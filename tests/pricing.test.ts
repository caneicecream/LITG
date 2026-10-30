import { describe, expect, it } from "vitest";
import { priceConfiguration, type PricingContext } from "@/domain/pricing/calculate";
import { checkEligibility } from "@/domain/pricing/promotions";
import { pickBest, resolveRoomNights, resolveTicket } from "@/domain/pricing/resolve";
import type { Configuration, PriceData, TripRequest } from "@/domain/types";
import { baseData, baseRequest, catalog, promo, prov, quote, rate, ticket, TODAY } from "./fixtures";

const opts = { today: TODAY, staleAfterDays: 14, includeIllustrative: true };

function ctx(data: PriceData = baseData(), request: TripRequest = baseRequest()): PricingContext {
  return { catalog, data, request, opts: { ...opts, includeIllustrative: request.data.includeIllustrative }, bookingDate: TODAY };
}

const cfg = (over: Partial<Configuration> = {}): Configuration => ({
  arrival: "2027-02-01",
  nights: 4,
  resortId: "a",
  roomTypeId: "std",
  ticketOption: "base",
  bookingMethod: "separate",
  dining: "out_of_pocket",
  ...over,
});

const line = (r: ReturnType<typeof priceConfiguration>, key: string) => r.lines.find((l) => l.key === key);

describe("price resolution", () => {
  it("prefers real data over illustrative, and newer over older at equal trust", () => {
    const items = [
      { id: "1", provenance: prov("illustrative") },
      { id: "2", provenance: prov("manual", "2026-12-25") },
      { id: "3", provenance: prov("manual", "2026-12-30") },
    ];
    expect(pickBest(items, opts)?.item.id).toBe("3");
  });
  it("ranks a stale real observation below a fresh one but above an estimate", () => {
    const items = [
      { id: "old", provenance: prov("manual", "2026-10-01") },
      { id: "est", provenance: prov("estimated") },
    ];
    const best = pickBest(items, opts)!;
    expect(best.item.id).toBe("old");
    expect(best.status).toBe("stale");
  });
  it("ignores illustrative data when excluded", () => {
    expect(pickBest([{ id: "1", provenance: prov("illustrative") }], { ...opts, includeIllustrative: false })).toBeNull();
  });
  it("resolves weekday-specific rates and reports missing nights", () => {
    const data = baseData({
      roomRates: [
        rate("a", 10_000, { daysOfWeek: [0, 1, 2, 3, 4] }),
        rate("a", 15_000, { daysOfWeek: [5, 6] }),
      ],
    });
    // Fri 2027-02-05, Sat 02-06, Sun 02-07
    const r = resolveRoomNights(data, "a", "std", ["2027-02-05", "2027-02-06", "2027-02-07"], opts);
    expect(r.nights.map((n) => n.cents)).toEqual([15_000, 15_000, 10_000]);
    const missing = resolveRoomNights(data, "a", "std", ["2028-01-01"], opts);
    expect(missing.missing).toEqual(["2028-01-01"]);
  });
  it("uses a cheaper third-party ticket only for separate bookings and only at equal trust", () => {
    const data = baseData({
      ticketPrices: [
        ticket("base", "adult", 30_000),
        ticket("base", "adult", 28_000, { channel: "third_party" }),
        ticket("base", "adult", 20_000, { channel: "third_party", provenance: prov("illustrative") }),
      ],
    });
    expect(resolveTicket(data, "base", 3, "adult", "2027-02-02", "separate", true, opts)?.item.cents).toBe(28_000);
    expect(resolveTicket(data, "base", 3, "adult", "2027-02-02", "package", true, opts)?.item.cents).toBe(30_000);
    expect(resolveTicket(data, "base", 3, "adult", "2027-02-02", "separate", false, opts)?.item.cents).toBe(30_000);
  });
});

describe("cost calculation", () => {
  it("prices room, taxes, tickets and transport exactly", () => {
    const r = priceConfiguration(cfg(), ctx());
    expect(line(r, "room")?.amountCents).toBe(40_000);
    expect(line(r, "room_tax")?.amountCents).toBe(4_000);
    expect(line(r, "tickets")?.amountCents).toBe(60_000);
    expect(line(r, "ticket_tax")?.amountCents).toBe(3_000);
    expect(line(r, "transport")?.amountCents).toBe(0);
    expect(r.totalCents).toBe(107_000);
    expect(r.complete).toBe(true);
    expect(r.dataStatus).toBe("estimated"); // taxes are estimated
    expect(r.statusTotals).toEqual({ manual: 100_000, estimated: 7_000 });
  });

  it("starts tickets on arrival day only when the user parks on arrival day", () => {
    const data = baseData({
      ticketPrices: [
        ticket("base", "adult", 30_000, { validFrom: "2027-02-01", validTo: "2027-02-01" }),
        ticket("base", "adult", 50_000, { validFrom: "2027-02-02", validTo: "2027-02-02" }),
      ],
    });
    const late = priceConfiguration(cfg(), ctx(data));
    expect(line(late, "tickets")?.amountCents).toBe(100_000);
    const early = priceConfiguration(
      cfg(),
      ctx(data, baseRequest({ tickets: { ...baseRequest().tickets, parkOnArrivalDay: true } })),
    );
    expect(line(early, "tickets")?.amountCents).toBe(60_000);
  });

  it("prices children separately and infants free", () => {
    const req = baseRequest({ party: { adults: 2, children: 1, infants: 1 } });
    const r = priceConfiguration(cfg(), ctx(baseData(), req));
    expect(line(r, "tickets")?.amountCents).toBe(85_000);
    expect(r.assumptions.join(" ")).toMatch(/under 3/);
  });

  it("marks a missing component unavailable instead of dropping it", () => {
    const data = baseData({ roomRates: [rate("a", 10_000, { validTo: "2027-02-02" })] });
    const r = priceConfiguration(cfg(), ctx(data));
    expect(r.complete).toBe(false);
    expect(line(r, "room")?.amountCents).toBeNull();
    expect(line(r, "room")?.status).toBe("unavailable");
    expect(r.dataStatus).toBe("unavailable");
    expect(r.missing[0]).toMatch(/No rate for 2 of 4 nights/);
    // Total is a lower bound: tickets still counted, room not.
    expect(r.totalCents).toBe(63_000);
  });

  it("does not double-count components included in a package quote", () => {
    const data = baseData({ stayQuotes: [quote({ totalCents: 95_000 })] });
    const req = baseRequest({ otherExpenses: [{ label: "Airport transfer", cents: 5_000, per: "trip" }] });
    const r = priceConfiguration(cfg({ bookingMethod: "package" }), ctx(data, req));
    expect(line(r, "package")?.amountCents).toBe(95_000);
    expect(line(r, "room")).toMatchObject({ amountCents: 0, includedInQuote: true });
    expect(line(r, "tickets")).toMatchObject({ amountCents: 0, includedInQuote: true });
    expect(line(r, "room_tax")).toBeUndefined();
    expect(line(r, "ticket_tax")).toBeUndefined();
    expect(r.totalCents).toBe(100_000);
    expect(r.dataStatus).toBe("estimated"); // the user's other-expense estimate
  });

  it("only matches a package quote with the same tickets, dining and party", () => {
    const data = baseData({
      stayQuotes: [quote({ ticket: { option: "park_hopper", days: 3 } }), quote({ adults: 3 }), quote({ ticket: { option: "base", days: 2 } })],
    });
    const r = priceConfiguration(cfg({ bookingMethod: "package" }), ctx(data));
    expect(line(r, "package")).toBeUndefined();
    expect(r.totalCents).toBe(107_000);
  });

  it("uses a tax-inclusive room-only quote without adding estimated tax", () => {
    const data = baseData({ stayQuotes: [quote({ bookingMethod: "separate", ticket: undefined, totalCents: 41_000 })] });
    const r = priceConfiguration(cfg(), ctx(data));
    expect(line(r, "room")?.amountCents).toBe(41_000);
    expect(line(r, "room_tax")).toBeUndefined();
    expect(r.totalCents).toBe(41_000 + 63_000);
  });

  it("applies a percent room promotion and taxes the discounted room", () => {
    const data = baseData({ promotions: [promo({})] });
    const r = priceConfiguration(cfg(), ctx(data));
    expect(line(r, "discount")?.amountCents).toBe(-8_000);
    expect(line(r, "room_tax")?.amountCents).toBe(3_200);
    expect(r.totalCents).toBe(107_000 - 8_000 - 800);
    expect(r.appliedPromotion?.savingsCents).toBe(8_000);
  });

  it("applies a per-night promotion only to nights inside its window", () => {
    const data = baseData({ promotions: [promo({ travel: { from: "2027-01-01", to: "2027-02-02", rule: "per_night" } })] });
    const r = priceConfiguration(cfg(), ctx(data));
    expect(line(r, "discount")?.amountCents).toBe(-4_000);
    expect(line(r, "discount")?.calculation).toMatch(/2 of 4 nights/);
  });

  it("never applies a promotion to a quoted price", () => {
    const data = baseData({ stayQuotes: [quote({})], promotions: [promo({})] });
    const r = priceConfiguration(cfg({ bookingMethod: "package" }), ctx(data));
    expect(line(r, "discount")).toBeUndefined();
  });

  it("reports but does not apply promotions with unconfirmed eligibility", () => {
    const data = baseData({ promotions: [promo({ audience: ["florida_resident"] })] });
    const unknown = priceConfiguration(cfg(), ctx(data));
    expect(unknown.appliedPromotion).toBeNull();
    expect(unknown.potentialPromotions[0]?.potentialSavingsCents).toBe(8_000);
    expect(unknown.totalCents).toBe(107_000);

    const yes = baseRequest({ eligibility: { florida_resident: "yes", annual_passholder: "unknown", military: "unknown" } });
    expect(priceConfiguration(cfg(), ctx(data, yes)).appliedPromotion?.savingsCents).toBe(8_000);

    const no = baseRequest({ eligibility: { florida_resident: "no", annual_passholder: "unknown", military: "unknown" } });
    const r = priceConfiguration(cfg(), ctx(data, no));
    expect(r.appliedPromotion).toBeNull();
    expect(r.potentialPromotions).toEqual([]);
  });

  it("picks the single best eligible promotion (offers do not stack)", () => {
    const data = baseData({
      promotions: [
        promo({ id: "p10", discount: { type: "room_percent", pct: 10 } }),
        promo({ id: "p30", discount: { type: "room_percent", pct: 30 } }),
        promo({ id: "fixed", discount: { type: "room_fixed_per_night", cents: 2_500 } }),
      ],
    });
    const r = priceConfiguration(cfg(), ctx(data));
    expect(r.appliedPromotion?.promotionId).toBe("p30");
    expect(r.lines.filter((l) => l.category === "discount")).toHaveLength(1);
  });

  it("propagates illustrative status from a demo promotion onto real prices", () => {
    const data = baseData({ promotions: [promo({ provenance: prov("illustrative") })] });
    const r = priceConfiguration(cfg(), ctx(data));
    expect(line(r, "discount")?.status).toBe("illustrative");
    expect(r.containsIllustrative).toBe(true);
  });

  it("prices dining plans per person per night and out-of-pocket food from the user's estimate", () => {
    const req = baseRequest({
      party: { adults: 2, children: 1, infants: 0 },
      dining: { policy: "consider", outOfPocketPerAdultPerNightCents: 8_000, outOfPocketPerChildPerNightCents: 4_000 },
    });
    const plan = priceConfiguration(cfg({ bookingMethod: "package", dining: "dining_plan" }), ctx(baseData(), req));
    expect(line(plan, "dining")?.amountCents).toBe(4 * (2 * 9_000 + 3_000));
    expect(line(plan, "dining_tax")).toBeUndefined(); // tax-inclusive plan price
    const oop = priceConfiguration(cfg(), ctx(baseData(), req));
    expect(line(oop, "dining")).toMatchObject({ amountCents: 4 * 20_000, status: "estimated" });
  });

  it("adds parking and rental car costs when the party drives", () => {
    const req = baseRequest({ transport: { mode: "rental_car", rentalPerDayCents: 5_000 } });
    const r = priceConfiguration(cfg({ resortId: "off", bookingMethod: "separate" }), ctx(baseData(), req));
    expect(line(r, "transport")?.amountCents).toBe(4 * 1_000 + 3 * 2_000);
    expect(line(r, "rental_car")?.amountCents).toBe(20_000);
  });

  it("scales other expenses by trip, night, person and person-night", () => {
    const req = baseRequest({
      party: { adults: 2, children: 1, infants: 0 },
      otherExpenses: [
        { label: "Trip", cents: 100, per: "trip" },
        { label: "Night", cents: 100, per: "night" },
        { label: "Person", cents: 100, per: "person" },
        { label: "PN", cents: 100, per: "person_night" },
      ],
    });
    const r = priceConfiguration(cfg(), ctx(baseData(), req));
    expect(r.lines.filter((l) => l.category === "other").map((l) => l.amountCents)).toEqual([100, 400, 300, 1200]);
  });
});

describe("promotion eligibility", () => {
  const resort = catalog.resorts[0]!;
  const base = {
    config: cfg(),
    resort,
    nights: ["2027-02-01", "2027-02-02", "2027-02-03", "2027-02-04"],
    partySize: 2,
    parkDays: 3,
    bookingDate: TODAY,
    eligibility: { florida_resident: "unknown", annual_passholder: "unknown", military: "unknown" } as const,
  };
  it("checks each structured condition", () => {
    expect(checkEligibility(promo({ requiresPackage: true }), base)).toMatchObject({ kind: "ineligible" });
    expect(checkEligibility(promo({ resortIds: ["b"] }), base)).toMatchObject({ kind: "ineligible" });
    expect(checkEligibility(promo({ minNights: 5 }), base)).toMatchObject({ kind: "ineligible" });
    expect(checkEligibility(promo({ maxNights: 3 }), base)).toMatchObject({ kind: "ineligible" });
    expect(checkEligibility(promo({ minTicketDays: 4 }), base)).toMatchObject({ kind: "ineligible" });
    expect(checkEligibility(promo({ minPartySize: 3 }), base)).toMatchObject({ kind: "ineligible" });
    expect(checkEligibility(promo({ booking: { from: "2027-01-05", to: "2027-01-31" } }), base)).toMatchObject({ kind: "ineligible" });
    expect(checkEligibility(promo({ roomKeys: ["a/other"] }), base)).toMatchObject({ kind: "ineligible" });
    expect(checkEligibility(promo({}), base)).toMatchObject({ kind: "eligible" });
  });
  it("requires every night in the window for all-nights offers, and respects blackouts", () => {
    const p = promo({ travel: { from: "2027-01-01", to: "2027-02-03", rule: "all_nights" } });
    expect(checkEligibility(p, base).kind).toBe("ineligible");
    const arrival = promo({ travel: { from: "2027-01-01", to: "2027-02-01", rule: "arrival_date" } });
    expect(checkEligibility(arrival, base).kind).toBe("eligible");
    expect(checkEligibility({ ...arrival, blackoutNights: ["2027-02-03"] }, base).kind).toBe("ineligible");
  });
  it("does not apply resort-unrestricted offers off property", () => {
    expect(checkEligibility(promo({}), { ...base, resort: catalog.resorts[2]! }).kind).toBe("ineligible");
  });
});

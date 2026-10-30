import { describe, expect, it } from "vitest";
import { CATALOG } from "@/data/catalog";
import { defaultTripRequest } from "@/data/defaults";
import { ILLUSTRATIVE_DATA } from "@/data/illustrative";
import { TAX_RATES, TRANSPORT } from "@/data/reference";
import { mergePriceData, splitEntries } from "@/data/sources";
import { optimize } from "@/domain/optimizer/optimize";
import { parseTripRequest } from "@/domain/schema";
import type { StayQuote } from "@/domain/types";

const NOW = new Date("2026-10-30T12:00:00Z");
const data = (extra: Parameters<typeof mergePriceData>[0] = []) =>
  mergePriceData([{ taxRates: TAX_RATES, transport: TRANSPORT }, ILLUSTRATIVE_DATA, ...extra]);

describe("bundled data integrity", () => {
  it("tags every demo price and promotion as illustrative", () => {
    const all = [
      ...ILLUSTRATIVE_DATA.roomRates,
      ...ILLUSTRATIVE_DATA.ticketPrices,
      ...ILLUSTRATIVE_DATA.diningPlanPrices,
      ...ILLUSTRATIVE_DATA.promotions,
    ];
    expect(all.length).toBeGreaterThan(100);
    expect(all.every((x) => x.provenance.status === "illustrative")).toBe(true);
    expect(ILLUSTRATIVE_DATA.promotions.every((p) => p.name.startsWith("Illustrative:"))).toBe(true);
  });
  it("tags reference taxes and transport as estimates, never verified", () => {
    expect([...TAX_RATES, ...TRANSPORT].every((x) => x.provenance.status === "estimated")).toBe(true);
  });
  it("covers every catalog room with demo rates", () => {
    for (const r of CATALOG.resorts)
      for (const room of r.roomTypes)
        expect(ILLUSTRATIVE_DATA.roomRates.some((x) => x.resortId === r.id && x.roomTypeId === room.id)).toBe(true);
  });
  it("has non-overlapping demo seasons for each weekday group", () => {
    const pop = ILLUSTRATIVE_DATA.roomRates.filter((r) => r.resortId === "pop-century" && r.daysOfWeek?.includes(0));
    const sorted = [...pop].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.validFrom > sorted[i - 1]!.validTo).toBe(true);
  });
});

describe("default scenario end-to-end", () => {
  it("validates, runs quickly, and produces a labelled demo result", () => {
    const req = defaultTripRequest();
    expect(parseTripRequest(req).ok).toBe(true);
    const t0 = performance.now();
    const res = optimize({ catalog: CATALOG, data: data(), request: req, now: NOW });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(5000);
    expect(res.demoMode).toBe(true);
    expect(res.ranked.length).toBeGreaterThan(10);
    expect(res.ranked.every((e) => e.complete && e.violations.length === 0)).toBe(true);
    expect(res.awards.map((a) => a.kind)).toEqual(expect.arrayContaining(["cheapest", "best_value", "best_alternative"]));
    expect(res.baseline?.complete).toBe(true);
    // Every ranked total equals the sum of its lines.
    for (const e of res.ranked) expect(e.totalCents).toBe(e.lines.reduce((a, l) => a + (l.amountCents ?? 0), 0));
    // The cheapest option is not more expensive than the baseline when the baseline is in range.
    const cheapest = res.ranked.find((e) => e.id === res.awards.find((a) => a.kind === "cheapest")!.evaluationId)!;
    expect(cheapest.totalCents).toBeLessThanOrEqual(res.baseline!.totalCents);
  });

  it("switches from demo mode to real prices as soon as a full real quote exists", () => {
    const req = defaultTripRequest();
    const q: StayQuote = {
      id: "real-1",
      kind: "stay_quote",
      label: "Pop Century package from booking site",
      resortId: "pop-century",
      roomTypeId: "standard",
      checkIn: "2027-01-17",
      nights: 6,
      adults: 2,
      children: 0,
      bookingMethod: "package",
      ticket: { option: "park_hopper_plus", days: 5 },
      dining: "out_of_pocket",
      totalCents: 260_000,
      taxIncluded: true,
      provenance: { status: "manual", source: "disneyworld.com quote", observedAt: "2026-10-29" },
    };
    const res = optimize({ catalog: CATALOG, data: data([splitEntries([q])]), request: req, now: NOW });
    expect(res.demoMode).toBe(false);
    expect(res.ranked).toHaveLength(1);
    expect(res.ranked[0]?.dataStatus).toBe("estimated"); // food estimate is the user's own assumption
    expect(res.excluded.illustrative.length).toBeGreaterThan(0);
    // The baseline (separate booking, illustrative) can't be compared with a real quote.
    expect(res.ranked[0]?.savings).toBeNull();
  });

  it("recalculates when the budget, dates or ticket choice change", () => {
    const req = defaultTripRequest();
    const a = optimize({ catalog: CATALOG, data: data(), request: req, now: NOW });
    const noHopper = optimize({
      catalog: CATALOG,
      data: data(),
      request: { ...req, tickets: { ...req.tickets, allowedOptions: ["base"] }, preferred: { ...req.preferred, ticketOption: "base" } },
      now: NOW,
    });
    expect(noHopper.ranked[0]!.totalCents).toBeLessThan(a.ranked[0]!.totalCents);
    expect(noHopper.ranked.every((e) => e.config.ticketOption === "base")).toBe(true);

    const tight = optimize({ catalog: CATALOG, data: data(), request: { ...req, budget: { hardLimitCents: 300_000 } }, now: NOW });
    expect(tight.ranked.every((e) => e.totalCents <= 300_000)).toBe(true);
  });
});

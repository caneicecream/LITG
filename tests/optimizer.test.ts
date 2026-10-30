import { describe, expect, it } from "vitest";
import { optimize } from "@/domain/optimizer/optimize";
import { availableParkDays, checkHardConstraints } from "@/domain/optimizer/constraints";
import type { TripRequest } from "@/domain/types";
import { baseData, baseRequest, catalog, NOW, promo, prov, quote, rate } from "./fixtures";

const run = (request: TripRequest, data = baseData()) => optimize({ catalog, data, request, now: NOW });

const flexible = (over: Partial<TripRequest> = {}) =>
  baseRequest({
    dates: { earliestArrival: "2027-02-01", latestDeparture: "2027-02-10", minNights: 4, maxNights: 4 },
    resorts: { allowedResortIds: ["a"], requireOnProperty: true, preferredResortIds: [] },
    ...over,
  });

describe("hard constraints", () => {
  const resortA = catalog.resorts[0]!;
  const cfg = { arrival: "2027-02-01", nights: 4, resortId: "a", roomTypeId: "std", ticketOption: "base" as const, bookingMethod: "separate" as const, dining: "out_of_pocket" as const };
  it("computes available park days", () => {
    expect(availableParkDays(4, false, false)).toBe(3);
    expect(availableParkDays(4, true, true)).toBe(5);
  });
  it("rejects too many park days, oversized parties and dining plans without packages", () => {
    expect(checkHardConstraints(cfg, resortA, baseRequest({ tickets: { ...baseRequest().tickets, parkDays: 4 } }))[0]).toMatch(/Only 3 possible park days/);
    expect(checkHardConstraints(cfg, resortA, baseRequest({ party: { adults: 4, children: 0, infants: 1 } }))[0]).toMatch(/sleeps 4/);
    expect(checkHardConstraints({ ...cfg, dining: "dining_plan" }, resortA, baseRequest({ dining: { ...baseRequest().dining, policy: "consider" } }))).toContain(
      "Disney dining plans can only be purchased as part of a package",
    );
  });
  it("enforces on-property requirement and resort allow-list", () => {
    const off = catalog.resorts[2]!;
    const req = baseRequest({ resorts: { allowedResortIds: ["a"], requireOnProperty: true, preferredResortIds: [] } });
    const v = checkHardConstraints({ ...cfg, resortId: "off" }, off, req);
    expect(v).toContain("You require a Disney-owned resort");
    expect(v.join()).toMatch(/not in your allowed resorts/);
  });
});

describe("optimizer", () => {
  it("finds the lowest-cost configuration across all options", () => {
    const res = run(baseRequest());
    // Off-site: 200 + 20 tax + 600 + 30 tax + 3 days × $30 rideshare = $940
    expect(res.ranked[0]?.config.resortId).toBe("off");
    expect(res.ranked[0]?.totalCents).toBe(94_000);
    expect(res.awards.find((a) => a.kind === "cheapest")?.evaluationId).toBe(res.ranked[0]?.id);
    expect(res.demoMode).toBe(false);
  });

  it("respects a must-stay-on-property constraint even when off-site is cheaper", () => {
    const res = run(baseRequest({ resorts: { allowedResortIds: [], requireOnProperty: true, preferredResortIds: [] } }));
    expect(res.ranked.every((e) => e.config.resortId !== "off")).toBe(true);
    expect(res.ranked[0]?.totalCents).toBe(107_000);
  });

  it("explores flexible dates and picks the cheapest arrival", () => {
    const data = baseData({
      roomRates: [rate("a", 10_000, { provenance: prov("manual", "2026-12-30") }), rate("a", 6_000, { validFrom: "2027-02-05", validTo: "2027-02-09", id: "cheap" })],
    });
    const res = run(flexible(), data);
    // Arrivals Feb 1..Feb 6 (4 nights, depart by Feb 10). Feb 5 or 6 arrivals get 4 cheap nights.
    const best = res.ranked[0]!;
    expect(best.config.arrival).toBe("2027-02-05");
    expect(best.totalCents).toBe(24_000 + 2_400 + 63_000);
    expect(res.dateMatrix).toHaveLength(6);
    expect(res.dateMatrix.find((d) => d.arrival === "2027-02-01")?.totalCents).toBe(107_000);
  });

  it("evaluates variable stay lengths and reports per-night costs", () => {
    const res = run(flexible({ dates: { earliestArrival: "2027-02-01", latestDeparture: "2027-02-10", minNights: 4, maxNights: 6 } }));
    const lengths = new Set(res.ranked.map((e) => e.config.nights));
    expect([...lengths].sort()).toEqual([4, 5, 6]);
    const six = res.ranked.find((e) => e.config.nights === 6)!;
    expect(six.perNightCents).toBe(Math.round(six.totalCents / 6));
    expect(six.perParkDayCents).toBe(Math.round(six.totalCents / 3));
  });

  it("excludes options over a hard limit and shows the cheapest over-limit options when none fit", () => {
    const res = run(flexible({ budget: { hardLimitCents: 100_000 } }));
    expect(res.ranked).toHaveLength(0);
    expect(res.excluded.overHardLimit[0]?.totalCents).toBe(107_000);
    expect(res.notices.join(" ")).toMatch(/No fully priced option fits your hard limit/);
    expect(res.awards).toHaveLength(0);
  });

  it("flags but keeps options over a soft target budget", () => {
    const res = run(flexible({ budget: { targetCents: 100_000 } }));
    expect(res.ranked[0]?.budget.overTargetCents).toBe(7_000);
  });

  it("never ranks an incomplete configuration alongside complete ones", () => {
    // Resort B has no rates at all: its total (tickets only) is lower but incomplete.
    const data = baseData({ roomRates: [rate("a", 10_000)] });
    const res = run(baseRequest({ resorts: { allowedResortIds: ["a", "b"], requireOnProperty: true, preferredResortIds: [] } }), data);
    expect(res.ranked.map((e) => e.config.resortId)).toEqual(["a"]);
    expect(res.excluded.incomplete[0]?.config.resortId).toBe("b");
    expect(res.excluded.incomplete[0]!.totalCents).toBeLessThan(res.ranked[0]!.totalCents);
  });

  it("sets illustrative results aside when real prices are available", () => {
    const data = baseData({ roomRates: [rate("a", 10_000), rate("b", 1_000, { provenance: prov("illustrative") })] });
    const res = run(baseRequest({ resorts: { allowedResortIds: ["a", "b"], requireOnProperty: true, preferredResortIds: [] } }), data);
    expect(res.demoMode).toBe(false);
    expect(res.ranked.map((e) => e.config.resortId)).toEqual(["a"]);
    expect(res.excluded.illustrative[0]?.config.resortId).toBe("b");
    expect(res.awards.every((a) => !a.evaluationId.includes("|b|"))).toBe(true);
  });

  it("enters demo mode when only illustrative data is available, and drops it when excluded", () => {
    const demo = baseData({ roomRates: [rate("a", 10_000, { provenance: prov("illustrative") })] });
    const req = baseRequest({ resorts: { allowedResortIds: ["a"], requireOnProperty: true, preferredResortIds: [] } });
    const res = run(req, demo);
    expect(res.demoMode).toBe(true);
    expect(res.notices[0]).toMatch(/ILLUSTRATIVE/);
    const off = run({ ...req, data: { includeIllustrative: false, staleAfterDays: 14 } }, demo);
    expect(off.ranked).toHaveLength(0);
    expect(off.excluded.incomplete).toHaveLength(1);
  });

  it("computes like-for-like savings against the preferred plan and awards the best alternative", () => {
    const data = baseData({
      roomRates: [rate("a", 10_000, { provenance: prov("manual", "2026-12-30") }), rate("a", 6_000, { validFrom: "2027-02-05", validTo: "2027-02-09", id: "cheap" })],
    });
    const req = flexible({
      preferred: { arrival: "2027-02-01", nights: 4, resortId: "a", roomTypeId: "std", ticketOption: "base" },
    });
    const res = run(req, data);
    expect(res.baseline?.totalCents).toBe(107_000);
    const alt = res.awards.find((a) => a.kind === "best_alternative");
    const altEval = res.ranked.find((e) => e.id === alt?.evaluationId)!;
    expect(altEval.savings).toMatchObject({ savingsCents: 107_000 - 89_400, likeForLike: true });
    expect(alt?.explanation.join(" ")).toMatch(/Lodging −\$176\.00/);
  });

  it("marks savings from a longer or shorter stay as not like-for-like", () => {
    const req = flexible({
      dates: { earliestArrival: "2027-02-01", latestDeparture: "2027-02-10", minNights: 4, maxNights: 5 },
      preferred: { arrival: "2027-02-01", nights: 5, resortId: "a", roomTypeId: "std", ticketOption: "base" },
    });
    const res = run(req);
    const four = res.ranked.find((e) => e.config.nights === 4)!;
    expect(four.savings?.likeForLike).toBe(false);
    expect(four.savings?.basis).toMatch(/4 vs 5 nights/);
    // The cheaper 4-night trip must not be offered as a "best alternative".
    expect(res.awards.find((a) => a.kind === "best_alternative")).toBeUndefined();
  });

  it("does not claim savings when the baseline cannot be fully priced", () => {
    const req = flexible({ preferred: { arrival: "2027-06-01", nights: 4, resortId: "a", roomTypeId: "std", ticketOption: "base" } });
    const data = baseData({ roomRates: [rate("a", 10_000, { validTo: "2027-03-01" })] });
    const res = run(req, data);
    expect(res.baseline?.complete).toBe(false);
    expect(res.baselineNote).toMatch(/could not be fully priced/);
    expect(res.ranked.every((e) => e.savings === null)).toBe(true);
  });

  it("chooses a package over separate booking when a package-only offer makes it cheaper, and records the other method", () => {
    const data = baseData({ promotions: [promo({ requiresPackage: true, discount: { type: "package_fixed", cents: 5_000 } })] });
    const res = run(flexible({ dates: { earliestArrival: "2027-02-01", latestDeparture: "2027-02-05", minNights: 4, maxNights: 4 } }), data);
    const best = res.ranked[0]!;
    expect(best.config.bookingMethod).toBe("package");
    expect(best.totalCents).toBe(102_000);
    expect(best.otherBookingMethod).toEqual({ method: "separate", totalCents: 107_000, complete: true });
  });

  it("prefers separate booking when package and separate cost the same", () => {
    const res = run(flexible({ dates: { earliestArrival: "2027-02-01", latestDeparture: "2027-02-05", minNights: 4, maxNights: 4 } }));
    expect(res.ranked).toHaveLength(1);
    expect(res.ranked[0]?.config.bookingMethod).toBe("separate");
    expect(res.ranked[0]?.otherBookingMethod?.totalCents).toBe(107_000);
  });

  it("uses a real package quote when it beats component pricing", () => {
    const data = baseData({ stayQuotes: [quote({ totalCents: 99_000 })] });
    const res = run(flexible({ dates: { earliestArrival: "2027-02-01", latestDeparture: "2027-02-05", minNights: 4, maxNights: 4 } }), data);
    expect(res.ranked[0]?.config.bookingMethod).toBe("package");
    expect(res.ranked[0]?.totalCents).toBe(99_000);
    expect(res.ranked[0]?.dataStatus).toBe("manual");
  });

  it("breaks cost ties deterministically: better data, then closer to preferred dates, then earlier", () => {
    const req = flexible({ preferred: { arrival: "2027-02-04" } });
    const res = run(req);
    // All arrivals cost the same; the preferred arrival should come first.
    expect(res.ranked[0]?.config.arrival).toBe("2027-02-04");
    expect(res.ranked[1]?.config.arrival).toBe("2027-02-03");
    expect(res.ranked[2]?.config.arrival).toBe("2027-02-05");
    const again = run(req);
    expect(again.ranked.map((e) => e.id)).toEqual(res.ranked.map((e) => e.id));
  });

  it("ranks by best value using adjustable weights", () => {
    const req = baseRequest({
      objective: "best_value",
      resorts: { allowedResortIds: ["a", "b"], requireOnProperty: true, preferredResortIds: ["b"] },
      weights: { price: 10, resort: 60, convenience: 30, ticket: 0, dining: 0, dates: 0 },
    });
    const res = run(req);
    expect(res.ranked[0]?.config.resortId).toBe("b");
    expect(res.awards.find((a) => a.kind === "best_value")?.evaluationId).toBe(res.ranked[0]?.id);
    expect(res.awards.find((a) => a.kind === "cheapest")?.evaluationId).toContain("|a|");

    const priceOnly = run({ ...req, weights: { price: 100, resort: 0, convenience: 0, ticket: 0, dining: 0, dates: 0 } });
    expect(priceOnly.ranked[0]?.config.resortId).toBe("a");
  });

  it("evaluates dining plans only as packages and only when allowed", () => {
    const req = baseRequest({
      resorts: { allowedResortIds: ["a"], requireOnProperty: true, preferredResortIds: [] },
      dining: { policy: "require", outOfPocketPerAdultPerNightCents: 0, outOfPocketPerChildPerNightCents: 0 },
    });
    const res = run(req);
    expect(res.ranked.every((e) => e.config.dining !== "out_of_pocket" && e.config.bookingMethod === "package")).toBe(true);
    // quick-service plan has no price in the fixture → incomplete, set aside
    expect(res.ranked.map((e) => e.config.dining)).toEqual(["dining_plan"]);
    expect(res.excluded.incomplete[0]?.config.dining).toBe("quick_service_plan");
  });

  it("reports why configurations were infeasible", () => {
    const req = flexible({ dates: { earliestArrival: "2027-02-01", latestDeparture: "2027-02-10", minNights: 3, maxNights: 4 } });
    const res = run(req);
    expect(res.stats.infeasibleReasons[0]?.reason).toMatch(/Only 2 possible park days for 3 required/);
    expect(res.ranked.every((e) => e.config.nights === 4)).toBe(true);
  });
});

describe("result completeness", () => {
  it("always returns the evaluations that awards point to, even beyond the ranked limit", () => {
    // 60+ cheaper same-resort dates, while the best-value option (preferred resort B) is the most expensive.
    const req = baseRequest({
      dates: { earliestArrival: "2027-02-01", latestDeparture: "2027-04-30", minNights: 4, maxNights: 4 },
      resorts: { allowedResortIds: ["a", "b"], requireOnProperty: true, preferredResortIds: ["b"] },
      weights: { price: 10, resort: 60, convenience: 30, ticket: 0, dining: 0, dates: 0 },
      preferred: { arrival: "2027-04-26" },
    });
    const res = run(req);
    expect(res.ranked.length).toBeGreaterThan(50);
    for (const a of res.awards) expect(res.ranked.some((e) => e.id === a.evaluationId)).toBe(true);
  });
});

describe("award labels require a real comparison", () => {
  it("does not label a lone option as cheapest or best value", () => {
    const req = baseRequest({ resorts: { allowedResortIds: ["a"], requireOnProperty: true, preferredResortIds: [] } });
    const res = run(req);
    expect(res.ranked).toHaveLength(1);
    expect(res.awards).toEqual([]);
    expect(res.notices.join(" ")).toMatch(/Only one option is fully priced/);
  });
});

describe("on-demand detail", () => {
  it("returns requested evaluations outside the ranked list", () => {
    const req = flexible({ dates: { earliestArrival: "2027-02-01", latestDeparture: "2027-05-30", minNights: 4, maxNights: 4 } });
    const full = run(req);
    const outside = full.dateMatrix.find((d) => !full.ranked.some((e) => e.id === d.evaluationId))!;
    expect(outside).toBeDefined();
    const res = optimize({ catalog, data: baseData(), request: req, now: NOW, include: [outside.evaluationId] });
    expect(res.included.map((e) => e.id)).toEqual([outside.evaluationId]);
    expect(res.included[0]!.totalCents).toBe(outside.totalCents);
  });
});

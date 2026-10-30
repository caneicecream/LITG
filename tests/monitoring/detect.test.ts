import { describe, expect, it } from "vitest";
import { optimize } from "@/domain/optimizer/optimize";
import type { PriceData, StayQuote, TripRequest } from "@/domain/types";
import { buildSnapshot, detectEvents } from "@/monitoring/detect";
import { contentHashOf } from "@/monitoring/observations";
import { defaultMonitorSettings, type CheckSnapshot, type MonitorSettings } from "@/monitoring/types";
import { baseData, baseRequest, catalog, NOW, prov, promo, quote } from "../fixtures";

// Change detection between monitor checks (pure: no database). Fictional prices.

const req = (over: Partial<TripRequest> = {}) =>
  baseRequest({ preferred: { arrival: "2027-02-01", nights: 4, resortId: "a", roomTypeId: "std", ticketOption: "base", bookingMethod: "package" }, data: { includeIllustrative: false, staleAfterDays: 14 }, ...over });

const pkg = (over: Partial<StayQuote> = {}) => quote({ id: "q-a", totalCents: 90_000, ...over });

function snap(data: PriceData, request: TripRequest, opts: { at?: Date; engine?: string; catalogHash?: string; newObs?: CheckSnapshot["newObservations"]; settings?: MonitorSettings } = {}): CheckSnapshot {
  const now = opts.at ?? NOW;
  const result = optimize({ catalog, data, request, now });
  return buildSnapshot({
    result,
    request,
    quotes: data.stayQuotes,
    checkedAt: now.toISOString(),
    requestHash: contentHashOf(request),
    dataHash: contentHashOf(data),
    engineVersion: opts.engine ?? "e1",
    catalogHash: opts.catalogHash ?? "c1",
    settings: opts.settings ?? defaultMonitorSettings(),
    newObservations: opts.newObs ?? [],
  });
}

const ctx = { monitorId: "m1", settings: defaultMonitorSettings() };
const types = (events: { type: string }[]) => events.map((e) => e.type);
const later = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

describe("change detection", () => {
  it("first check establishes a baseline without notifying", () => {
    const ev = detectEvents(null, snap(baseData({ stayQuotes: [pkg()] }), req()), ctx);
    expect(types(ev)).toEqual(["first_check"]);
    expect(ev[0]!.notify).toBe(false);
  });

  it("a new lower observation of the same configuration is a price decrease, with $ and %", () => {
    const a = snap(baseData({ stayQuotes: [pkg()] }), req());
    const b = snap(baseData({ stayQuotes: [pkg({ totalCents: 81_000, provenance: prov("manual", "2027-01-02", "disneyworld.com quote") })] }), req(), { at: later(1) });
    const ev = detectEvents(a, b, ctx);
    const d = ev.find((e) => e.type === "price_decrease")!;
    expect(d.deltaCents).toBe(-9_000);
    expect(d.deltaPct).toBe(-10);
    expect(d.title).toBe("Price down $90.00 (-10%)");
    expect(d.notify).toBe(true);
    expect(d.evidence.join()).toMatch(/\$900\.00 → \$810\.00/);
  });

  it("increases are detected too, and changes under both thresholds don't notify", () => {
    const a = snap(baseData({ stayQuotes: [pkg()] }), req());
    const up = snap(baseData({ stayQuotes: [pkg({ totalCents: 100_000 })] }), req());
    expect(detectEvents(a, up, ctx).find((e) => e.type === "price_increase")!.deltaCents).toBe(10_000);
    const tiny = snap(baseData({ stayQuotes: [pkg({ totalCents: 89_900 })] }), req());
    const e = detectEvents(a, tiny, ctx).find((x) => x.type === "price_decrease")!;
    expect(e.deltaCents).toBe(-100);
    expect(e.notify).toBe(false); // $1 and 0.11% are below $25 / 1%
    expect(detectEvents(a, up, { ...ctx, settings: { ...ctx.settings, notifyOn: { ...ctx.settings.notifyOn, increases: false } } }).find((x) => x.type === "price_increase")!.notify).toBe(false);
  });

  it("re-reading the same stored data finds no change at all", () => {
    const data = baseData({ stayQuotes: [pkg()] });
    const ev = detectEvents(snap(data, req()), snap(data, req(), { at: later(1) }), ctx);
    expect(ev).toEqual([]);
  });

  it("a calculation or catalog change is a recalculation, never a price change", () => {
    const a = snap(baseData(), req({ preferred: { ...req().preferred, bookingMethod: "separate" } }));
    // Same data, different tax reference data (as if the catalog/tax tables were updated).
    const data2 = baseData();
    data2.taxRates = data2.taxRates.map((t) => (t.category === "lodging" ? { ...t, ratePct: 12 } : t));
    const b = snap(data2, req({ preferred: { ...req().preferred, bookingMethod: "separate" } }), { catalogHash: "c2" });
    // Price data the monitor compares excludes reference data here, so pin the data hash.
    const ev = detectEvents(a, { ...b, dataHash: a.dataHash }, ctx);
    expect(types(ev)).not.toContain("price_increase");
    const r = ev.find((e) => e.type === "recalculated")!;
    expect(r.detail).toMatch(/calculation rules or reference data .* not a change in Disney's price/);
    expect(r.notify).toBe(false);
  });

  it("a changed trip configuration is not compared as a price change", () => {
    const data = baseData({ stayQuotes: [pkg(), pkg({ id: "q-b", resortId: "b", totalCents: 200_000 })] });
    const a = snap(data, req());
    const b = snap(data, req({ preferred: { ...req().preferred, resortId: "b" } }));
    const ev = detectEvents(a, b, ctx);
    expect(types(ev)).toContain("configuration_changed");
    expect(types(ev)).not.toContain("price_increase");
  });

  it("same price from a newer observation is a confirmation; a status change is a provenance change", () => {
    const a = snap(baseData({ stayQuotes: [pkg()] }), req());
    const confirmed = snap(baseData({ stayQuotes: [pkg({ provenance: prov("manual", "2027-01-05", "phone call") })] }), req());
    expect(types(detectEvents(a, confirmed, ctx))).toEqual(["price_confirmed"]);
    const est = snap(baseData({ stayQuotes: [pkg({ provenance: prov("estimated") })] }), req());
    expect(types(detectEvents(a, est, ctx))).toEqual(["provenance_changed"]);
  });

  it("flags stale evidence once per data state", () => {
    const old = baseData({ stayQuotes: [pkg({ provenance: prov("manual", "2026-11-01") })] });
    const s = snap(old, req());
    const ev = detectEvents(s, snap(old, req(), { at: later(1) }), ctx);
    const stale = ev.find((e) => e.type === "stale")!;
    expect(stale.notify).toBe(true);
    expect(stale.detail).toMatch(/A stored price is not a current price/);
    // The same stale situation produces the same dedupe key next time.
    expect(detectEvents(s, snap(old, req(), { at: later(2) }), ctx).find((e) => e.type === "stale")!.dedupeKey).toBe(stale.dedupeKey);
  });

  it("reports a missing price when the quote pricing the plan disappears", () => {
    const req2 = req({ preferred: { ...req().preferred, resortId: "off" } });
    const a = snap(baseData({ stayQuotes: [pkg({ resortId: "off", bookingMethod: "separate", ticket: undefined })] }), req2);
    const noRates = baseData({ roomRates: [] });
    const ev = detectEvents(a, snap(noRates, req2), ctx);
    expect(types(ev)).toContain("price_missing");
  });

  it("promotions applied and ended, with the price change attributed to new data", () => {
    const sep = req({ preferred: { ...req().preferred, bookingMethod: "separate" } });
    const a = snap(baseData(), sep);
    const b = snap(baseData({ promotions: [promo({ id: "p1", name: "Room 20% off" })] }), sep);
    const ev = detectEvents(a, b, ctx);
    expect(types(ev)).toEqual(expect.arrayContaining(["price_decrease", "promotion_applied"]));
    expect(types(detectEvents(b, a, ctx))).toEqual(expect.arrayContaining(["price_increase", "promotion_ended"]));
  });

  it("new quotes of the same configuration are reported, disclosing pre-tax totals", () => {
    const a = snap(baseData({ stayQuotes: [pkg()] }), req());
    const b = snap(baseData({ stayQuotes: [pkg()] }), req(), {
      newObs: [{ id: "o9", entryId: "q-other", observedOn: "2027-01-01", recordedAt: NOW.toISOString(), valueCents: 140_000, source: "travel agent", status: "manual", taxTreatment: "pre_tax" }],
    });
    const e = detectEvents(a, b, ctx).find((x) => x.type === "new_comparable_quote")!;
    expect(e.detail).toMatch(/\$1,400\.00 observed 2027-01-01 \(travel agent, manual\); it excludes tax/);
  });

  it("a cheaper alternative against a booked reservation with unknown terms claims no saving", () => {
    const booked = pkg({ booked: true, totalCents: 250_000 });
    const s = snap(baseData({ stayQuotes: [booked] }), req());
    expect(s.reservation?.quoteId).toBe("q-a");
    expect(s.switching?.verdict).toBe("unknown");
    const e = detectEvents(null, s, ctx).find((x) => x.type === "cheaper_alternative")!;
    expect(e.detail).toMatch(/cost of switching is not known, so no saving is claimed/);
  });

  it("does not notify about an alternative that isn't worth switching to", () => {
    const booked = pkg({
      booked: true,
      totalCents: 250_000,
      terms: { depositCents: 20_000, installments: [], amountPaidCents: 250_000, refundability: "non_refundable", cancellationPenalties: [] },
    });
    const s = snap(baseData({ stayQuotes: [booked] }), req());
    expect(s.switching?.verdict).toBe("not_worth_it");
    expect(detectEvents(null, s, ctx).find((x) => x.type === "cheaper_alternative")!.notify).toBe(false);
  });

  it("illustrative and real totals are never compared", () => {
    const a = snap(baseData({ stayQuotes: [pkg({ provenance: prov("illustrative") })] }), req({ data: { includeIllustrative: true, staleAfterDays: 14 } }));
    const b = snap(baseData({ stayQuotes: [pkg({ totalCents: 80_000 })] }), req({ data: { includeIllustrative: true, staleAfterDays: 14 } }));
    const ev = detectEvents(a, b, ctx);
    expect(types(ev)).not.toContain("price_decrease");
    expect(types(ev)).toContain("provenance_changed");
  });
});

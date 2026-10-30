import { describe, expect, it } from "vitest";
import type { StayQuote } from "@/domain/types";
import { configDifferences, fingerprint, quoteKey } from "@/monitoring/fingerprint";
import { contentHashOf, observationFromEntry } from "@/monitoring/observations";
import { buildSeries, seriesSeparationNotes } from "@/monitoring/series";
import { prov, quote } from "../fixtures";

// Equivalent-configuration series (pure). Fictional prices.

const q = (over: Partial<StayQuote>) => quote({ id: "q1", ...over });
const obs = (e: StayQuote, recordedAt: string) => observationFromEntry(e, "entry", recordedAt);

describe("observation records", () => {
  it("capture configuration, tax treatment, terms and assumptions", () => {
    const o = obs(q({ taxIncluded: false, taxCents: 12_000, totalCents: 100_000 }), "2027-01-01T10:00:00.000Z");
    expect(o.config).toMatchObject({ resortId: "a", checkIn: "2027-02-01", checkOut: "2027-02-05", adults: 2, ticketOption: "base", ticketDays: 3 });
    expect(o.comparableTotalCents).toBe(112_000);
    expect(o.seriesKey).toMatch(/#all_in$/);
    expect(o.assumptions.join()).toMatch(/quoted separately/);
    expect(o.assumptions.join()).toMatch(/terms were not recorded/);
  });
  it("hash identical content identically regardless of key order or history", () => {
    const a = q({});
    const b = { ...a, history: [{ observedAt: "2026-12-01", supersededAt: "x", status: "manual" as const, source: "s", value: 1 }] };
    expect(obs(a, "t1").contentHash).toBe(obs(b, "t2").contentHash);
    expect(contentHashOf({ x: 1, y: 2 })).toBe(contentHashOf({ y: 2, x: 1 }));
    expect(obs(a, "t").contentHash).not.toBe(obs(q({ totalCents: 99_999 }), "t").contentHash);
  });
});

describe("price series", () => {
  it("connects only equivalent configurations and reports trend, $ and %", () => {
    const s = buildSeries(
      [
        obs(q({ totalCents: 100_000, provenance: prov("manual", "2026-12-01") }), "2026-12-01T10:00:00.000Z"),
        obs(q({ id: "q2", totalCents: 95_000, provenance: prov("manual", "2026-12-10") }), "2026-12-10T10:00:00.000Z"),
        obs(q({ id: "q3", nights: 5, totalCents: 120_000 }), "2026-12-11T10:00:00.000Z"), // different stay length
      ],
      "2027-01-01",
      30,
    );
    expect(s).toHaveLength(2);
    const four = s.find((x) => x.fingerprint.includes("|4n|"))!;
    expect(four.points.map((p) => p.valueCents)).toEqual([100_000, 95_000]);
    expect(four.trend).toBe("down");
    expect(four.changeCents).toBe(-5_000);
    expect(four.changePct).toBe(-5);
    expect(four.lowest.valueCents).toBe(95_000);
    const five = s.find((x) => x.fingerprint.includes("|5n|"))!;
    expect(five.trend).toBe("insufficient");
    expect(five.insufficientReason).toMatch(/A trend needs at least two/);
  });

  it("keeps pre-tax totals and estimates on separate lines", () => {
    const list = [
      obs(q({ totalCents: 100_000 }), "2026-12-01T00:00:00.000Z"),
      obs(q({ id: "q2", totalCents: 90_000, taxIncluded: false }), "2026-12-02T00:00:00.000Z"),
      obs(q({ id: "q3", totalCents: 98_000, provenance: prov("estimated") }), "2026-12-03T00:00:00.000Z"),
    ];
    const s = buildSeries(list, "2027-01-01", 30);
    expect(s).toHaveLength(3);
    expect(s.every((x) => x.points.length === 1)).toBe(true);
    expect(seriesSeparationNotes(s).join(" ")).toMatch(/Pre-tax totals.*estimates/);
  });

  it("marks old quoted observations stale (estimates never go stale)", () => {
    const s = buildSeries([obs(q({ provenance: prov("manual", "2026-11-01") }), "2026-11-01T00:00:00.000Z")], "2027-01-01", 14);
    expect(s[0]!.stale).toBe(true);
    expect(s[0]!.ageDays).toBe(61);
    expect(s[0]!.latest.effectiveStatus).toBe("stale");
  });

  it("orders by observation date, then recording time", () => {
    const s = buildSeries(
      [
        obs(q({ id: "late", totalCents: 1, provenance: prov("manual", "2026-12-05") }), "2026-12-05T00:00:00.000Z"),
        obs(q({ id: "early", totalCents: 2, provenance: prov("manual", "2026-12-01") }), "2026-12-20T00:00:00.000Z"), // entered later, seen earlier
      ],
      "2027-01-01",
      90,
    );
    expect(s[0]!.points.map((p) => p.entryId)).toEqual(["early", "late"]);
  });

  it("ignores illustrative observations and non-quote entries", () => {
    expect(buildSeries([obs(q({ provenance: prov("illustrative") }), "t")], "2027-01-01", 14)).toEqual([]);
  });

  it("describes configuration differences", () => {
    const a = quoteKey(q({}));
    const b = quoteKey(q({ nights: 5, dining: "dining_plan" }));
    expect(configDifferences(a, a)).toEqual([]);
    expect(configDifferences(a, b)).toEqual(["5 vs 4 nights", "different dining"]);
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

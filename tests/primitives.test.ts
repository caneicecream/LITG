import { describe, expect, it } from "vitest";
import { addDays, dayOfWeek, daysBetween, isIsoDate, stayNights } from "@/domain/dates";
import { formatCents, percentOf } from "@/domain/money";
import { effectiveStatus, weakestStatus } from "@/domain/provenance";
import { parseTripRequest } from "@/domain/schema";
import { baseRequest, prov } from "./fixtures";

describe("money", () => {
  it("computes percentages in integer cents with half-up rounding", () => {
    expect(percentOf(10_000, 12.5)).toBe(1_250);
    expect(percentOf(333, 6.5)).toBe(22); // 21.645 → 22
    expect(percentOf(1, 50)).toBe(1); // 0.5 → 1
    expect(percentOf(0, 12.5)).toBe(0);
  });
  it("formats negatives and signs", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(-500)).toBe("−$5.00");
    expect(formatCents(500, { sign: true })).toBe("+$5.00");
  });
});

describe("dates", () => {
  it("does calendar arithmetic across month and year boundaries", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2027-03-13", 1)).toBe("2027-03-14"); // US DST weekend
    expect(daysBetween("2027-02-27", "2027-03-01")).toBe(2);
    expect(stayNights("2027-01-30", 3)).toEqual(["2027-01-30", "2027-01-31", "2027-02-01"]);
  });
  it("validates ISO dates strictly", () => {
    expect(isIsoDate("2027-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2027-1-01")).toBe(false);
  });
  it("knows weekdays", () => {
    expect(dayOfWeek("2027-01-01")).toBe(5); // Friday
  });
});

describe("provenance", () => {
  it("marks old manual/verified observations as stale but never estimates or demo data", () => {
    expect(effectiveStatus(prov("manual", "2027-01-01"), "2027-01-15", 14)).toBe("manual");
    expect(effectiveStatus(prov("manual", "2027-01-01"), "2027-01-16", 14)).toBe("stale");
    expect(effectiveStatus(prov("verified", "2026-01-01"), "2027-01-16", 14)).toBe("stale");
    expect(effectiveStatus(prov("estimated", "2020-01-01"), "2027-01-16", 14)).toBe("estimated");
    expect(effectiveStatus(prov("illustrative", "2020-01-01"), "2027-01-16", 14)).toBe("illustrative");
  });
  it("finds the weakest status", () => {
    expect(weakestStatus(["verified", "manual", "estimated"])).toBe("estimated");
    expect(weakestStatus(["manual", "illustrative", "stale"])).toBe("illustrative");
    expect(weakestStatus(["manual", "unavailable"])).toBe("unavailable");
  });
});

describe("request schema", () => {
  it("accepts a valid request", () => {
    expect(parseTripRequest(baseRequest()).ok).toBe(true);
  });
  it("rejects inverted night ranges, impossible windows and empty ticket choices", () => {
    const bad = baseRequest({
      dates: { earliestArrival: "2027-02-01", latestDeparture: "2027-02-03", minNights: 5, maxNights: 4 },
      tickets: { parkDays: 3, allowedOptions: [], parkOnArrivalDay: false, parkOnDepartureDay: false, allowThirdParty: false },
    });
    const res = parseTripRequest(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.join("\n")).toMatch(/Maximum nights/);
      expect(res.errors.join("\n")).toMatch(/shorter than the minimum stay/);
      expect(res.errors.join("\n")).toMatch(/at least one ticket type/);
    }
  });
  it("rejects malformed dates", () => {
    const res = parseTripRequest({ ...baseRequest(), bookingDate: "2027-13-01" });
    expect(res.ok).toBe(false);
  });
});

describe("request schema (Milestone 2 fields)", () => {
  it("keeps the DVC points option and accepts a points baseline", () => {
    const req = { ...baseRequest(), resorts: { ...baseRequest().resorts, considerPoints: true }, preferred: { bookingMethod: "points" } };
    const res = parseTripRequest(req);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.request.resorts.considerPoints).toBe(true);
      expect(res.request.preferred.bookingMethod).toBe("points");
    }
  });
});

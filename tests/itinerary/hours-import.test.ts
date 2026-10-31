import { describe, expect, it } from "vitest";
import { mergeHours, parseParkHours } from "@/itinerary/importers/hours";
import { demoInput } from "@/itinerary/context";
import { planItinerary } from "@/itinerary/engine";
import { emptyParkInfo, parkInfoSchema, type InfoProvenance } from "@/itinerary/types";

// Park hours pasted from a calendar. All hours below are FICTIONAL test data.

const trip = { arrival: "2027-02-01", departure: "2027-02-06" };
const prov: InfoProvenance = { status: "manual", source: "Official park calendar (pasted)", observedAt: "2026-10-31" };
const parse = (t: string) => parseParkHours(t, trip, prov);

describe("parsing pasted park hours", () => {
  it("reads date headings, park lines and early entry", () => {
    const r = parse(`
Tue, Feb 2
Magic Kingdom 9:00 AM – 10:00 PM
Early Entry 8:30 AM
EPCOT 9am-9pm

Wednesday, February 3, 2027
Hollywood Studios: 8:30 AM to 9:00 PM
Animal Kingdom 8:00–19:00 (Early Theme Park Entry 7:30 AM)
`);
    expect(r.skipped).toEqual([]);
    expect(r.entries.map((e) => [e.date, e.parkId, e.open, e.close, e.earlyEntryMin])).toEqual([
      ["2027-02-02", "magic-kingdom", "09:00", "22:00", 30],
      ["2027-02-02", "epcot", "09:00", "21:00", null],
      ["2027-02-03", "hollywood-studios", "08:30", "21:00", null],
      ["2027-02-03", "animal-kingdom", "08:00", "19:00", 30],
    ]);
    expect(r.entries[0]!.provenance).toEqual(prov);
    // Every entry passes the park-information schema.
    expect(parkInfoSchema.safeParse({ hours: r.entries }).success).toBe(true);
  });

  it("accepts dates on the same line in several formats, resolving the year from the trip", () => {
    const r = parse("2027-02-04 Magic Kingdom 9am-10pm\n2/5 EPCOT 10:00 AM - 9:00 PM\nFeb 3: AK 8am to 7pm");
    expect(r.entries.map((e) => `${e.date} ${e.parkId}`)).toEqual(["2027-02-04 magic-kingdom", "2027-02-05 epcot", "2027-02-03 animal-kingdom"]);
  });

  it("reports every line it can't use, with the reason, instead of guessing", () => {
    const r = parse(`
Magic Kingdom 9:00 AM – 10:00 PM
Feb 2
EPCOT and Magic Kingdom 9am-9pm
Hollywood Studios 9 - 10
Animal Kingdom Closed
Extended Evening Hours 10:00 PM - 12:00 AM
Fireworks at 9:00 PM
Feb 30
Mar 9 Magic Kingdom 9am-10pm
`);
    const reasons = r.skipped.map((s) => s.reason);
    expect(reasons).toEqual([
      "no date for this line (put a date before it)",
      "more than one park on the line",
      "the times are ambiguous (use 9:00 AM or 21:00)",
      "the park is listed as closed",
      "extended evening hours apply only to some resort guests; enter them yourself if you qualify",
      "no park or hours found",
      "the date isn't a valid calendar date",
      "2027-03-09 is outside your trip (2027-02-01 to 2027-02-06)",
    ]);
    expect(r.entries).toEqual([]);
  });

  it("handles after-midnight closes, duplicates and early entry that isn't early", () => {
    const r = parse("Feb 2\nMagic Kingdom 9:00 AM – 1:00 AM\nEPCOT 9am-9pm\nEPCOT 10am-9pm\nEarly Entry 10:30 AM");
    expect(r.entries.find((e) => e.parkId === "magic-kingdom")!.close).toBe("23:59");
    expect(r.warnings.join()).toMatch(/closes after midnight/);
    expect(r.entries.filter((e) => e.parkId === "epcot")).toHaveLength(1);
    expect(r.entries.find((e) => e.parkId === "epcot")!.open).toBe("10:00");
    expect(r.warnings.join()).toMatch(/listed twice; the later line is used/);
    expect(r.skipped[0]!.reason).toBe("early entry must start before the park opens");
  });

  it("merging replaces the same date and park, and keeps the rest", () => {
    const info = emptyParkInfo();
    info.hours.push({ date: "2027-02-02", parkId: "epcot", open: "08:00", close: "20:00", earlyEntryMin: null, provenance: prov });
    info.hours.push({ date: "2027-02-03", parkId: "epcot", open: "08:00", close: "20:00", earlyEntryMin: null, provenance: prov });
    const { info: merged, replaced } = mergeHours(info, parse("Feb 2\nEPCOT 9am-9pm").entries);
    expect(replaced).toBe(1);
    expect(merged.hours.map((h) => `${h.date} ${h.open}`).sort()).toEqual(["2027-02-02 09:00", "2027-02-03 08:00"]);
  });

  it("imported hours make the plan use park hours instead of the planning window", () => {
    const input = demoInput("2026-10-31");
    const real = { ...input, demo: false, parkInfo: { ...input.parkInfo, hours: [] } };
    const before = planItinerary(real, { today: "2026-10-31" });
    const text = ["Feb 2", "Feb 3", "Feb 4", "Feb 5"].map((d) => `${d}\nMagic Kingdom 9am-10pm\nEPCOT 9am-9pm\nHollywood Studios 8:30am-9pm\nAnimal Kingdom 8am-7pm`).join("\n");
    const after = planItinerary({ ...real, parkInfo: mergeHours(real.parkInfo, parse(text).entries).info }, { today: "2026-10-31" });
    expect(before.days.filter((d) => d.kind === "park").every((d) => d.window.basis === "planning_window")).toBe(true);
    expect(after.days.filter((d) => d.kind === "park").every((d) => d.window.basis === "park_hours")).toBe(true);
    expect(after.unknowns.join()).not.toMatch(/Park hours are not entered/);
    expect(after.score!.components.find((c) => c.key === "certainty")!.score).toBeGreaterThan(before.score!.components.find((c) => c.key === "certainty")!.score);
  });
});

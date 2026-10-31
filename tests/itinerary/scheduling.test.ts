import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addDays } from "@/domain/dates";
import { ATTRACTIONS, PARKS, attractionById } from "@/itinerary/catalog";
import { demoInput } from "@/itinerary/context";
import { planItinerary, toMin, verifyItinerary } from "@/itinerary/engine";
import { defaultPreferences, emptyParkInfo, type InfoProvenance, type Itinerary, type ItineraryInput, type Preferences, type TripContext } from "@/itinerary/types";
import { ItineraryView } from "@/components/itinerary/ItineraryView";

// Milestone 6 scheduling regressions. Park hours, times and waits are FICTIONAL test data.

const TODAY = "2026-10-31";
const ARR = "2027-03-01";
const you: InfoProvenance = { status: "manual", source: "TEST", observedAt: "2026-10-30" };

function ctx(over: Partial<TripContext> = {}): TripContext {
  return {
    source: { kind: "request", label: "TEST" },
    arrival: ARR,
    departure: addDays(ARR, 5),
    party: { adults: 2, children: 0, infants: 0 },
    resortId: "pop-century",
    resortName: "Pop Century",
    disneyResort: true,
    ticket: { option: "base", days: 4, hopper: false, usage: { useWithinDays: 7, parkReservationRequired: false }, usageSource: "TEST" },
    parkOnArrivalDay: false,
    parkOnDepartureDay: false,
    ...over,
  };
}
const input = (prefs: Partial<Preferences>, over: Partial<ItineraryInput> = {}, c = ctx()): ItineraryInput => ({ context: c, prefs: { ...defaultPreferences(), ...prefs }, parkInfo: emptyParkInfo(), demo: false, ...over });
const plan = (i: ItineraryInput) => planItinerary(i, { today: TODAY });
const items = (it: Itinerary) => it.days.flatMap((d) => d.items.map((x) => ({ ...x, date: d.date, dayStart: d.window.start })));
const D1 = addDays(ARR, 1);
const pinMK = [{ date: D1, plan: { kind: "park" as const, parkId: "magic-kingdom" } }];

describe("must-do placement", () => {
  it("favours must-dos earlier in the day, even when they're far from the entrance", () => {
    // Must-dos at the back of the park (Frontierland/Fantasyland); many extras near the entrance.
    const it0 = plan(input({ parks: ["magic-kingdom"], maxParkDays: 1, pins: pinMK, attractions: { "mk-tianas": "must", "mk-seven-dwarfs": "must", "mk-peter-pan": "must" } }));
    const musts = items(it0).filter((i) => i.priority === "must");
    expect(musts).toHaveLength(3);
    for (const m of musts) expect(m.start - m.dayStart).toBeLessThan(180);
  });

  it("across the demo, every must-do starts before 1 pm", () => {
    const it0 = plan(demoInput(TODAY));
    for (const m of items(it0).filter((i) => i.priority === "must")) expect(m.start).toBeLessThan(toMin("13:00"));
  });

  it("explains a must-do that still ends up late", () => {
    // Every Magic Kingdom attraction is a must-do on a short day: some are necessarily late.
    const musts = Object.fromEntries(ATTRACTIONS.filter((a) => a.parkId === "magic-kingdom" && a.schedule !== "spectacular").map((a) => [a.id, "must" as const]));
    const it0 = plan(input({ parks: ["magic-kingdom"], maxParkDays: 1, pins: pinMK, attractions: musts }));
    const late = items(it0).filter((i) => i.priority === "must" && i.start - i.dayStart >= 180);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((i) => i.notes.some((n) => /^Planned (later|for)/.test(n)))).toBe(true);
    // Those that don't fit say how much time they need.
    expect(it0.coverage.must.missing.every((m) => /needs about \d+ min|operating window|showtime/.test(m.reason))).toBe(true);
  });

  it("a known operating window is respected without leaving the morning idle", () => {
    const pi = emptyParkInfo();
    pi.attractionHours.push({ attractionId: "mk-hall-presidents", date: null, start: "15:00", end: "16:00", provenance: you });
    const it0 = plan(input({ parks: ["magic-kingdom"], maxParkDays: 1, pins: pinMK, attractions: { "mk-hall-presidents": "must" } }, { parkInfo: pi }));
    const show = items(it0).find((i) => i.attractionId === "mk-hall-presidents")!;
    expect(show.start).toBeGreaterThanOrEqual(toMin("15:00"));
    const before = items(it0).filter((i) => i.end <= show.start);
    expect(before.filter((i) => i.kind === "attraction").length).toBeGreaterThan(3);
    expect(before.filter((i) => i.kind === "flexible").every((i) => i.end - i.start <= 60)).toBe(true);
  });
});

describe("shows and evening spectaculars", () => {
  it("never places an evening spectacular at an invented time", () => {
    const it0 = plan(input({ parks: ["magic-kingdom"], maxParkDays: 1, pins: pinMK, attractions: { "mk-fireworks": "must" } }));
    expect(items(it0).some((i) => i.attractionId === "mk-fireworks")).toBe(false);
    expect(it0.coverage.must.missing[0]).toMatchObject({ id: "mk-fireworks", reason: expect.stringMatching(/showtime isn't known: add it under/) });
    // Not even as an extra.
    expect(items(plan(input({ parks: ["magic-kingdom"], maxParkDays: 1, pins: pinMK, dayEnd: "23:00" }))).some((i) => i.attractionId === "mk-fireworks")).toBe(false);
  });

  it("plans it at the time you enter, arriving early for a spot", () => {
    const pi = emptyParkInfo();
    pi.attractionHours.push({ attractionId: "mk-fireworks", date: D1, start: "21:00", end: "21:20", provenance: you });
    const it0 = plan(input({ parks: ["magic-kingdom"], maxParkDays: 1, pins: pinMK, dayEnd: "22:00", attractions: { "mk-fireworks": "must" } }, { parkInfo: pi }));
    const fw = items(it0).find((i) => i.attractionId === "mk-fireworks")!;
    expect(fw.end).toBeLessThanOrEqual(toMin("21:20"));
    expect(fw.waitMin).toBe(30);
    expect(fw.basis.some((b) => /Arrive ~30 min early/.test(b.label))).toBe(true);
  });

  it("flags performance times as unknown for scheduled shows", () => {
    const it0 = plan(input({ parks: ["animal-kingdom"], maxParkDays: 1, attractions: { "ak-lion-king": "must" } }));
    const show = items(it0).find((i) => i.attractionId === "ak-lion-king")!;
    expect(show.basis.some((b) => b.label.startsWith("Performance times unknown") && b.status === "unavailable")).toBe(true);
  });
});

describe("catalog data quality", () => {
  it("every attraction has a known area, a positive estimated duration and a consistent schedule type", () => {
    for (const a of ATTRACTIONS) {
      expect(PARKS.find((p) => p.id === a.parkId)!.areas.some((ar) => ar.id === a.areaId), a.id).toBe(true);
      expect(a.durationMin).toBeGreaterThan(0);
      if (a.category === "spectacular") expect(a.schedule).toBe("spectacular");
      if (a.kind === "ride") expect(a.schedule).toBe("continuous");
      for (const adv of a.advisories ?? []) expect(adv.source && adv.checkedAt).toBeTruthy();
    }
    expect(new Set(ATTRACTIONS.map((a) => a.id)).size).toBe(ATTRACTIONS.length);
  });

  it("reported advisories are shown for the trip dates but never applied as closures", () => {
    const c = ctx({ arrival: "2026-11-01", departure: "2026-11-06" });
    const it0 = plan(input({ parks: ["magic-kingdom"], maxParkDays: 1, attractions: { "mk-tianas": "must" } }, {}, c));
    expect(items(it0).some((i) => i.attractionId === "mk-tianas")).toBe(true);
    expect(it0.unknowns.join()).toMatch(/Tiana's Bayou Adventure: Reported refurbishment .* Not applied — if it's confirmed/);
    const ride = items(it0).find((i) => i.attractionId === "mk-tianas" && i.date >= "2026-11-02");
    if (ride) expect(ride.basis.some((b) => b.label.startsWith("Reported:"))).toBe(true);
  });

  it("heights are shown (as reported, to verify) when the party has children, and unknown heights are not assumed to be none", () => {
    const it0 = plan(input({ parks: ["magic-kingdom"], maxParkDays: 1, attractions: { "mk-space-mountain": "must" } }, {}, ctx({ party: { adults: 2, children: 1, infants: 0 } })));
    const sm = items(it0).find((i) => i.attractionId === "mk-space-mountain")!;
    expect(sm.basis.some((b) => b.label === "Reported minimum height 44 in (verify)")).toBe(true);
    expect(attractionById.get("mk-big-thunder")!.minHeightIn).toBeUndefined(); // sources disagreed: left unknown
    expect(it0.assumptions.join()).toMatch(/reported minimum height .* Children's heights aren't known/);
  });
});

describe("Milestone 5 regressions", () => {
  it("lunch is never placed hours after its window", () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 25; n++) {
      const it0 = plan(input({ middayBreak: rnd() < 0.5, flexibleAfternoons: rnd() < 0.5, pace: (["relaxed", "moderate", "packed"] as const)[Math.floor(rnd() * 3)]!, allowHopping: true }, {}, ctx({ ticket: { option: "park_hopper", days: 4, hopper: true, usage: null, usageSource: null } })));
      for (const l of items(it0).filter((i) => i.title === "Lunch")) expect(l.start).toBeLessThanOrEqual(toMin("13:30") + 120);
    }
  });

  it("a hop day with a midday rest and flexible afternoons has no overlaps and one transfer", () => {
    const pi = emptyParkInfo();
    pi.dining.push({ id: "d", date: D1, parkId: "epcot", name: "TEST dinner", time: "18:00", durationMin: 60, provenance: you });
    pi.lightningLane.push({ id: "l", date: D1, attractionId: "mk-peter-pan", start: "10:00", end: "11:00", provenance: you });
    const i0 = input({ allowHopping: true, middayBreak: true, flexibleAfternoons: true }, { parkInfo: pi }, ctx({ ticket: { option: "park_hopper", days: 4, hopper: true, usage: null, usageSource: null } }));
    const it0 = plan(i0);
    const day = it0.days.find((d) => d.date === D1)!;
    expect(day.kind).toBe("hop");
    expect(day.items.filter((i) => i.kind === "transfer")).toHaveLength(1);
    expect(verifyItinerary(i0, it0)).toEqual([]);
    expect(day.items.filter((i) => i.notes.includes("Lunch during your midday rest.")).length).toBeLessThanOrEqual(1);
  });

  it("no short rest break right before a midday rest", () => {
    const it0 = plan(input({ pace: "relaxed", middayBreak: true }));
    for (const d of it0.days) {
      const idx = d.items.findIndex((i) => i.title.startsWith("Midday rest"));
      if (idx > 0) expect(d.items[idx - 1]!.title).not.toBe("Rest break");
    }
  });
});

describe("presentation", () => {
  it("day timelines render with classes that wrap on narrow screens", () => {
    const html = renderToStaticMarkup(createElement(ItineraryView, { it: plan(demoInput(TODAY)) }));
    expect(html).toContain('class="cmp itinerary-table"');
    expect(html).toContain("Fit with your priorities");
    const css = readFileSync(path.join(__dirname, "../../src/app/globals.css"), "utf8");
    expect(css).toMatch(/\.itinerary-table \.chip \{ white-space: normal;/);
    expect(css).toMatch(/@media \(max-width: 600px\) \{\s*\.itinerary-table td:first-child/);
  });
});

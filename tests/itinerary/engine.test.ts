import { describe, expect, it } from "vitest";
import { addDays } from "@/domain/dates";
import { ATTRACTIONS, attractionById } from "@/itinerary/catalog";
import { demoInput } from "@/itinerary/context";
import { compareSummary, compareVariants, LIMITS, planItinerary, STANDARD_VARIANTS, toMin, verifyItinerary } from "@/itinerary/engine";
import {
  defaultPreferences,
  emptyParkInfo,
  itineraryInputSchema,
  parkInfoSchema,
  userProvenanceSchema,
  type InfoProvenance,
  type Itinerary,
  type ItineraryInput,
  type Preferences,
  type TripContext,
} from "@/itinerary/types";

// All park hours, waits, crowds and reservations here are FICTIONAL test data,
// not Disney information. Attraction ids come from the project's structural catalog.

const TODAY = "2026-10-31";
const ARR = "2027-03-01";
const you = (observedAt = "2026-10-30"): InfoProvenance => ({ status: "manual", source: "TEST: entered by hand", observedAt });

function ctx(over: Partial<TripContext> = {}, ticket: Partial<NonNullable<TripContext["ticket"]>> = {}): TripContext {
  return {
    source: { kind: "request", label: "TEST trip" },
    arrival: ARR,
    departure: addDays(ARR, 5),
    party: { adults: 2, children: 0, infants: 0 },
    resortId: "pop-century",
    resortName: "Disney's Pop Century Resort",
    disneyResort: true,
    ticket: { option: "base", days: 4, hopper: false, usage: { useWithinDays: 7, parkReservationRequired: false }, usageSource: "TEST rule", ...ticket },
    parkOnArrivalDay: false,
    parkOnDepartureDay: false,
    ...over,
  };
}

function input(prefs: Partial<Preferences> = {}, over: Partial<ItineraryInput> = {}, c: TripContext = ctx()): ItineraryInput {
  return { context: c, prefs: { ...defaultPreferences(), ...prefs }, parkInfo: emptyParkInfo(), demo: false, ...over };
}

const plan = (i: ItineraryInput) => planItinerary(i, { today: TODAY });
const parkDays = (it: Itinerary) => it.days.filter((d) => d.kind === "park" || d.kind === "hop");
const allItems = (it: Itinerary) => parkDays(it).flatMap((d) => d.items.map((x) => ({ ...x, date: d.date })));
const scheduledIds = (it: Itinerary) => new Set(allItems(it).flatMap((x) => (x.attractionId ? [x.attractionId] : [])));
const hours = (date: string, parkId: string, open: string, close: string, extra: Partial<{ earlyEntryMin: number | null; provenance: InfoProvenance }> = {}) => ({
  date,
  parkId,
  open,
  close,
  earlyEntryMin: null,
  provenance: you(),
  ...extra,
});

describe("dates, tickets and park days", () => {
  it("never plans more park days than the ticket has, and skips arrival/departure days as configured", () => {
    const it0 = plan(input({ parks: ["magic-kingdom", "epcot", "hollywood-studios", "animal-kingdom"] }));
    expect(parkDays(it0)).toHaveLength(4);
    expect(it0.days[0]!.kind).toBe("no_park");
    expect(it0.days[it0.days.length - 1]!.kind).toBe("no_park");
    expect(it0.status).toBe("feasible");
  });

  it("respects blocked-out dates, expiration and the use-within window", () => {
    const blocked = plan(input({}, {}, ctx({}, { usage: { useWithinDays: 7, parkReservationRequired: false, blockoutDates: [addDays(ARR, 2)] } })));
    expect(parkDays(blocked).map((d) => d.date)).not.toContain(addDays(ARR, 2));
    expect(blocked.days.find((d) => d.date === addDays(ARR, 2))!.window.detail).toMatch(/blocked-out/);

    const expires = plan(input({}, {}, ctx({}, { days: 4, usage: { useWithinDays: null, parkReservationRequired: null, expiresOn: addDays(ARR, 2) } })));
    expect(parkDays(expires).every((d) => d.date <= addDays(ARR, 2))).toBe(true);
    expect(expires.unknowns.join()).toMatch(/use-within window is unknown/);

    const within = plan(input({}, {}, ctx({ departure: addDays(ARR, 9) }, { days: 3, usage: { useWithinDays: 3, parkReservationRequired: false } })));
    const d = parkDays(within).map((x) => x.date);
    expect(d).toHaveLength(3);
    expect(verifyItinerary(input({}, {}, ctx({ departure: addDays(ARR, 9) }, { days: 3, usage: { useWithinDays: 3, parkReservationRequired: false } })), within)).toEqual([]);
  });

  it("uses fewer park days when asked, and reports unknown ticket rules", () => {
    const it0 = plan(input({ maxParkDays: 2 }, {}, ctx({}, { usage: null, usageSource: null })));
    expect(parkDays(it0)).toHaveLength(2);
    expect(it0.unknowns.join()).toMatch(/usage rules .* aren't recorded; none are assumed/);
    expect(it0.assumptions.join()).toMatch(/Using 2 of the ticket's 4 park days/);
  });

  it("a trip without tickets is infeasible, with the reason", () => {
    const it0 = plan(input({}, {}, ctx({ ticket: null })));
    expect(it0.status).toBe("infeasible");
    expect(it0.infeasibleReasons.join()).toMatch(/no park tickets/);
    expect(it0.score).toBeNull();
  });

  it("does not assume Park Hopper", () => {
    const it0 = plan(input({ allowHopping: true }));
    expect(parkDays(it0).every((d) => d.kind === "park")).toBe(true);
    expect(it0.conflicts.join()).toMatch(/doesn't include Park Hopper/);
    const pinned = plan(input({ pins: [{ date: addDays(ARR, 1), plan: { kind: "hop", parkIds: ["epcot", "hollywood-studios"] } }] }));
    expect(pinned.status).toBe("infeasible");
    expect(pinned.infeasibleReasons.join()).toMatch(/doesn't include Park Hopper/);
  });

  it("plans a hop day only with a hopper ticket, when commitments need two parks", () => {
    const pi = emptyParkInfo();
    const date = addDays(ARR, 2);
    pi.lightningLane.push({ id: "ll1", date, attractionId: "mk-space-mountain", start: "10:00", end: "11:00", provenance: you() });
    pi.dining.push({ id: "d1", date, parkId: "epcot", name: "TEST dinner", time: "18:00", durationMin: 75, provenance: you() });
    const it0 = plan(input({ allowHopping: true }, { parkInfo: pi }, ctx({}, { option: "park_hopper", hopper: true })));
    const day = it0.days.find((d) => d.date === date)!;
    expect(day.kind).toBe("hop");
    expect(day.parkIds).toEqual(["magic-kingdom", "epcot"]);
    expect(day.items.some((i) => i.kind === "transfer")).toBe(true);
    const noHopper = plan(input({ allowHopping: true }, { parkInfo: pi }));
    expect(noHopper.status).toBe("infeasible");
    expect(noHopper.infeasibleReasons.join()).toMatch(/need Park Hopper/);
  });
});

describe("hours, attractions and the timeline", () => {
  it("keeps everything inside known park hours (with early entry only when entered)", () => {
    const pi = emptyParkInfo();
    for (let i = 1; i <= 4; i++) for (const p of ["magic-kingdom", "epcot", "hollywood-studios", "animal-kingdom"]) pi.hours.push(hours(addDays(ARR, i), p, "10:00", "17:00", { earlyEntryMin: 30 }));
    const it0 = plan(input({ dayStart: "08:00", dayEnd: "22:00" }, { parkInfo: pi }));
    for (const d of parkDays(it0)) {
      expect(d.window.start).toBe(toMin("09:30"));
      expect(d.window.end).toBe(toMin("17:00"));
      expect(d.window.basis).toBe("park_hours");
      for (const i of d.items) {
        expect(i.start).toBeGreaterThanOrEqual(d.window.start);
        expect(i.end).toBeLessThanOrEqual(d.window.end);
      }
    }
    const noEarly = plan(input({ dayStart: "08:00", useEarlyEntry: false }, { parkInfo: pi }));
    expect(parkDays(noEarly)[0]!.window.start).toBe(toMin("10:00"));
  });

  it("without park hours, uses the planning window and says the plan is provisional", () => {
    const it0 = plan(input());
    expect(it0.provisional).toBe(true);
    expect(parkDays(it0)[0]!.window.basis).toBe("planning_window");
    expect(it0.unknowns.join()).toMatch(/Park hours are not entered/);
  });

  it("never overlaps activities and includes travel time between them", () => {
    const it0 = plan(input({ parks: ["magic-kingdom"], maxParkDays: 1 }));
    const items = parkDays(it0)[0]!.items;
    for (let i = 1; i < items.length; i++) expect(items[i]!.start - items[i]!.travelMin).toBeGreaterThanOrEqual(items[i - 1]!.end);
    expect(items.filter((i) => i.kind === "attraction").every((i) => i.travelMin >= 3)).toBe(true);
  });

  it("respects an attraction's own operating window and known closures", () => {
    const pi = emptyParkInfo();
    pi.attractionHours.push({ attractionId: "mk-philharmagic", date: null, start: "15:00", end: "16:00", provenance: you() });
    pi.closures.push({ attractionId: "mk-haunted-mansion", from: ARR, to: addDays(ARR, 10), provenance: you() });
    const i0 = input({ parks: ["magic-kingdom"], maxParkDays: 1, attractions: { "mk-philharmagic": "must", "mk-haunted-mansion": "must" } }, { parkInfo: pi });
    const it0 = plan(i0);
    const show = allItems(it0).find((x) => x.attractionId === "mk-philharmagic")!;
    expect(show.start).toBeGreaterThanOrEqual(toMin("15:00"));
    expect(show.end).toBeLessThanOrEqual(toMin("16:00"));
    expect(scheduledIds(it0).has("mk-haunted-mansion")).toBe(false);
    expect(it0.coverage.must.missing.find((m) => m.id === "mk-haunted-mansion")!.reason).toMatch(/closed/);
    expect(it0.status).toBe("partial");
    expect(verifyItinerary(i0, it0)).toEqual([]);
  });

  it("slower walking takes longer; minimizing walking doesn't walk more", () => {
    const base = input({ parks: ["epcot"], maxParkDays: 1 });
    const walk = (x: Itinerary) => parkDays(x).reduce((t, d) => t + d.walkingMin, 0);
    const slow = plan(input({ parks: ["epcot"], maxParkDays: 1, mobility: "slower" }));
    expect(allItems(slow)[0]!.travelMin).toBeGreaterThan(allItems(plan(base))[0]!.travelMin);
    const min = plan(input({ parks: ["epcot"], maxParkDays: 1, priorities: { minimizeWalking: true, maximizeAttractions: false, reduceBacktracking: true, relaxedSchedule: false } }));
    expect(walk(min) / Math.max(1, parkDays(min)[0]!.activityMin)).toBeLessThanOrEqual((walk(plan(base)) / parkDays(plan(base))[0]!.activityMin) * 1.05);
    expect(parkDays(min)[0]!.backtracks).toBe(0);
  });
});

describe("meals, breaks and pacing", () => {
  it("places lunch and dinner in their windows", () => {
    const it0 = plan(input({ parks: ["magic-kingdom"], maxParkDays: 1 }));
    const meals = allItems(it0).filter((i) => i.kind === "meal");
    const lunch = meals.find((m) => m.title === "Lunch")!;
    expect(lunch.start).toBeGreaterThanOrEqual(toMin("11:30"));
    expect(lunch.start).toBeLessThanOrEqual(toMin("13:30"));
    expect(meals.find((m) => m.title === "Dinner")!.start).toBeGreaterThanOrEqual(toMin("17:30"));
  });

  it("a dining reservation replaces the meal block and is kept at its time", () => {
    const pi = emptyParkInfo();
    const date = addDays(ARR, 1);
    pi.dining.push({ id: "d1", date, parkId: "magic-kingdom", name: "TEST lunch reservation", time: "12:15", durationMin: 60, provenance: you() });
    const it0 = plan(input({ parks: ["magic-kingdom", "epcot"] }, { parkInfo: pi }));
    const day = it0.days.find((d) => d.date === date)!;
    expect(day.parkIds).toEqual(["magic-kingdom"]);
    const dining = day.items.find((i) => i.kind === "dining")!;
    expect(dining.start).toBe(toMin("12:15"));
    expect(dining.basis[0]!.status).toBe("manual");
    expect(day.items.some((i) => i.title === "Lunch")).toBe(false);
  });

  it("relaxed days have breaks and less activity than packed days", () => {
    const relaxed = plan(input({ parks: ["magic-kingdom"], maxParkDays: 1, pace: "relaxed", dayEnd: "16:00", lunch: null }));
    const packed = plan(input({ parks: ["magic-kingdom"], maxParkDays: 1, pace: "packed", dayEnd: "16:00", lunch: null }));
    expect(allItems(relaxed).some((i) => i.kind === "break")).toBe(true);
    expect(allItems(packed).some((i) => i.kind === "break")).toBe(false);
    expect(parkDays(relaxed)[0]!.activityMin).toBeLessThan(parkDays(packed)[0]!.activityMin);
  });

  it("keeps afternoons flexible and adds a midday rest when asked", () => {
    const it0 = plan(input({ parks: ["epcot"], maxParkDays: 1, flexibleAfternoons: true, middayBreak: true, middayBreakMin: 60 }));
    const items = parkDays(it0)[0]!.items;
    expect(items.some((i) => i.kind === "flexible" && i.title.startsWith("Flexible time"))).toBe(true);
    expect(items.filter((i) => i.kind === "attraction").every((i) => i.end <= toMin("14:00") || i.start >= toMin("16:00"))).toBe(true);
    expect(items.some((i) => i.kind === "break" && i.title.startsWith("Midday rest"))).toBe(true);
  });
});

describe("must-dos, exclusions, hard vs soft", () => {
  it("never schedules an excluded attraction and prioritizes must-dos when time is short", () => {
    const pi = emptyParkInfo();
    pi.hours.push(hours(addDays(ARR, 1), "magic-kingdom", "09:00", "12:00"));
    const i0 = input(
      { parks: ["magic-kingdom"], maxParkDays: 1, pins: [{ date: addDays(ARR, 1), plan: { kind: "park", parkId: "magic-kingdom" } }], attractions: { "mk-small-world": "must", "mk-tianas": "must", "mk-tron": "avoid", "mk-space-mountain": "avoid" } },
      { parkInfo: pi },
    );
    const it0 = plan(i0);
    const ids = scheduledIds(it0);
    expect(ids.has("mk-small-world") && ids.has("mk-tianas")).toBe(true);
    expect(ids.has("mk-tron") || ids.has("mk-space-mountain")).toBe(false);
  });

  it("must-dos that can't fit make the plan partial, with the reason, instead of pretending", () => {
    const pi = emptyParkInfo();
    pi.hours.push(hours(addDays(ARR, 1), "epcot", "09:00", "10:00"));
    const musts = Object.fromEntries(ATTRACTIONS.filter((a) => a.parkId === "epcot").map((a) => [a.id, "must" as const]));
    const it0 = plan(input({ parks: ["epcot"], maxParkDays: 1, pins: [{ date: addDays(ARR, 1), plan: { kind: "park", parkId: "epcot" } }], attractions: musts }, { parkInfo: pi }));
    expect(it0.status).toBe("partial");
    expect(it0.coverage.must.missing.length).toBeGreaterThan(0);
    expect(it0.coverage.must.missing[0]!.reason).toMatch(/didn't fit/);
  });

  it("must-dos in a park the user didn't choose are reported, not silently dropped", () => {
    const it0 = plan(input({ parks: ["epcot"], attractions: { "mk-peter-pan": "must" } }));
    expect(it0.coverage.must.missing[0]).toMatchObject({ id: "mk-peter-pan", reason: expect.stringMatching(/isn't among the parks you chose/) });
  });

  it("pins are hard constraints even when the planner would choose otherwise", () => {
    const date = addDays(ARR, 1);
    const it0 = plan(input({ parks: ["epcot", "magic-kingdom"], pins: [{ date, plan: { kind: "park", parkId: "animal-kingdom" } }] }));
    expect(it0.days.find((d) => d.date === date)!.parkIds).toEqual(["animal-kingdom"]);
    const rest = plan(input({ pins: [{ date, plan: { kind: "rest" } }] }));
    expect(rest.days.find((d) => d.date === date)!.kind).toBe("rest");
  });

  it("infeasible requests explain why", () => {
    expect(plan(input({ pins: [{ date: "2030-01-01", plan: { kind: "park", parkId: "epcot" } }] })).infeasibleReasons.join()).toMatch(/not a day of this trip/);
    expect(plan(input({ pins: [{ date: ARR, plan: { kind: "park", parkId: "epcot" } }] })).infeasibleReasons.join()).toMatch(/arrival day/);
    const many = Array.from({ length: 4 }, (_, i) => ({ date: addDays(ARR, i + 1), plan: { kind: "park" as const, parkId: "epcot" } }));
    expect(plan(input({ maxParkDays: 2, pins: many })).infeasibleReasons.join()).toMatch(/only 2 are available/);
  });

  it("overlapping reservations are reported as conflicts; only the earlier one is planned", () => {
    const pi = emptyParkInfo();
    const date = addDays(ARR, 1);
    pi.dining.push({ id: "a", date, parkId: "epcot", name: "TEST A", time: "18:00", durationMin: 90, provenance: you() });
    pi.dining.push({ id: "b", date, parkId: "epcot", name: "TEST B", time: "18:30", durationMin: 60, provenance: you() });
    const it0 = plan(input({ parks: ["epcot"] }, { parkInfo: pi }));
    expect(it0.conflicts.join()).toMatch(/"TEST B" at 6:30 PM overlaps "TEST A"/);
    expect(allItems(it0).filter((i) => i.kind === "dining").map((i) => i.title)).toEqual(["TEST A"]);
  });
});

describe("data reliability", () => {
  it("demo runs are labelled, provisional and illustrative everywhere", () => {
    const it0 = plan(demoInput(TODAY));
    expect(it0.demo).toBe(true);
    expect(it0.provisional).toBe(true);
    expect(it0.headline).toMatch(/^Demonstration/);
    expect(it0.assumptions.join()).toMatch(/DEMONSTRATION: park hours and waits are illustrative/);
    expect(parkDays(it0).every((d) => d.window.basis === "illustrative_hours")).toBe(true);
    expect(it0.dataUsed.filter((d) => d.label.includes("hours")).every((d) => d.status === "illustrative")).toBe(true);
    expect(it0.score!.components.find((c) => c.key === "certainty")!.score).toBeLessThan(50);
  });

  it("old entries are shown as stale", () => {
    const pi = emptyParkInfo();
    pi.hours.push(hours(addDays(ARR, 1), "epcot", "09:00", "21:00", { provenance: you("2026-01-01") }));
    const it0 = plan(input({ parks: ["epcot"], maxParkDays: 1 }, { parkInfo: pi }));
    expect(it0.dataUsed.find((d) => d.label.includes("hours"))!.status).toBe("stale");
    expect(parkDays(it0)[0]!.window.detail).toMatch(/stale/);
    expect(it0.unknowns.join()).toMatch(/stale/);
  });

  it("user entries can't claim to be verified", () => {
    expect(userProvenanceSchema.safeParse({ status: "verified", source: "me", observedAt: "2026-10-30" }).success).toBe(false);
    expect(userProvenanceSchema.safeParse({ status: "manual", source: "me", observedAt: "2026-10-30" }).success).toBe(true);
  });

  it("validates park information and the whole input", () => {
    expect(parkInfoSchema.safeParse({ hours: [{ date: ARR, parkId: "epcot", open: "21:00", close: "09:00", provenance: you() }] }).success).toBe(false);
    expect(parkInfoSchema.safeParse({ lightningLane: [{ id: "x", date: ARR, attractionId: "mk-tron", start: "25:00", end: "26:00", provenance: you() }] }).success).toBe(false);
    expect(itineraryInputSchema.safeParse({ context: { ...ctx(), departure: ARR }, prefs: {}, parkInfo: {} }).success).toBe(false);
    expect(itineraryInputSchema.safeParse({ context: ctx(), prefs: {}, parkInfo: {} }).success).toBe(true);
  });
});

describe("waits and crowds are uncertain", () => {
  it("without wait data, rides use the planning buffer, labelled unknown", () => {
    const it0 = plan(input({ parks: ["hollywood-studios"], maxParkDays: 1, waitBufferMin: 25 }));
    const ride = allItems(it0).find((i) => i.attractionId === "hs-slinky")!;
    expect(ride.waitMin).toBe(25);
    expect(ride.waitBasis).toBe("assumed_buffer");
    expect(ride.basis[0]).toMatchObject({ status: "unavailable", label: expect.stringMatching(/Wait unknown/) });
    expect(it0.assumptions.join()).toMatch(/Actual waits will change the schedule/);
  });

  it("uses your own estimate, ignores observed (past) waits for planning, and scales the buffer by your crowd estimate", () => {
    const pi = emptyParkInfo();
    const date = addDays(ARR, 1);
    pi.waits.push({ attractionId: "hs-slinky", minutes: 45, kind: "your_estimate", date: null, provenance: { ...you(), status: "estimated" } });
    pi.waits.push({ attractionId: "hs-toy-story-mania", minutes: 90, kind: "observed", date: null, provenance: you() });
    pi.crowds.push({ date, parkId: "hollywood-studios", level: "high", provenance: { ...you(), status: "estimated" } });
    const it0 = plan(input({ parks: ["hollywood-studios"], maxParkDays: 1, waitBufferMin: 20, pins: [{ date, plan: { kind: "park", parkId: "hollywood-studios" } }] }, { parkInfo: pi }));
    const items = allItems(it0);
    expect(items.find((i) => i.attractionId === "hs-slinky")).toMatchObject({ waitMin: 45, waitBasis: "your_estimate" });
    expect(items.find((i) => i.attractionId === "hs-toy-story-mania")).toMatchObject({ waitMin: 30, waitBasis: "assumed_buffer" });
    expect(it0.assumptions.join()).toMatch(/observed wait time is shown for reference only/);
  });
});

describe("Lightning Lane", () => {
  it("uses return windows you entered, inside the window; availability is otherwise unknown", () => {
    const pi = emptyParkInfo();
    const date = addDays(ARR, 1);
    pi.lightningLane.push({ id: "ll", date, attractionId: "mk-seven-dwarfs", start: "13:00", end: "14:00", provenance: you() });
    const it0 = plan(input({ parks: ["magic-kingdom", "epcot"] }, { parkInfo: pi }));
    const ll = allItems(it0).find((i) => i.kind === "lightning_lane")!;
    expect(ll.date).toBe(date);
    expect(ll.start).toBeGreaterThanOrEqual(toMin("13:00"));
    expect(ll.start).toBeLessThanOrEqual(toMin("14:00"));
    expect(ll.basis[0]!.status).toBe("manual");
    expect(allItems(it0).filter((i) => i.attractionId === "mk-seven-dwarfs")).toHaveLength(1);

    const none = plan(input());
    expect(none.unknowns.join()).toMatch(/Lightning Lane availability is unknown and not assumed/);
    expect(allItems(none).some((i) => i.kind === "lightning_lane")).toBe(false);
  });

  it("a return window for an attraction you skip is not used", () => {
    const pi = emptyParkInfo();
    pi.lightningLane.push({ id: "ll", date: addDays(ARR, 1), attractionId: "mk-tron", start: "10:00", end: "11:00", provenance: you() });
    const it0 = plan(input({ attractions: { "mk-tron": "avoid" } }, { parkInfo: pi }));
    expect(scheduledIds(it0).has("mk-tron")).toBe(false);
  });
});

describe("park-day allocation", () => {
  it("gives each park with must-dos a day", () => {
    const it0 = plan(input({ parks: [], attractions: { "mk-peter-pan": "must", "ep-remy": "must", "hs-rise": "must", "ak-everest": "must" } }));
    expect(new Set(parkDays(it0).map((d) => d.parkIds[0]))).toEqual(new Set(["magic-kingdom", "epcot", "hollywood-studios", "animal-kingdom"]));
    expect(it0.coverage.must.scheduled).toBe(4);
  });

  it("a preferred rest day goes between park days when the trip allows it", () => {
    const it0 = plan(input({ parks: ["magic-kingdom", "epcot"], restDay: "prefer", maxParkDays: 3 }));
    const kinds = it0.days.map((d) => d.kind);
    const first = kinds.indexOf("park");
    const last = kinds.lastIndexOf("park");
    expect(kinds.slice(first, last).includes("rest")).toBe(true);
  });

  it("moves the most demanding day away from the first park day when asked", () => {
    const musts = { "mk-tron": "must", "mk-space-mountain": "must", "mk-big-thunder": "must", "mk-seven-dwarfs": "must" } as const;
    const it0 = plan(input({ parks: ["magic-kingdom", "epcot"], maxParkDays: 2, attractions: musts, avoidDemandingArrivalDay: true }));
    expect(parkDays(it0)[0]!.parkIds).toEqual(["epcot"]);
  });

  it("matches entered park reservations when reservations are required", () => {
    const pi = emptyParkInfo();
    pi.parkReservations.push({ date: addDays(ARR, 1), parkId: "animal-kingdom", provenance: you() });
    const i0 = input({ parks: ["magic-kingdom", "animal-kingdom"] }, { parkInfo: pi }, ctx({}, { usage: { useWithinDays: 7, parkReservationRequired: true } }));
    const it0 = plan(i0);
    expect(it0.days.find((d) => d.date === addDays(ARR, 1))!.parkIds).toEqual(["animal-kingdom"]);
    expect(parkDays(it0).filter((d) => d.date !== addDays(ARR, 1)).every((d) => d.notes.some((n) => n.startsWith("Needs a park reservation")))).toBe(true);
    expect(it0.unknowns.join()).toMatch(/can't check availability/);
    expect(verifyItinerary(i0, it0)).toEqual([]);
  });
});

describe("scoring, determinism and comparison", () => {
  it("is deterministic and reproducible", () => {
    const a = plan(demoInput(TODAY));
    const b = plan(demoInput(TODAY));
    expect(a).toEqual(b);
    expect(a.inputHash).toBe(b.inputHash);
    expect(plan({ ...demoInput(TODAY), prefs: { ...demoInput(TODAY).prefs, pace: "relaxed" } }).inputHash).not.toBe(a.inputHash);
  });

  it("documents its score components, weighted by your priorities", () => {
    const it0 = plan(input({ priorities: { minimizeWalking: true, maximizeAttractions: false, reduceBacktracking: false, relaxedSchedule: false } }));
    const c = it0.score!.components;
    expect(c.map((x) => x.key)).toEqual(["must_do", "preferences", "travel", "pacing", "certainty"]);
    expect(c.reduce((t, x) => t + x.weightPct, 0)).toBeGreaterThanOrEqual(99);
    expect(c.find((x) => x.key === "travel")!.weightPct).toBe(26); // 30 of 115
    expect(it0.score!.meaning).toMatch(/not a measure of how good the vacation will be/);
    expect(it0.search.note).toMatch(/highest-scoring candidate found, not a proven optimum/);
  });

  it("compares a relaxed and a ride-focused plan from the same facts", () => {
    const demo = demoInput(TODAY);
    const base = { ...demo, prefs: { ...demo.prefs, dayEnd: "17:00" } };
    const [relaxed, rides] = compareVariants(base, STANDARD_VARIANTS, { today: TODAY });
    const count = (x: Itinerary) => allItems(x).filter((i) => i.kind === "attraction").length;
    const free = (x: Itinerary) => allItems(x).filter((i) => i.kind === "break" || i.kind === "flexible").reduce((t, i) => t + i.end - i.start, 0);
    expect(count(rides!.itinerary)).toBeGreaterThan(count(relaxed!.itinerary));
    expect(free(relaxed!.itinerary)).toBeGreaterThan(free(rides!.itinerary));
    expect(relaxed!.itinerary.dataUsed).toEqual(rides!.itinerary.dataUsed); // same facts
    expect(compareSummary(relaxed!.itinerary, rides!.itinerary)[0]).toMatch(/^Must-dos: \d+ of \d+ vs \d+ of \d+\.$/);
  });
});

describe("robustness and bounded search", () => {
  it("random preference combinations never produce an invalid itinerary presented as feasible", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const prefsOpts: AttractionPrefRandom[] = ["must", "want", "avoid"];
    type AttractionPrefRandom = "must" | "want" | "avoid";
    for (let n = 0; n < 40; n++) {
      const attractions: Record<string, AttractionPrefRandom> = {};
      for (const a of ATTRACTIONS) if (rnd() < 0.3) attractions[a.id] = prefsOpts[Math.floor(rnd() * 3)]!;
      const pi = emptyParkInfo();
      if (rnd() < 0.5) for (let i = 1; i <= 4; i++) pi.hours.push(hours(addDays(ARR, i), "magic-kingdom", rnd() < 0.5 ? "09:00" : "10:00", rnd() < 0.5 ? "18:00" : "21:00"));
      if (rnd() < 0.4) pi.dining.push({ id: "d", date: addDays(ARR, 1 + Math.floor(rnd() * 4)), parkId: "epcot", name: "TEST", time: "12:00", durationMin: 60, provenance: you() });
      const i0 = input(
        {
          attractions,
          pace: (["relaxed", "moderate", "packed"] as const)[Math.floor(rnd() * 3)]!,
          middayBreak: rnd() < 0.3,
          flexibleAfternoons: rnd() < 0.3,
          mobility: rnd() < 0.5 ? "slower" : "standard",
          allowHopping: rnd() < 0.5,
        },
        { parkInfo: pi },
        ctx({}, rnd() < 0.5 ? { option: "park_hopper", hopper: true } : {}),
      );
      const it0 = plan(i0);
      expect(verifyItinerary(i0, it0), JSON.stringify({ n, prefs: i0.prefs, pi })).toEqual([]);
      if (it0.status !== "infeasible") {
        for (const id of Object.entries(attractions).filter(([, p]) => p === "avoid").map(([id]) => id)) expect(scheduledIds(it0).has(id)).toBe(false);
      }
    }
  });

  it("a long multi-park trip with Park Hopper stays bounded and fast", () => {
    const musts = Object.fromEntries(ATTRACTIONS.filter((_, i) => i % 3 === 0).map((a) => [a.id, "must" as const]));
    const i0 = input({ allowHopping: true, attractions: musts, restDay: "prefer" }, {}, ctx({ departure: addDays(ARR, 14) }, { option: "park_hopper", hopper: true, days: 10, usage: { useWithinDays: 14, parkReservationRequired: false } }));
    const t0 = performance.now();
    const it0 = plan(i0);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(3000);
    expect(it0.search.candidatesScheduled).toBeLessThanOrEqual(LIMITS.candidatesScheduled);
    expect(it0.search.limited).toBe(true);
    expect(parkDays(it0).length).toBeLessThanOrEqual(10);
    expect(verifyItinerary(i0, it0)).toEqual([]);
  });

  it("trips longer than the planning limit are capped, with a note", () => {
    const it0 = plan(input({}, {}, ctx({ departure: addDays(ARR, 40) })));
    expect(it0.days.length).toBe(LIMITS.maxTripDays);
    expect(it0.conflicts.join()).toMatch(/Only the first 21 days/);
  });

  it("catalog sanity: every attraction belongs to a known park area", () => {
    for (const a of ATTRACTIONS) expect(attractionById.get(a.id)).toBe(a);
  });
});

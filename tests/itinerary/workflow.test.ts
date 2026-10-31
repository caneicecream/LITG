import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultTripRequest } from "@/data/defaults";
import { contextDifferences, demoInput, tripContextFromRequest } from "@/itinerary/context";
import { compareItineraries, compareVariants, planItinerary, STANDARD_VARIANTS } from "@/itinerary/engine";
import type { TripContext } from "@/itinerary/types";

// Comparisons and the trip ↔ itinerary workflow. Demo/test data is illustrative or fictional.

const TODAY = "2026-10-31";

describe("comparing itineraries", () => {
  const base = { ...demoInput(TODAY), prefs: { ...demoInput(TODAY).prefs, dayEnd: "17:00" } };
  const [relaxed, rides] = compareVariants(base, STANDARD_VARIANTS, { today: TODAY });

  it("uses the same facts and reports what differs and what it costs", () => {
    const c = compareItineraries(relaxed!, rides!);
    expect(c.sameFacts).toBe(true);
    expect(c.factDifferences).toEqual([]);
    expect(c.preferenceDifferences).toEqual(expect.arrayContaining(["Pace: relaxed vs packed", "Midday rest: on vs off"]));
    const labels = c.rows.map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(["Must-dos scheduled", "Walking and transfers (estimated)", "Waiting from your estimates", "Waiting assumed (buffer, unknown real waits)", "Meals", "Breaks", "Free time within the plan", "Earliest start", "Latest finish", "Feasibility"]));
    expect(c.tradeoffs.join(" ")).toMatch(/“Ride-focused” fits \d+ more attractions? than “Relaxed”, at the cost of \d+ fewer minutes of breaks and free time.*More activities isn't automatically better/);
    expect(c.tradeoffs.join(" ")).toMatch(/assumed buffer, not a forecast/);
    // Different priorities → different weights → totals not directly comparable.
    expect(c.scoresComparable).toBe(false);
    expect(c.tradeoffs.join(" ")).toMatch(/compare the rows above rather than the two totals/);
  });

  it("discloses when two plans don't use the same facts", () => {
    const other = { ...relaxed!.input, parkInfo: { ...relaxed!.input.parkInfo, hours: [] } };
    const c = compareItineraries(relaxed!, { label: "No hours", input: other, itinerary: planItinerary(other, { today: TODAY }) });
    expect(c.sameFacts).toBe(false);
    expect(c.factDifferences.join()).toMatch(/different park information/);
    expect(c.scoresComparable).toBe(false);
    expect(c.tradeoffs.join(" ")).toMatch(/don't use the same facts, so their scores can't be compared directly/);
  });

  it("identical preferences give comparable scores", () => {
    const it0 = planItinerary(base, { today: TODAY });
    const c = compareItineraries({ label: "A", input: base, itinerary: it0 }, { label: "B", input: base, itinerary: it0 });
    expect(c.scoresComparable).toBe(true);
    expect(c.preferenceDifferences).toEqual([]);
  });
});

describe("trip and itinerary", () => {
  it("plans a specific optimized option, not silently the preferred plan", () => {
    const req = defaultTripRequest();
    const r = tripContextFromRequest(req, null, { kind: "request", label: "Option" }, TODAY, {
      arrival: "2027-02-01",
      nights: 5,
      resortId: "all-star-movies",
      roomTypeId: "standard",
      ticketOption: "park_hopper",
      bookingMethod: "separate",
      dining: "out_of_pocket",
    });
    expect(r.ok && r.context).toMatchObject({ arrival: "2027-02-01", departure: "2027-02-06", resortId: "all-star-movies", ticket: { option: "park_hopper", days: 5, hopper: true } });
  });

  it("lists every change to the trip, never applying it silently", () => {
    const a = demoInput(TODAY).context;
    const b: TripContext = { ...a, arrival: "2027-02-02", departure: "2027-02-07", ticket: { ...a.ticket!, option: "park_hopper", hopper: true }, party: { ...a.party, children: 2 } };
    const d = contextDifferences(a, b);
    expect(d.join(" | ")).toMatch(/Dates: 2027-02-01 → 2027-02-06 is now 2027-02-02 → 2027-02-07/);
    expect(d.join(" | ")).toMatch(/Tickets: 4 park days, one park per day \(base\) is now 4 park days, Park Hopper \(park_hopper\)/);
    expect(d.join(" | ")).toMatch(/Party:/);
    expect(contextDifferences(a, a)).toEqual([]);
  });
});

describe("workflow APIs (JSON mode)", () => {
  let dir: string;
  const saved = process.env.DATABASE_URL;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dvo-wf-"));
    process.env.DVO_STORE_PATH = path.join(dir, "store.json");
    delete process.env.DATABASE_URL;
  });
  afterAll(() => {
    delete process.env.DVO_STORE_PATH;
    if (saved !== undefined) process.env.DATABASE_URL = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const post = (body: unknown) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("builds the context for an optimized option and validates it", async () => {
    const { POST } = await import("@/app/api/itinerary/context/route");
    const option = { arrival: "2027-01-18", nights: 5, resortId: "pop-century", roomTypeId: "standard", ticketOption: "park_hopper", bookingMethod: "package", dining: "out_of_pocket" };
    const r = await (await POST(post({ request: defaultTripRequest(), option }))).json();
    expect(r.context).toMatchObject({ arrival: "2027-01-18", departure: "2027-01-23", source: { label: "Option: Disney's Pop Century Resort, 2027-01-18, 5 nights" } });
    const bad = await POST(post({ request: defaultTripRequest(), option: { ...option, resortId: "nowhere" } }));
    expect(bad.status).toBe(400);
  });

  it("saved itineraries say which trip they were planned for", async () => {
    const { POST, GET } = await import("@/app/api/itineraries/route");
    await POST(post({ name: "Demo", input: demoInput(TODAY) }));
    const list = (await (await GET()).json()).itineraries;
    expect(list[0].trip).toEqual({ label: "Demonstration trip (fictional)", arrival: "2027-02-01", departure: "2027-02-06" });
  });

  it("the plan API returns comparison details", async () => {
    const { POST } = await import("@/app/api/itinerary/plan/route");
    const r = await (await POST(post({ input: demoInput(TODAY), compare: true }))).json();
    expect(r.comparison.details.sameFacts).toBe(true);
    expect(r.comparison.details.rows.length).toBeGreaterThan(10);
  });
});

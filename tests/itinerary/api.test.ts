import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultTripRequest } from "@/data/defaults";
import { demoInput } from "@/itinerary/context";

// Route handlers in JSON mode (no database). Demo input is illustrative.

let dir: string;
const saved = process.env.DATABASE_URL;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dvo-itin-api-"));
  process.env.DVO_STORE_PATH = path.join(dir, "store.json");
  delete process.env.DATABASE_URL;
});
afterAll(() => {
  delete process.env.DVO_STORE_PATH;
  if (saved !== undefined) process.env.DATABASE_URL = saved;
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("itinerary API", () => {
  it("plans from validated input and rejects invalid input", async () => {
    const { POST } = await import("@/app/api/itinerary/plan/route");
    const ok = await POST(post({ input: demoInput(), compare: true }));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.itinerary.demo).toBe(true);
    expect(body.comparison.variants.map((v: { label: string }) => v.label)).toEqual(["Relaxed", "Ride-focused"]);
    const bad = demoInput();
    bad.parkInfo.hours[0]!.close = "05:00";
    const r = await POST(post({ input: bad }));
    expect(r.status).toBe(400);
    expect((await r.json()).errors.join()).toMatch(/Closing time must be after opening time/);
    const verified = demoInput();
    (verified.parkInfo.dining[0]!.provenance as { status: string }).status = "made-up";
    expect((await POST(post({ input: verified }))).status).toBe(400);
  });

  it("builds the trip context from the planner's request", async () => {
    const { POST } = await import("@/app/api/itinerary/context/route");
    const r = await POST(post({ request: defaultTripRequest() }));
    const { context } = await r.json();
    expect(context).toMatchObject({ arrival: "2027-01-17", departure: "2027-01-23", resortId: "pop-century", ticket: { option: "park_hopper_plus", days: 5, hopper: true } });
    const incomplete = await POST(post({ request: { ...defaultTripRequest(), preferred: {} } }));
    expect(incomplete.status).toBe(422);
  });

  it("saving re-plans on the server (a client result is never stored) and versions accumulate", async () => {
    const list = await import("@/app/api/itineraries/route");
    const one = await import("@/app/api/itineraries/[id]/route");
    const created = await list.POST(post({ name: "Demo", input: demoInput(), result: { headline: "forged" } }));
    expect(created.status).toBe(201);
    const { itinerary } = await created.json();
    expect(itinerary.versions[0].result.headline).toMatch(/^Demonstration — Best candidate found/);
    const ctx = { params: Promise.resolve({ id: itinerary.id }) };
    const relaxed = demoInput();
    relaxed.prefs.pace = "relaxed";
    const v2 = await (await one.POST(post({ name: "Demo", note: "Relaxed", input: relaxed }), ctx)).json();
    expect(v2.itinerary.versions.map((v: { version: number; note: string }) => [v.version, v.note])).toEqual([
      [1, "Generated"],
      [2, "Relaxed"],
    ]);
    const all = await (await list.GET()).json();
    expect(all.itineraries[0]).toMatchObject({ id: itinerary.id, versionCount: 2 });
    expect((await one.DELETE(new Request("http://x"), ctx)).status).toBe(204);
    expect((await one.GET(new Request("http://x"), ctx)).status).toBe(404);
  });
});

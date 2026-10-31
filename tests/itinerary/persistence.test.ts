import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsonBackend, readStoreFile } from "@/data/backends/json";
import { pgBackendFor } from "@/data/backends/pg";
import type { StoreBackend } from "@/data/store";
import { importJsonStore } from "@/db/importJson";
import type { Db } from "@/db/pool";
import { defaultTripRequest } from "@/data/defaults";
import { demoInput } from "@/itinerary/context";
import { ITINERARY_ENGINE_VERSION, planItinerary } from "@/itinerary/engine";
import { describeDb, freshSchema } from "../db/helpers";

// Saved itineraries: append-only versions in JSON and PostgreSQL. Demo (illustrative) inputs only.

const TODAY = "2026-10-31";
const v1Input = demoInput(TODAY);
const v1 = planItinerary(v1Input, { today: TODAY });
const v2Input = { ...v1Input, prefs: { ...v1Input.prefs, pace: "relaxed" as const } };
const v2 = planItinerary(v2Input, { today: TODAY });

function contract(name: string, get: () => StoreBackend) {
  describe(`saved itineraries (${name})`, () => {
    it("save, append a version, reopen: earlier versions are kept unchanged", async () => {
      const store = get();
      const saved = (await store.saveItinerary({ name: "Demo plan", tripId: null, note: "Generated", input: v1Input, result: v1 }))!;
      expect(saved.versions).toHaveLength(1);
      const again = (await store.saveItinerary({ id: saved.id, name: "Demo plan (relaxed)", tripId: null, note: "Regenerated: relaxed pace", input: v2Input, result: v2 }))!;
      expect(again.versions.map((v) => v.version)).toEqual([1, 2]);
      const reopened = (await store.getItinerary(saved.id))!;
      expect(reopened.name).toBe("Demo plan (relaxed)");
      expect(reopened.versions[0]!.result).toEqual(v1);
      expect(reopened.versions[0]!.input.prefs.pace).toBe("moderate");
      expect(reopened.versions[1]!).toMatchObject({ note: "Regenerated: relaxed pace", engineVersion: ITINERARY_ENGINE_VERSION });
      expect(reopened.versions[1]!.input.parkInfo.hours[0]!.provenance.status).toBe("illustrative");
      const list = await store.listItineraries();
      expect(list.find((x) => x.id === saved.id)).toMatchObject({ versionCount: 2, latest: { version: 2, demo: true, status: v2.status } });
      expect(await store.saveItinerary({ id: "missing", name: "x", tripId: null, note: "", input: v1Input, result: v1 })).toBeUndefined();
      expect(await store.deleteItinerary(saved.id)).toBe(true);
      expect(await store.getItinerary(saved.id)).toBeUndefined();
    });
  });
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dvo-itin-"));
  process.env.DVO_STORE_PATH = path.join(dir, "store.json");
});
afterAll(() => {
  delete process.env.DVO_STORE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

contract("JSON", () => jsonBackend);

describe("JSON backward compatibility", () => {
  it("a store file from before Milestone 5 (no itineraries) still loads and accepts itineraries", async () => {
    const file = path.join(dir, "old.json");
    writeFileSync(file, JSON.stringify({ version: 1, prices: [], trips: [], conversations: [] }));
    const data = await readStoreFile(file);
    expect(data.itineraries).toEqual([]);
    process.env.DVO_STORE_PATH = file;
    await jsonBackend.saveItinerary({ name: "x", tripId: null, note: "Generated", input: v1Input, result: v1 });
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.itineraries).toHaveLength(1);
    process.env.DVO_STORE_PATH = path.join(dir, "store.json");
  });
});

describeDb("PostgreSQL itineraries", () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshSchema("t_itinerary");
  });
  afterAll(() => db.end());
  contract("PostgreSQL", () => pgBackendFor(db));

  it("saved versions are immutable in the database", async () => {
    const store = pgBackendFor(db);
    const s = (await store.saveItinerary({ name: "Immutable", tripId: null, note: "Generated", input: v1Input, result: v1 }))!;
    await expect(db.query("UPDATE itinerary_versions SET note = 'changed' WHERE itinerary_id = $1", [s.id])).rejects.toThrow(/immutable/);
  });

  it("links to a saved trip, and survives the trip's deletion", async () => {
    const store = pgBackendFor(db);
    const trip = await store.saveTrip({ name: "Trip", request: defaultTripRequest() });
    const s = (await store.saveItinerary({ name: "Linked", tripId: trip.id, note: "Generated", input: v1Input, result: v1 }))!;
    expect(s.tripId).toBe(trip.id);
    await store.deleteTrip(trip.id);
    expect((await store.getItinerary(s.id))!.tripId).toBeNull();
  });

  it("the JSON import brings itineraries and versions over, idempotently", async () => {
    const file = { version: 1 as const, prices: [], trips: [], conversations: [], itineraries: [{ id: "itin-json", name: "From JSON", tripId: "gone", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", versions: [{ version: 1, createdAt: "2026-10-01T00:00:00.000Z", note: "Generated", engineVersion: v1.engineVersion, input: v1Input, result: v1 }] }] };
    const r = await importJsonStore(db, file);
    expect(r.itineraries).toEqual({ imported: 1, alreadyPresent: 0, versionsImported: 1 });
    expect((await importJsonStore(db, file)).itineraries).toEqual({ imported: 0, alreadyPresent: 1, versionsImported: 0 });
    const got = (await pgBackendFor(db).getItinerary("itin-json"))!;
    expect(got.tripId).toBeNull();
    expect(got.versions[0]!.result).toEqual(v1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgBackendFor } from "@/data/backends/pg";
import { observationsForEntries } from "@/db/observations";
import { migrationStatus, runMigrations, assertSchemaCurrent } from "@/db/migrate";
import { MIGRATIONS } from "@/db/migrations";
import { createDb, DatabaseUnavailableError, SchemaOutOfDateError, type Db } from "@/db/pool";
import type { StoreBackend, UserPriceEntry } from "@/data/store";
import type { StayQuote } from "@/domain/types";
import { defaultTripRequest } from "@/data/defaults";
import { describeDb, freshSchema, popQuote } from "./helpers";

// PostgreSQL persistence (requires TEST_DATABASE_URL). All prices fictional.

describeDb("migrations", () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshSchema("t_migrations", { migrate: false });
  });
  afterAll(() => db.end());

  it("apply in order, are recorded, and re-running is a no-op", async () => {
    expect((await migrationStatus(db)).pending).toEqual(MIGRATIONS.map((m) => m.version));
    await expect(assertSchemaCurrent(db)).rejects.toBeInstanceOf(SchemaOutOfDateError);
    expect(await runMigrations(db)).toEqual(["001", "002", "003"]);
    expect(await runMigrations(db)).toEqual([]);
    await expect(assertSchemaCurrent(db)).resolves.toBeUndefined();
    const tables = await db.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 't_migrations' ORDER BY 1");
    expect(tables.map((r) => r.t)).toEqual(
      expect.arrayContaining(["price_entries", "price_observations", "trips", "trip_runs", "conversations", "monitors", "monitor_checks", "notifications", "app_settings", "schema_migrations", "itineraries", "itinerary_versions"]),
    );
  });

  it("refuse to run when an applied migration was edited", async () => {
    await db.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '001'");
    await expect(migrationStatus(db)).rejects.toThrow(/changed after it was applied/);
  });
});

describeDb("PostgreSQL store", () => {
  let db: Db;
  let store: StoreBackend;
  beforeAll(async () => {
    db = await freshSchema("t_store");
    store = pgBackendFor(db);
  });
  afterAll(() => db.end());

  it("persists entries with one observation each", async () => {
    const saved = await store.addPrice(popQuote());
    const [listed] = await store.listPrices();
    expect(listed).toEqual(saved);
    const obs = await observationsForEntries(db.query, [saved.id]);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ origin: "entry", source: "disneyworld.com quote (TEST)", observedOn: "2026-10-20", value: 250_000, comparableTotalCents: 250_000, taxIncluded: true });
    expect(obs[0]!.config).toMatchObject({ resortId: "pop-century", checkIn: "2027-02-01", checkOut: "2027-02-05", ticketOption: "base", ticketDays: 3, dining: "out_of_pocket" });
    expect(obs[0]!.assumptions.join()).toMatch(/terms were not recorded/);
  });

  it("re-checks append observations and rebuild history; nothing is overwritten", async () => {
    const e = await store.addPrice(popQuote({ label: "recheck" }));
    const r1 = await store.recheckPrice(e.id, { observedAt: "2026-10-25", value: 240_000, source: "phone call (TEST)" });
    expect(r1.ok).toBe(true);
    const r2 = await store.recheckPrice(e.id, { observedAt: "2026-10-28" }); // still current
    expect(r2.ok).toBe(true);
    const obs = await observationsForEntries(db.query, [e.id]);
    expect(obs.map((o) => [o.origin, o.observedOn, o.value])).toEqual([
      ["entry", "2026-10-20", 250_000],
      ["recheck", "2026-10-25", 240_000],
      ["recheck", "2026-10-28", 240_000],
    ]);
    const listed = (await store.listPrices()).find((p) => p.id === e.id)! as StayQuote;
    expect(listed.totalCents).toBe(240_000);
    expect(listed.history?.map((h) => [h.observedAt, h.value, h.source])).toEqual([
      ["2026-10-20", 250_000, "disneyworld.com quote (TEST)"],
      ["2026-10-25", 240_000, "phone call (TEST)"],
    ]);
  });

  it("re-reading the same quote never creates an observation", async () => {
    const e = await store.addPrice(popQuote({ label: "dup" }));
    const again = await store.recheckPrice(e.id, { observedAt: "2026-10-20" });
    expect(again).toEqual({ ok: false, error: expect.stringMatching(/Nothing new to record/) });
    expect(await observationsForEntries(db.query, [e.id])).toHaveLength(1);
  });

  it("observations are append-only at the database level", async () => {
    const [o] = await db.query<{ id: string }>("SELECT id FROM price_observations LIMIT 1");
    await expect(db.query("UPDATE price_observations SET value = 1 WHERE id = $1", [o!.id])).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM price_observations WHERE id = $1", [o!.id])).rejects.toThrow(/append-only/);
  });

  it("deleting an entry hides it but keeps its history", async () => {
    const e = await store.addPrice(popQuote({ label: "to delete" }));
    expect(await store.deletePrice(e.id)).toBe(true);
    expect((await store.listPrices()).some((p) => p.id === e.id)).toBe(false);
    expect(await observationsForEntries(db.query, [e.id])).toHaveLength(1);
    expect(await store.deletePrice(e.id)).toBe(false);
  });

  it("bulk adds are all-or-nothing", async () => {
    const before = (await store.listPrices()).length;
    const bad = { ...popQuote(), provenance: { status: "manual", source: "x", observedAt: "not-a-date" } } as unknown as Omit<UserPriceEntry, "id">;
    await expect(store.addPrices([popQuote({ label: "ok" }), bad])).rejects.toThrow();
    expect((await store.listPrices()).length).toBe(before);
  });

  it("saves trips with run snapshots, newest first", async () => {
    const t = await store.saveTrip({ name: "Feb trip", request: defaultTripRequest(), run: { runAt: "2026-10-01T00:00:00.000Z", demoMode: true, comparable: 3 } });
    await store.saveTrip({ id: t.id, name: "Feb trip (renamed)", request: defaultTripRequest(), run: { runAt: "2026-10-02T00:00:00.000Z", demoMode: true, comparable: 4 } });
    const got = await store.getTrip(t.id);
    expect(got?.name).toBe("Feb trip (renamed)");
    expect(got?.runs.map((r) => r.comparable)).toEqual([4, 3]);
    expect(got?.request).toEqual(defaultTripRequest());
    // Key order survives the round trip (jsonb reorders keys; the store re-parses).
    expect(Object.keys(got!.request.weights)).toEqual(Object.keys(defaultTripRequest().weights));
    expect(await store.deleteTrip(t.id)).toBe(true);
    expect(await store.getTrip(t.id)).toBeUndefined();
  });

  it("saves conversations", async () => {
    const conv = { id: "c1", title: "Test", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", request: defaultTripRequest(), confirmed: [], autoApply: false, messages: [], lastResult: null, lastVariants: [] };
    await store.saveConversation(conv);
    await store.saveConversation({ ...conv, title: "Renamed", updatedAt: "2026-10-02T00:00:00.000Z" });
    expect((await store.getConversation("c1"))?.title).toBe("Renamed");
    expect(await store.listConversations()).toEqual([{ id: "c1", title: "Renamed", createdAt: conv.createdAt, updatedAt: "2026-10-02T00:00:00.000Z", messageCount: 0 }]);
    expect(await store.deleteConversation("c1")).toBe(true);
  });
});

describe("database failure handling", () => {
  it("an unreachable database raises a clear DatabaseUnavailableError", async () => {
    const db = createDb("postgresql://nobody:x@127.0.0.1:1/none");
    await expect(db.query("SELECT 1")).rejects.toBeInstanceOf(DatabaseUnavailableError);
    await expect(db.tx(async (q) => q("SELECT 1"))).rejects.toThrow(/database is unavailable.*Check DATABASE_URL/);
    await db.end();
  });

  it("store-backed routes answer 503 instead of crashing", async () => {
    const { guarded } = await import("@/lib/guarded");
    const h = guarded(async () => {
      throw new DatabaseUnavailableError(new Error("connect ECONNREFUSED"));
    });
    const res = await h();
    expect(res.status).toBe(503);
    expect((await res.json()).database).toBe("unavailable");
  });

  it("monitoring reports 'not configured' (not an error) without DATABASE_URL", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const { GET } = await import("@/app/api/monitoring/route");
      const res = await GET();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ available: false, reason: "not_configured" });
      const { POST } = await import("@/app/api/monitoring/route");
      const created = await POST(new Request("http://x/api/monitoring", { method: "POST", body: JSON.stringify({ tripId: "t" }) }));
      expect(created.status).toBe(503);
      expect((await created.json()).database).toBe("not_configured");
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});

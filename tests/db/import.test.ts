import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pgBackendFor } from "@/data/backends/pg";
import { readStoreFile } from "@/data/backends/json";
import { observationsForEntries } from "@/db/observations";
import { importJsonStore } from "@/db/importJson";
import type { Db } from "@/db/pool";
import type { StoreFile } from "@/data/store";
import type { StayQuote } from "@/domain/types";
import { defaultTripRequest } from "@/data/defaults";
import { describeDb, freshSchema, popQuote } from "./helpers";

// JSON store → PostgreSQL import (requires TEST_DATABASE_URL). Fictional data.

describeDb("JSON store import", () => {
  let db: Db;
  let dir: string;
  let file: string;
  const quoteWithHistory: StayQuote = {
    ...(popQuote({ totalCents: 230_000, provenance: { status: "manual", source: "phone (TEST)", observedAt: "2026-10-25" } }) as StayQuote),
    id: "user-q1",
    history: [
      { observedAt: "2026-10-01", supersededAt: "2026-10-10T09:00:00.000Z", status: "manual", source: "site (TEST)", value: 260_000 },
      { observedAt: "2026-10-10", supersededAt: "2026-10-25T09:00:00.000Z", status: "manual", source: "site (TEST)", value: 250_000 },
    ],
  };
  const storeFile: StoreFile = {
    version: 1,
    prices: [quoteWithHistory, { ...(popQuote({ resortId: "all-star-movies", label: "no history" }) as StayQuote), id: "user-q2" }],
    trips: [{ id: "trip-1", name: "Imported trip", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", request: defaultTripRequest(), runs: [{ runAt: "2026-10-02T00:00:00.000Z", demoMode: true, comparable: 5 }] }],
    conversations: [{ id: "conv-1", title: "Imported chat", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", request: defaultTripRequest(), confirmed: [], autoApply: false, messages: [], lastResult: null, lastVariants: [] }],
  };
  const sha = () => createHash("sha256").update(readFileSync(file)).digest("hex");

  beforeAll(async () => {
    db = await freshSchema("t_import");
    dir = mkdtempSync(path.join(tmpdir(), "dvo-import-"));
    file = path.join(dir, "store.json");
    writeFileSync(file, JSON.stringify(storeFile, null, 2));
  });
  afterAll(async () => {
    await db.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a dry run reports without writing anything", async () => {
    const r = await importJsonStore(db, await readStoreFile(file), { dryRun: true });
    expect(r.prices.imported).toBe(2);
    expect(r.observations.imported).toBe(4);
    expect((await db.query("SELECT 1 FROM price_entries")).length).toBe(0);
  });

  it("imports prices with their full history, trips with runs, and conversations", async () => {
    const before = sha();
    const r = await importJsonStore(db, await readStoreFile(file), { now: "2026-10-30T00:00:00.000Z" });
    expect(r).toMatchObject({ prices: { imported: 2, alreadyPresent: 0 }, observations: { imported: 4 }, trips: { imported: 1, runsImported: 1 }, conversations: { imported: 1 } });
    expect(sha()).toBe(before); // the JSON file is never modified

    const obs = await observationsForEntries(db.query, ["user-q1"]);
    expect(obs.map((o) => [o.observedOn, o.value, o.origin])).toEqual([
      ["2026-10-01", 260_000, "import"],
      ["2026-10-10", 250_000, "import"],
      ["2026-10-25", 230_000, "import"],
    ]);
    expect(obs[0]!.assumptions.join()).toMatch(/kept only the price, date, status and source/);

    const store = pgBackendFor(db);
    const q1 = (await store.listPrices()).find((p) => p.id === "user-q1")!;
    expect(q1.history?.map((h) => [h.observedAt, h.value])).toEqual([
      ["2026-10-01", 260_000],
      ["2026-10-10", 250_000],
    ]);
    expect((await store.getTrip("trip-1"))?.runs).toHaveLength(1);
    expect((await store.getConversation("conv-1"))?.title).toBe("Imported chat");
  });

  it("is idempotent and never overwrites existing rows", async () => {
    const changed = await readStoreFile(file);
    (changed.prices[1] as StayQuote).totalCents = 1; // differs from the database copy
    const r = await importJsonStore(db, changed);
    expect(r.prices).toEqual({ imported: 0, alreadyPresent: 2, differing: ["user-q2"] });
    expect(r.observations.imported).toBe(0);
    expect(r.warnings.join()).toMatch(/left unchanged/);
    const q2 = (await pgBackendFor(db).listPrices()).find((p) => p.id === "user-q2") as StayQuote;
    expect(q2.totalCents).toBe(250_000);
  });

  it("aborts with nothing imported when the file is structurally broken", async () => {
    const broken = { ...storeFile, prices: [{ ...storeFile.prices[0]!, id: "user-new" }, { ...storeFile.prices[0]!, id: "", kind: "nonsense" }] } as unknown as StoreFile;
    await expect(importJsonStore(db, broken)).rejects.toThrow(/nothing was imported/);
    expect((await db.query("SELECT 1 FROM price_entries WHERE id = 'user-new'")).length).toBe(0);
  });

  it("imports entries that fail today's validation verbatim, with a warning", async () => {
    const odd = { ...storeFile, trips: [], conversations: [], prices: [{ ...(popQuote({ roomTypeId: "retired-room" }) as StayQuote), id: "user-odd" }] };
    const r = await importJsonStore(db, odd);
    expect(r.prices.imported).toBe(1);
    expect(r.warnings.join()).toMatch(/user-odd doesn't pass current validation/);
  });
});

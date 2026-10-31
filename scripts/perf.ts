/**
 * Workflow timings: itinerary planning, regeneration, saving/reopening versions
 * (JSON, and PostgreSQL when DATABASE_URL is set), monitoring history queries.
 *   npm run perf
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addDays } from "@/domain/dates";
import { ATTRACTIONS } from "@/itinerary/catalog";
import { demoInput } from "@/itinerary/context";
import { compareVariants, planItinerary, STANDARD_VARIANTS } from "@/itinerary/engine";
import type { ItineraryInput } from "@/itinerary/types";
import type { StayQuote } from "@/domain/types";

const today = "2026-10-31";
function time<T>(label: string, fn: () => T, runs = 5): T {
  const ms: number[] = [];
  let out!: T;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    out = fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  console.log(`${label.padEnd(58)} median ${ms[Math.floor(ms.length / 2)]!.toFixed(1)} ms (max ${ms[ms.length - 1]!.toFixed(1)})`);
  return out;
}
async function timeAsync(label: string, fn: () => Promise<unknown>, runs = 5) {
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  console.log(`${label.padEnd(58)} median ${ms[Math.floor(ms.length / 2)]!.toFixed(1)} ms (max ${ms[ms.length - 1]!.toFixed(1)})`);
}

async function main() {
  const demo = demoInput(today);
  time("Itinerary: demo (4 park days)", () => planItinerary(demo, { today }));
  const big: ItineraryInput = {
    ...demo,
    context: { ...demo.context, departure: addDays(demo.context.arrival, 14), ticket: { option: "park_hopper", days: 10, hopper: true, usage: { useWithinDays: 14, parkReservationRequired: false }, usageSource: "perf" } },
    prefs: { ...demo.prefs, allowHopping: true, attractions: Object.fromEntries(ATTRACTIONS.filter((_, i) => i % 3 === 0).map((a) => [a.id, "must" as const])) },
  };
  time("Itinerary: 15-day trip, 10 hopper days, 23 must-dos", () => planItinerary(big, { today }));
  time("Itinerary: regenerate after an edit (pace → relaxed)", () => planItinerary({ ...demo, prefs: { ...demo.prefs, pace: "relaxed" } }, { today }));
  time("Itinerary: relaxed vs ride-focused comparison", () => compareVariants(demo, STANDARD_VARIANTS, { today }));

  const dir = mkdtempSync(path.join(tmpdir(), "dvo-perf-"));
  process.env.DVO_STORE_PATH = path.join(dir, "store.json");
  const { jsonBackend } = await import("@/data/backends/json");
  const result = planItinerary(demo, { today });
  let id = "";
  await timeAsync("JSON: save itinerary version", async () => {
    const s = await jsonBackend.saveItinerary({ id: id || undefined, name: "perf", tripId: null, note: "perf", input: demo, result });
    id = s!.id;
  }, 20);
  await timeAsync("JSON: reopen itinerary with 20 versions", () => jsonBackend.getItinerary(id));
  rmSync(dir, { recursive: true, force: true });

  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const { createDb } = await import("@/db/pool");
    const { runMigrations } = await import("@/db/migrate");
    const { pgBackendFor } = await import("@/data/backends/pg");
    const { observationsForFingerprints } = await import("@/db/observations");
    const admin = createDb(url, { max: 1 });
    await admin.query("DROP SCHEMA IF EXISTS perf CASCADE");
    await admin.query("CREATE SCHEMA perf");
    await admin.end();
    const db = createDb(url, { schema: "perf" });
    await runMigrations(db);
    const store = pgBackendFor(db);
    let pid = "";
    await timeAsync("PostgreSQL: save itinerary version", async () => {
      const s = await store.saveItinerary({ id: pid || undefined, name: "perf", tripId: null, note: "perf", input: demo, result });
      pid = s!.id;
    }, 20);
    await timeAsync("PostgreSQL: reopen itinerary with 20 versions", () => store.getItinerary(pid));
    // 500 observations of one configuration, then the monitoring history query.
    const base = { kind: "stay_quote" as const, label: "perf", resortId: "pop-century", roomTypeId: "standard", checkIn: "2027-02-01", nights: 4, adults: 2, children: 0, bookingMethod: "separate" as const, dining: "out_of_pocket" as const, taxIncluded: true };
    const quote: Omit<StayQuote, "id"> = { ...base, totalCents: 200_000, provenance: { status: "manual", source: "perf", observedAt: "2025-06-01" } };
    const e = await store.addPrice(quote);
    for (let i = 1; i < 500; i++) await store.recheckPrice(e.id, { observedAt: addDays("2025-06-01", i), value: 200_000 + (i % 37) * 100 });
    const fp = "pop-century|standard|2027-02-01|4n|2a0c|separate|no-tickets|out_of_pocket";
    await timeAsync("PostgreSQL: history query (500 observations)", () => observationsForFingerprints(db.query, [fp]));
    await timeAsync("PostgreSQL: list prices with history rebuilt", () => store.listPrices());
    await db.query("DROP SCHEMA perf CASCADE");
    await db.end();
  } else console.log("(Set DATABASE_URL to time PostgreSQL operations.)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

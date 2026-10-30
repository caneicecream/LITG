import { describe } from "vitest";
import { createDb, type Db } from "@/db/pool";
import { runMigrations } from "@/db/migrate";
import type { StayQuote } from "@/domain/types";

/**
 * PostgreSQL test harness. Set TEST_DATABASE_URL to run these suites (they are
 * skipped otherwise). Each test file works in its own schema, recreated on start.
 */
export const TEST_DB_URL = process.env.TEST_DATABASE_URL?.trim();
export const describeDb = TEST_DB_URL ? describe : describe.skip;

export async function freshSchema(name: string, opts: { migrate?: boolean } = {}): Promise<Db> {
  const admin = createDb(TEST_DB_URL!, { max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await admin.query(`CREATE SCHEMA ${name}`);
  await admin.end();
  const db = createDb(TEST_DB_URL!, { schema: name });
  if (opts.migrate !== false) await runMigrations(db);
  return db;
}

/** A fictional Pop Century package quote (valid against the real catalog). */
export const popQuote = (over: Partial<StayQuote> = {}): Omit<StayQuote, "id"> => ({
  kind: "stay_quote",
  label: "Pop Century package (TEST)",
  resortId: "pop-century",
  roomTypeId: "standard",
  checkIn: "2027-02-01",
  nights: 4,
  adults: 2,
  children: 0,
  bookingMethod: "package",
  ticket: { option: "base", days: 3 },
  dining: "out_of_pocket",
  totalCents: 250_000,
  taxIncluded: true,
  provenance: { status: "manual", source: "disneyworld.com quote (TEST)", observedAt: "2026-10-20" },
  ...over,
});


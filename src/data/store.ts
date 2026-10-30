import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DiningPlanPrice, Promotion, RoomRate, StayQuote, TicketPrice, TripRequest } from "@/domain/types";
import type { Cents } from "@/domain/money";

/**
 * Local persistence for personal data: user-entered prices/quotes and saved
 * trips. A single JSON file keeps Milestone 1 zero-setup. All access goes
 * through this module, so it can be swapped for Postgres/Supabase later
 * without touching the optimizer.
 */

export type PromotionEntry = Promotion & { kind: "promotion" };
export type UserPriceEntry = RoomRate | TicketPrice | DiningPlanPrice | StayQuote | PromotionEntry;

/** Compact snapshot of one optimization run, kept per saved trip (basis for future price monitoring). */
export interface RunSnapshot {
  runAt: string;
  demoMode: boolean;
  comparable: number;
  cheapest?: { evaluationId: string; totalCents: Cents; dataStatus: string };
  bestValue?: { evaluationId: string; totalCents: Cents; dataStatus: string };
  bestAlternative?: { evaluationId: string; totalCents: Cents; savingsCents: Cents };
  baselineTotalCents?: Cents;
}

export interface SavedTrip {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  request: TripRequest;
  runs: RunSnapshot[];
}

interface StoreFile {
  version: 1;
  prices: UserPriceEntry[];
  trips: SavedTrip[];
}

const MAX_RUNS_PER_TRIP = 50;

function storePath(): string {
  return process.env.DVO_STORE_PATH ?? path.join(process.cwd(), "data", "local-store.json");
}

async function read(): Promise<StoreFile> {
  try {
    const raw = await fs.readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    return { version: 1, prices: parsed.prices ?? [], trips: parsed.trips ?? [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, prices: [], trips: [] };
    throw err;
  }
}

async function write(data: StoreFile): Promise<void> {
  const file = storePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

// Serialize read-modify-write cycles within this process.
let queue: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (data: StoreFile) => T): Promise<T> {
  const next = queue.then(async () => {
    const data = await read();
    const result = fn(data);
    await write(data);
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

export async function listPrices(): Promise<UserPriceEntry[]> {
  return (await read()).prices;
}

export function addPrice(entry: Omit<UserPriceEntry, "id">): Promise<UserPriceEntry> {
  return mutate((d) => {
    const saved = { ...entry, id: `user-${randomUUID()}` } as UserPriceEntry;
    d.prices.push(saved);
    return saved;
  });
}

export function deletePrice(id: string): Promise<boolean> {
  return mutate((d) => {
    const before = d.prices.length;
    d.prices = d.prices.filter((p) => p.id !== id);
    return d.prices.length < before;
  });
}

export async function listTrips(): Promise<SavedTrip[]> {
  return (await read()).trips.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getTrip(id: string): Promise<SavedTrip | undefined> {
  return (await read()).trips.find((t) => t.id === id);
}

export function saveTrip(input: { id?: string; name: string; request: TripRequest; run?: RunSnapshot }): Promise<SavedTrip> {
  return mutate((d) => {
    const now = new Date().toISOString();
    let trip = input.id ? d.trips.find((t) => t.id === input.id) : undefined;
    if (!trip) {
      trip = { id: randomUUID(), name: input.name, createdAt: now, updatedAt: now, request: input.request, runs: [] };
      d.trips.push(trip);
    }
    trip.name = input.name;
    trip.request = input.request;
    trip.updatedAt = now;
    if (input.run) trip.runs = [input.run, ...trip.runs].slice(0, MAX_RUNS_PER_TRIP);
    return trip;
  });
}

export function deleteTrip(id: string): Promise<boolean> {
  return mutate((d) => {
    const before = d.trips.length;
    d.trips = d.trips.filter((t) => t.id !== id);
    return d.trips.length < before;
  });
}

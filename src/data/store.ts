import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  DiningPlanPrice,
  PointChartEntry,
  PointCost,
  Promotion,
  RoomRate,
  StayQuote,
  TicketPrice,
  TicketRule,
  TripRequest,
} from "@/domain/types";
import type { Cents } from "@/domain/money";
import type { Conversation } from "@/ai/types";
import { applyRecheck, type RecheckInput } from "./observations";

/**
 * Local persistence for personal data: user-entered prices/quotes and saved
 * trips. A single JSON file keeps Milestone 1 zero-setup. All access goes
 * through this module, so it can be swapped for Postgres/Supabase later
 * without touching the optimizer.
 */

export type PromotionEntry = Promotion & { kind: "promotion" };
export type UserPriceEntry =
  | RoomRate
  | TicketPrice
  | DiningPlanPrice
  | StayQuote
  | PromotionEntry
  | TicketRule
  | PointChartEntry
  | PointCost;

/** Compact snapshot of one optimization run, kept per saved trip (basis for future price monitoring). */
export interface RunSnapshot {
  runAt: string;
  demoMode: boolean;
  comparable: number;
  /** First ranked option (present even when there are too few options for awards). */
  top?: { evaluationId: string; totalCents: Cents; dataStatus: string };
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
  conversations: Conversation[];
}

const MAX_RUNS_PER_TRIP = 50;

function storePath(): string {
  // Runtime-only user data: excluded from build-time file tracing.
  return process.env.DVO_STORE_PATH ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "local-store.json");
}

async function read(): Promise<StoreFile> {
  try {
    const raw = await fs.readFile(/*turbopackIgnore: true*/ storePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    return { version: 1, prices: (parsed.prices ?? []).map(migrateEntry), trips: parsed.trips ?? [], conversations: parsed.conversations ?? [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, prices: [], trips: [], conversations: [] };
    throw err;
  }
}

/**
 * Upgrade entries saved by earlier versions. Milestone 1 stay quotes were
 * always tax-inclusive totals (the form said so), so `taxIncluded` defaults to true.
 */
export function migrateEntry(e: UserPriceEntry): UserPriceEntry {
  if (e.kind === "stay_quote" && (e as Partial<StayQuote>).taxIncluded === undefined) return { ...e, taxIncluded: true };
  return e;
}

async function write(data: StoreFile): Promise<void> {
  const file = storePath();
  await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(/*turbopackIgnore: true*/ tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(/*turbopackIgnore: true*/ tmp, file);
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

/** Add several entries at once (bulk entry). Callers validate all entries first, so this is all-or-nothing. */
export function addPrices(entries: Omit<UserPriceEntry, "id">[]): Promise<UserPriceEntry[]> {
  return mutate((d) => {
    const saved = entries.map((entry) => ({ ...entry, id: `user-${randomUUID()}` }) as UserPriceEntry);
    d.prices.push(...saved);
    return saved;
  });
}

/** Record a re-check of an entry, keeping the previous observation in its history. */
export function recheckPrice(id: string, input: RecheckInput): Promise<{ ok: true; entry: UserPriceEntry } | { ok: false; error: string }> {
  return mutate((d) => {
    const i = d.prices.findIndex((p) => p.id === id);
    if (i < 0) return { ok: false as const, error: "Not found" };
    const res = applyRecheck(d.prices[i]!, input, new Date().toISOString());
    if (res.ok) d.prices[i] = res.entry;
    return res;
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

// ─────────────────────────────── Planning conversations ───────────────────────────────

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export async function listConversations(): Promise<ConversationSummary[]> {
  return (await read()).conversations
    .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.messages.length }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  return (await read()).conversations.find((c) => c.id === id);
}

export function saveConversation(conv: Conversation): Promise<Conversation> {
  return mutate((d) => {
    const i = d.conversations.findIndex((c) => c.id === conv.id);
    if (i >= 0) d.conversations[i] = conv;
    else d.conversations.push(conv);
    return conv;
  });
}

export function deleteConversation(id: string): Promise<boolean> {
  return mutate((d) => {
    const before = d.conversations.length;
    d.conversations = d.conversations.filter((c) => c.id !== id);
    return d.conversations.length < before;
  });
}

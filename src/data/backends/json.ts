import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Conversation } from "@/ai/types";
import { applyRecheck, type RecheckInput } from "../observations";
import { MAX_RUNS_PER_TRIP, migrateEntry, type RunSnapshot, type SavedTrip, type StoreBackend, type StoreFile, type UserPriceEntry } from "../store";
import type { TripRequest } from "@/domain/types";

/** The original single-file JSON store (default when DATABASE_URL is not set). */

export function jsonStorePath(): string {
  // Runtime-only user data: excluded from build-time file tracing.
  return process.env.DVO_STORE_PATH ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "local-store.json");
}

export async function readStoreFile(file = jsonStorePath()): Promise<StoreFile> {
  try {
    const raw = await fs.readFile(/*turbopackIgnore: true*/ file, "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    return { version: 1, prices: (parsed.prices ?? []).map(migrateEntry), trips: parsed.trips ?? [], conversations: parsed.conversations ?? [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, prices: [], trips: [], conversations: [] };
    throw err;
  }
}

async function write(data: StoreFile): Promise<void> {
  const file = jsonStorePath();
  await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(/*turbopackIgnore: true*/ tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(/*turbopackIgnore: true*/ tmp, file);
}

// Serialize read-modify-write cycles within this process.
let queue: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (data: StoreFile) => T): Promise<T> {
  const next = queue.then(async () => {
    const data = await readStoreFile();
    const result = fn(data);
    await write(data);
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

const removeById = <T extends { id: string }>(list: T[], id: string) => {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
};

export const jsonBackend: StoreBackend = {
  kind: "json",
  listPrices: async () => (await readStoreFile()).prices,
  addPrice: (entry) =>
    mutate((d) => {
      const saved = { ...entry, id: `user-${randomUUID()}` } as UserPriceEntry;
      d.prices.push(saved);
      return saved;
    }),
  addPrices: (entries) =>
    mutate((d) => {
      const saved = entries.map((entry) => ({ ...entry, id: `user-${randomUUID()}` }) as UserPriceEntry);
      d.prices.push(...saved);
      return saved;
    }),
  recheckPrice: (id: string, input: RecheckInput) =>
    mutate((d) => {
      const i = d.prices.findIndex((p) => p.id === id);
      if (i < 0) return { ok: false as const, error: "Not found" };
      const res = applyRecheck(d.prices[i]!, input, new Date().toISOString());
      if (res.ok) d.prices[i] = res.entry;
      return res;
    }),
  deletePrice: (id) => mutate((d) => removeById(d.prices, id)),
  listTrips: async () => (await readStoreFile()).trips.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
  getTrip: async (id) => (await readStoreFile()).trips.find((t) => t.id === id),
  saveTrip: (input: { id?: string; name: string; request: TripRequest; run?: RunSnapshot }) =>
    mutate((d) => {
      const now = new Date().toISOString();
      let trip: SavedTrip | undefined = input.id ? d.trips.find((t) => t.id === input.id) : undefined;
      if (!trip) {
        trip = { id: randomUUID(), name: input.name, createdAt: now, updatedAt: now, request: input.request, runs: [] };
        d.trips.push(trip);
      }
      trip.name = input.name;
      trip.request = input.request;
      trip.updatedAt = now;
      if (input.run) trip.runs = [input.run, ...trip.runs].slice(0, MAX_RUNS_PER_TRIP);
      return trip;
    }),
  deleteTrip: (id) => mutate((d) => removeById(d.trips, id)),
  listConversations: async () =>
    (await readStoreFile()).conversations
      .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.messages.length }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
  getConversation: async (id) => (await readStoreFile()).conversations.find((c) => c.id === id),
  saveConversation: (conv: Conversation) =>
    mutate((d) => {
      const i = d.conversations.findIndex((c) => c.id === conv.id);
      if (i >= 0) d.conversations[i] = conv;
      else d.conversations.push(conv);
      return conv;
    }),
  deleteConversation: (id) => mutate((d) => removeById(d.conversations, id)),
};

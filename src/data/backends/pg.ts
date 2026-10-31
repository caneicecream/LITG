import { randomUUID } from "node:crypto";
import type { Conversation } from "@/ai/types";
import type { TripRequest } from "@/domain/types";
import type { Db } from "@/db/pool";
import { parseTripRequest } from "@/domain/schema";
import { ensureSchema } from "@/db/migrate";
import { historyFromObservations, insertObservation, observationsForEntries, type Query } from "@/db/observations";
import { contentHashOf, observationFromEntry } from "@/monitoring/observations";
import { applyRecheck, type RecheckInput } from "../observations";
import { MAX_RUNS_PER_TRIP, migrateEntry, type ItinerarySummary, type ItineraryVersion, type RecheckResult, type RunSnapshot, type SavedItinerary, type SavedTrip, type StoreBackend, type UserPriceEntry } from "../store";
import type { Itinerary } from "@/itinerary/types";

/**
 * PostgreSQL store. Entries hold their current state; every version of an entry
 * is an immutable row in `price_observations` (the entry's `history` is derived
 * from those rows). Deleting an entry hides it but keeps its observations.
 */

async function insertEntry(q: Query, entry: UserPriceEntry, now: string, origin: "entry" | "import" = "entry") {
  const { history: _h, ...data } = entry;
  await q("INSERT INTO price_entries (id, kind, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)", [entry.id, entry.kind, JSON.stringify(data), now]);
  await insertObservation(q, observationFromEntry(entry, origin, now));
}

async function tripRuns(q: Query | Db["query"], tripIds: string[]): Promise<Map<string, RunSnapshot[]>> {
  const rows = tripIds.length
    ? await q<{ trip_id: string; snapshot: RunSnapshot }>(
        `SELECT trip_id, snapshot FROM (
           SELECT trip_id, snapshot, row_number() OVER (PARTITION BY trip_id ORDER BY run_at DESC) AS n FROM trip_runs WHERE trip_id = ANY($1)
         ) r WHERE n <= $2 ORDER BY trip_id, n`,
        [tripIds, MAX_RUNS_PER_TRIP],
      )
    : [];
  const map = new Map<string, RunSnapshot[]>();
  for (const r of rows) map.set(r.trip_id, [...(map.get(r.trip_id) ?? []), r.snapshot]);
  return map;
}

/** jsonb doesn't keep key order; re-parse so a stored request reads back exactly like the one saved. */
function normalizeRequest(r: TripRequest): TripRequest {
  const parsed = parseTripRequest(r);
  return parsed.ok ? parsed.request : r;
}

interface TripRow {
  id: string;
  name: string;
  request: TripRequest;
  created_at: string;
  updated_at: string;
}

async function trips(db: Db, where = "", params: unknown[] = []): Promise<SavedTrip[]> {
  const rows = await db.query<TripRow>(`SELECT id, name, request, created_at, updated_at FROM trips ${where} ORDER BY updated_at DESC`, params);
  const runs = await tripRuns(db.query, rows.map((r) => r.id));
  return rows.map((r) => ({ id: r.id, name: r.name, request: normalizeRequest(r.request), createdAt: r.created_at, updatedAt: r.updated_at, runs: runs.get(r.id) ?? [] }));
}

/** `now` is injectable so tests can control recording times. */
export function pgBackendFor(db: Db, opts: { now?: () => Date } = {}): StoreBackend {
  const clock = opts.now ?? (() => new Date());
  const run = async <T>(fn: () => Promise<T>) => {
    await ensureSchema(db);
    return fn();
  };
  return {
    kind: "postgres",
    listPrices: () =>
      run(async () => {
        const rows = await db.query<{ id: string; data: UserPriceEntry }>("SELECT id, data FROM price_entries WHERE deleted_at IS NULL ORDER BY created_at, id");
        const obs = await observationsForEntries(db.query, rows.map((r) => r.id));
        const byEntry = new Map<string, typeof obs>();
        for (const o of obs) byEntry.set(o.entryId, [...(byEntry.get(o.entryId) ?? []), o]);
        return rows.map((r) => {
          const history = historyFromObservations(byEntry.get(r.id) ?? []);
          return migrateEntry({ ...r.data, ...(history.length ? { history } : {}) } as UserPriceEntry);
        });
      }),
    addPrice: (entry) =>
      run(() =>
        db.tx(async (q) => {
          const saved = { ...entry, id: `user-${randomUUID()}` } as UserPriceEntry;
          await insertEntry(q, saved, clock().toISOString());
          return saved;
        }),
      ),
    addPrices: (entries) =>
      run(() =>
        db.tx(async (q) => {
          const now = clock().toISOString();
          const saved = entries.map((entry) => ({ ...entry, id: `user-${randomUUID()}` }) as UserPriceEntry);
          for (const e of saved) await insertEntry(q, e, now);
          return saved;
        }),
      ),
    recheckPrice: (id: string, input: RecheckInput) =>
      run(() =>
        db.tx(async (q): Promise<RecheckResult> => {
          const rows = await q<{ data: UserPriceEntry }>("SELECT data FROM price_entries WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
          if (!rows[0]) return { ok: false, error: "Not found" };
          const current = migrateEntry(rows[0].data);
          const now = clock().toISOString();
          const res = applyRecheck(current, input, now);
          if (!res.ok) return res;
          const { history: _h, ...next } = res.entry;
          const { history: _c, ...cur } = current;
          if (contentHashOf(next) === contentHashOf(cur)) {
            return { ok: false, error: "Nothing new to record: this observation (same date, price, source and details) is already the latest one. Change the observation date if you re-checked it today." };
          }
          const inserted = await insertObservation(q, observationFromEntry(res.entry, "recheck", now));
          if (!inserted) return { ok: false, error: "This exact observation is already recorded for this entry." };
          await q("UPDATE price_entries SET data = $2, updated_at = $3 WHERE id = $1", [id, JSON.stringify(next), now]);
          const all = await observationsForEntries(q, [id]);
          const history = historyFromObservations(all);
          return { ok: true, entry: { ...next, ...(history.length ? { history } : {}) } as UserPriceEntry };
        }),
      ),
    deletePrice: (id) =>
      run(async () => (await db.query("UPDATE price_entries SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id", [id])).length > 0),
    listTrips: () => run(() => trips(db)),
    getTrip: (id) => run(async () => (await trips(db, "WHERE id = $1", [id]))[0]),
    saveTrip: (input: { id?: string; name: string; request: TripRequest; run?: RunSnapshot }) =>
      run(async () => {
        const now = clock().toISOString();
        const id = await db.tx(async (q) => {
          const existing = input.id ? await q<{ id: string }>("SELECT id FROM trips WHERE id = $1 FOR UPDATE", [input.id]) : [];
          const tripId = existing[0]?.id ?? randomUUID();
          if (existing[0]) {
            await q("UPDATE trips SET name = $2, request = $3, updated_at = $4 WHERE id = $1", [tripId, input.name, JSON.stringify(input.request), now]);
          } else {
            await q("INSERT INTO trips (id, name, request, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)", [tripId, input.name, JSON.stringify(input.request), now]);
          }
          if (input.run) {
            await q("INSERT INTO trip_runs (trip_id, run_at, snapshot) VALUES ($1, $2, $3) ON CONFLICT (trip_id, run_at) DO NOTHING", [tripId, input.run.runAt, JSON.stringify(input.run)]);
          }
          return tripId;
        });
        return (await trips(db, "WHERE id = $1", [id]))[0]!;
      }),
    deleteTrip: (id) => run(async () => (await db.query("DELETE FROM trips WHERE id = $1 RETURNING id", [id])).length > 0),
    listConversations: () =>
      run(async () => {
        const rows = await db.query<{ id: string; title: string; created_at: string; updated_at: string; n: number }>(
          "SELECT id, title, created_at, updated_at, jsonb_array_length(data->'messages') AS n FROM conversations ORDER BY updated_at DESC",
        );
        return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, messageCount: r.n }));
      }),
    getConversation: (id) => run(async () => (await db.query<{ data: Conversation }>("SELECT data FROM conversations WHERE id = $1", [id]))[0]?.data),
    saveConversation: (conv: Conversation) =>
      run(async () => {
        await db.query(
          `INSERT INTO conversations (id, title, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
          [conv.id, conv.title, JSON.stringify(conv), conv.createdAt, conv.updatedAt],
        );
        return conv;
      }),
    deleteConversation: (id) => run(async () => (await db.query("DELETE FROM conversations WHERE id = $1 RETURNING id", [id])).length > 0),
    listItineraries: () =>
      run(async () => {
        const rows = await db.query<{ id: string; name: string; trip_id: string | null; created_at: string; updated_at: string; n: number; version: number | null; result: Itinerary | null; engine_version: string | null }>(
          `SELECT i.id, i.name, i.trip_id, i.created_at, i.updated_at,
                  (SELECT count(*)::int FROM itinerary_versions v WHERE v.itinerary_id = i.id) AS n,
                  l.version, l.result, l.engine_version
             FROM itineraries i
             LEFT JOIN LATERAL (SELECT version, result, engine_version FROM itinerary_versions v WHERE v.itinerary_id = i.id ORDER BY version DESC LIMIT 1) l ON true
            ORDER BY i.updated_at DESC`,
        );
        return rows.map(
          (r): ItinerarySummary => ({
            id: r.id,
            name: r.name,
            tripId: r.trip_id,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            versionCount: r.n,
            latest: r.result ? { version: r.version!, headline: r.result.headline, status: r.result.status, demo: r.result.demo, engineVersion: r.engine_version! } : null,
          }),
        );
      }),
    getItinerary: (id) => run(() => loadItinerary(db.query, id)),
    saveItinerary: (input) =>
      run(() =>
        db.tx(async (q) => {
          const now = clock().toISOString();
          let id = input.id;
          if (id) {
            const exists = await q("SELECT 1 FROM itineraries WHERE id = $1 FOR UPDATE", [id]);
            if (!exists.length) return undefined;
            await q("UPDATE itineraries SET name = $2, updated_at = $3 WHERE id = $1", [id, input.name, now]);
          } else {
            id = `itin-${randomUUID()}`;
            const trip = input.tripId ? await q("SELECT 1 FROM trips WHERE id = $1", [input.tripId]) : [];
            await q("INSERT INTO itineraries (id, name, trip_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)", [id, input.name, trip.length ? input.tripId : null, now]);
          }
          const next = (await q<{ next: number }>("SELECT coalesce(max(version), 0) + 1 AS next FROM itinerary_versions WHERE itinerary_id = $1", [id]))[0]!.next;
          await q("INSERT INTO itinerary_versions (itinerary_id, version, created_at, note, engine_version, input, result) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
            id, next, now, input.note, input.result.engineVersion, JSON.stringify(input.input), JSON.stringify(input.result),
          ]);
          return loadItinerary(q, id);
        }),
      ),
    deleteItinerary: (id) => run(async () => (await db.query("DELETE FROM itineraries WHERE id = $1 RETURNING id", [id])).length > 0),
  };
}

async function loadItinerary(q: Query | Db["query"], id: string): Promise<SavedItinerary | undefined> {
  const [it] = await q<{ id: string; name: string; trip_id: string | null; created_at: string; updated_at: string }>("SELECT * FROM itineraries WHERE id = $1", [id]);
  if (!it) return undefined;
  const versions = await q<{ version: number; created_at: string; note: string; engine_version: string; input: ItineraryVersion["input"]; result: Itinerary }>(
    "SELECT version, created_at, note, engine_version, input, result FROM itinerary_versions WHERE itinerary_id = $1 ORDER BY version",
    [id],
  );
  return {
    id: it.id,
    name: it.name,
    tripId: it.trip_id,
    createdAt: it.created_at,
    updatedAt: it.updated_at,
    versions: versions.map((v) => ({ version: v.version, createdAt: v.created_at, note: v.note, engineVersion: v.engine_version, input: v.input, result: v.result })),
  };
}

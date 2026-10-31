import { redact } from "@/lib/errors";
import { createHash, randomUUID } from "node:crypto";
import { CATALOG } from "@/data/catalog";
import { priceEntrySchema } from "@/data/entrySchema";
import { ILLUSTRATIVE_DATA } from "@/data/illustrative";
import { TAX_RATES, TRANSPORT } from "@/data/reference";
import { mergePriceData, splitEntries } from "@/data/sources";
import type { SavedTrip, UserPriceEntry } from "@/data/store";
import { pgBackendFor } from "@/data/backends/pg";
import { insertObservation, observationsForFingerprints } from "@/db/observations";
import type { Db } from "@/db/pool";
import { todayIso } from "@/domain/dates";
import { baselineConfiguration, optimize } from "@/domain/optimizer/optimize";
import { ENGINE_VERSION } from "@/domain/optimizer/version";
import type { PriceData, StayQuote } from "@/domain/types";
import { ADAPTERS, type ObservationAdapter } from "./adapters";
import { buildSnapshot, detectEvents, nextCheckAt } from "./detect";
import { configKey, fingerprint, quoteKey, seriesKey, taxTreatment, type ConfigKey } from "./fingerprint";
import { alreadyNotified, createNotification, getNotificationSettings, type EmailSender, type NotificationRow } from "./notify";
import { contentHashOf, observationFromEntry, type ObservationRecord } from "./observations";
import { buildSeries, seriesSeparationNotes, type PriceSeries } from "./series";
import { monitorSettingsSchema, type CheckSnapshot, type MonitorEvent, type MonitorSettings } from "./types";

/**
 * Saved-vacation monitoring (PostgreSQL only). A monitor is attached to a saved
 * trip and is opt-in. A check re-evaluates the trip with the prices stored at
 * that moment, records what it saw (append-only), detects meaningful changes
 * against the previous check, and notifies once per new situation. Checks never
 * create price observations themselves: only your entries/re-checks and
 * authorized adapters do. Nothing is ever booked, changed or cancelled.
 */

export interface MonitorRecord {
  id: string;
  tripId: string;
  tripName: string;
  enabled: boolean;
  settings: MonitorSettings;
  createdAt: string;
  updatedAt: string;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
}

export interface CheckRecord {
  id: string;
  monitorId: string;
  checkedAt: string;
  trigger: "scheduled" | "manual";
  snapshot: CheckSnapshot;
  events: MonitorEvent[];
}

interface MonitorRow {
  id: string;
  trip_id: string;
  trip_name: string;
  enabled: boolean;
  settings: unknown;
  created_at: string;
  updated_at: string;
  last_check_at: string | null;
  next_check_at: string | null;
}

const parseSettings = (v: unknown): MonitorSettings => {
  const r = monitorSettingsSchema.safeParse(v ?? {});
  return r.success ? r.data : monitorSettingsSchema.parse({});
};

const fromRow = (r: MonitorRow): MonitorRecord => ({
  id: r.id,
  tripId: r.trip_id,
  tripName: r.trip_name,
  enabled: r.enabled,
  settings: parseSettings(r.settings),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastCheckAt: r.last_check_at,
  nextCheckAt: r.next_check_at,
});

const SELECT = "SELECT m.*, t.name AS trip_name FROM monitors m JOIN trips t ON t.id = m.trip_id";

export async function listMonitors(db: Db): Promise<MonitorRecord[]> {
  return (await db.query<MonitorRow>(`${SELECT} ORDER BY m.created_at`)).map(fromRow);
}

export async function getMonitor(db: Db, id: string): Promise<MonitorRecord | null> {
  const r = (await db.query<MonitorRow>(`${SELECT} WHERE m.id = $1`, [id]))[0];
  return r ? fromRow(r) : null;
}

/** Start monitoring a saved trip (idempotent: returns the existing monitor). */
export async function createMonitor(db: Db, tripId: string, settings: Partial<MonitorSettings> = {}, now = new Date()): Promise<MonitorRecord | null> {
  const trip = await db.query("SELECT 1 FROM trips WHERE id = $1", [tripId]);
  if (!trip.length) return null;
  const s = monitorSettingsSchema.parse(settings);
  const id = `mon-${randomUUID()}`;
  await db.query(
    `INSERT INTO monitors (id, trip_id, enabled, settings, created_at, updated_at, next_check_at) VALUES ($1, $2, true, $3, $4, $4, $5)
     ON CONFLICT (trip_id) DO NOTHING`,
    [id, tripId, JSON.stringify(s), now.toISOString(), s.frequency === "manual" ? null : now.toISOString()],
  );
  return fromRow((await db.query<MonitorRow>(`${SELECT} WHERE m.trip_id = $1`, [tripId]))[0]!);
}

export async function updateMonitor(db: Db, id: string, patch: { enabled?: boolean; settings?: Partial<MonitorSettings> }, now = new Date()): Promise<MonitorRecord | null> {
  const current = await getMonitor(db, id);
  if (!current) return null;
  const settings = monitorSettingsSchema.parse({ ...current.settings, ...patch.settings, notifyOn: { ...current.settings.notifyOn, ...patch.settings?.notifyOn } });
  const enabled = patch.enabled ?? current.enabled;
  // Re-schedule from the last check (or now) when frequency or enabled state changes.
  const base = current.lastCheckAt ? new Date(current.lastCheckAt) : now;
  const next = enabled ? (current.lastCheckAt ? nextCheckAt(settings.frequency, base) : settings.frequency === "manual" ? null : now.toISOString()) : null;
  await db.query("UPDATE monitors SET enabled = $2, settings = $3, updated_at = $4, next_check_at = $5 WHERE id = $1", [id, enabled, JSON.stringify(settings), now.toISOString(), next]);
  return getMonitor(db, id);
}

/** Stop monitoring. Checks go with the monitor; price observations and notifications are kept. */
export async function deleteMonitor(db: Db, id: string): Promise<boolean> {
  return (await db.query("DELETE FROM monitors WHERE id = $1 RETURNING id", [id])).length > 0;
}

export async function listChecks(db: Db, monitorId: string, limit = 30): Promise<CheckRecord[]> {
  const rows = await db.query<{ id: string; monitor_id: string; checked_at: string; trigger: CheckRecord["trigger"]; data: CheckSnapshot; events: MonitorEvent[] }>(
    "SELECT * FROM monitor_checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT $2",
    [monitorId, limit],
  );
  return rows.map((r) => ({ id: r.id, monitorId: r.monitor_id, checkedAt: r.checked_at, trigger: r.trigger, snapshot: r.data, events: r.events }));
}

// ───────────────────────────── Hashes (what changed between checks) ─────────────────────────────

const stripHistory = (data: PriceData) =>
  Object.fromEntries(Object.entries(data).map(([k, list]) => [k, (list as { history?: unknown }[]).map(({ history: _h, ...rest }) => rest)]));

let catalogHashMemo: string | null = null;
export function catalogHash(): string {
  return (catalogHashMemo ??= contentHashOf({ catalog: CATALOG, taxRates: TAX_RATES, transport: TRANSPORT }));
}

export function dataHash(data: PriceData): string {
  return contentHashOf(stripHistory(data));
}

// ───────────────────────────── Adapters ─────────────────────────────

const adapterEntryId = (adapterId: string, q: StayQuote) =>
  `adapter-${adapterId}-${createHash("sha256").update(seriesKey(fingerprint(quoteKey(q)), taxTreatment(q))).digest("hex").slice(0, 16)}`;

/**
 * Ask authorized adapters for the tracked configuration. Every returned quote is
 * validated like a user's quote and must match the configuration exactly. A
 * quote identical to the stored one creates no observation.
 */
async function consultAdapters(db: Db, adapters: ObservationAdapter[], key: ConfigKey, nowIso: string): Promise<CheckSnapshot["adapters"]> {
  const out: CheckSnapshot["adapters"] = [];
  const fp = fingerprint(key);
  for (const a of adapters) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const raw = await a.fetchQuotes(key, ctrl.signal);
      let recorded = 0;
      let rejected = 0;
      let unchanged = 0;
      for (const item of Array.isArray(raw) ? raw.slice(0, 20) : []) {
        const obj = item as { provenance?: Record<string, unknown> };
        // Validate with the user-entry rules (status checked as "manual"), then mark verified.
        const parsed = priceEntrySchema.safeParse({ ...obj, kind: "stay_quote", provenance: { ...(obj?.provenance ?? {}), status: "manual" } });
        if (!parsed.success || parsed.data.kind !== "stay_quote") {
          rejected++;
          continue;
        }
        const id = adapterEntryId(a.id, { ...parsed.data, id: "" } as StayQuote);
        const q = { ...parsed.data, id, provenance: { ...parsed.data.provenance, status: "verified" as const, notes: `${a.name}. ${a.limitations}` } } as StayQuote;
        if (fingerprint(quoteKey(q)) !== fp) {
          rejected++;
          continue;
        }
        const res = await db.tx(async (tq) => {
          const existing = await tq<{ data: UserPriceEntry }>("SELECT data FROM price_entries WHERE id = $1 FOR UPDATE", [id]);
          const { history: _h, ...data } = q;
          if (existing[0] && contentHashOf(existing[0].data) === contentHashOf(data)) return "unchanged";
          if (existing[0]) await tq("UPDATE price_entries SET data = $2, updated_at = $3, deleted_at = NULL WHERE id = $1", [id, JSON.stringify(data), nowIso]);
          else await tq("INSERT INTO price_entries (id, kind, data, created_at, updated_at) VALUES ($1, 'stay_quote', $2, $3, $3)", [id, JSON.stringify(data), nowIso]);
          return (await insertObservation(tq, observationFromEntry(q, "adapter", nowIso, { assumptions: [a.limitations] }))) ? "recorded" : "unchanged";
        });
        if (res === "recorded") recorded++;
        else unchanged++;
      }
      out.push({ id: a.id, name: a.name, outcome: `${recorded} new observation(s), ${unchanged} unchanged, ${rejected} rejected by validation` });
    } catch (err) {
      out.push({ id: a.id, name: a.name, outcome: `failed: ${redact(err instanceof Error ? err.message : "unknown error").slice(0, 200)}` });
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

// ───────────────────────────── Checks ─────────────────────────────

export interface CheckOptions {
  trigger: "scheduled" | "manual";
  now?: Date;
  adapters?: ObservationAdapter[];
  /** Email sender (defaults to SMTP when configured); null disables email. */
  email?: EmailSender | null;
}

export interface CheckOutcome {
  check: CheckRecord;
  notification: NotificationRow | null;
}

export async function runMonitorCheck(db: Db, monitorId: string, opts: CheckOptions): Promise<CheckOutcome | null> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const monitor = await getMonitor(db, monitorId);
  if (!monitor) return null;
  const store = pgBackendFor(db);
  const trip: SavedTrip | undefined = await store.getTrip(monitor.tripId);
  if (!trip) return null;
  const s = monitor.settings;

  const base = baselineConfiguration(trip.request);
  const trackedKey = "config" in base ? configKey(base.config, trip.request) : null;
  const adapters = trackedKey ? await consultAdapters(db, opts.adapters ?? ADAPTERS, trackedKey, nowIso) : [];

  const entries = await store.listPrices();
  const data = mergePriceData([
    { taxRates: TAX_RATES, transport: TRANSPORT },
    splitEntries(entries),
    ...(trip.request.data.includeIllustrative ? [ILLUSTRATIVE_DATA] : []),
  ]);
  const request = { ...trip.request, data: { ...trip.request.data, staleAfterDays: s.staleAfterDays } };
  const result = optimize({ catalog: CATALOG, data, request, now });

  const prev = (await listChecks(db, monitorId, 1))[0] ?? null;
  const fp = trackedKey ? fingerprint(trackedKey) : null;
  const sinceObs = prev && fp ? (await observationsForFingerprints(db.query, [fp])).filter((o) => o.recordedAt > prev.checkedAt && o.recordedAt <= nowIso) : [];

  const snapshot = buildSnapshot({
    result,
    request: trip.request,
    quotes: data.stayQuotes,
    checkedAt: nowIso,
    requestHash: contentHashOf(trip.request),
    dataHash: dataHash(data),
    engineVersion: ENGINE_VERSION,
    catalogHash: catalogHash(),
    settings: s,
    newObservations: sinceObs.map((o) => ({
      id: o.id,
      entryId: o.entryId,
      observedOn: o.observedOn,
      recordedAt: o.recordedAt,
      valueCents: o.comparableTotalCents,
      source: o.source,
      status: o.status,
      taxTreatment: o.seriesKey?.endsWith("#pre_tax") ? "pre_tax" : o.seriesKey ? "all_in" : null,
    })),
    adapters,
  });
  const events = detectEvents(prev?.snapshot ?? null, snapshot, { monitorId, settings: s });
  const check: CheckRecord = { id: `chk-${randomUUID()}`, monitorId, checkedAt: nowIso, trigger: opts.trigger, snapshot, events };

  await db.tx(async (q) => {
    await q("INSERT INTO monitor_checks (id, monitor_id, checked_at, trigger, data, events) VALUES ($1, $2, $3, $4, $5, $6)", [
      check.id, monitorId, nowIso, opts.trigger, JSON.stringify(snapshot), JSON.stringify(events),
    ]);
    await q("UPDATE monitors SET last_check_at = $2, next_check_at = $3 WHERE id = $1", [monitorId, nowIso, monitor.enabled ? nextCheckAt(s.frequency, now) : null]);
  });

  // Notify once per new situation, as one digest per check.
  const candidates = events.filter((e) => e.notify);
  const seen = await alreadyNotified(db, candidates.map((e) => e.dedupeKey));
  const fresh = candidates.filter((e) => !seen.has(e.dedupeKey));
  let notification: NotificationRow | null = null;
  if (fresh.length) {
    const ns = await getNotificationSettings(db);
    const sender = opts.email === undefined ? (await import("./notify")).smtpSender() : opts.email;
    const email = s.email && ns.emailEnabled && ns.emailTo && sender ? { sender, to: ns.emailTo } : null;
    notification = await createNotification(
      db,
      { id: `ntf-${randomUUID()}`, monitorId, tripId: trip.id, checkId: check.id, createdAt: nowIso, tripName: trip.name, events: fresh },
      email,
    );
  }
  return { check, notification };
}

/**
 * Run every enabled monitor that is due. Each monitor is claimed with a short
 * lease (FOR UPDATE SKIP LOCKED), so overlapping schedulers never run the same
 * check twice. One failing monitor doesn't stop the others.
 */
export async function runDueMonitors(db: Db, opts: Omit<CheckOptions, "trigger"> = {}): Promise<{ monitorId: string; ok: boolean; events?: number; error?: string }[]> {
  const now = opts.now ?? new Date();
  const lease = new Date(now.getTime() + 10 * 60_000).toISOString();
  const claimed = await db.query<{ id: string }>(
    `UPDATE monitors SET next_check_at = $2 WHERE id IN (
       SELECT id FROM monitors WHERE enabled AND next_check_at IS NOT NULL AND next_check_at <= $1
       ORDER BY next_check_at FOR UPDATE SKIP LOCKED LIMIT 50
     ) RETURNING id`,
    [now.toISOString(), lease],
  );
  const results = [];
  for (const { id } of claimed) {
    try {
      const r = await runMonitorCheck(db, id, { ...opts, trigger: "scheduled", now });
      results.push({ monitorId: id, ok: !!r, events: r?.check.events.length ?? 0 });
    } catch (err) {
      results.push({ monitorId: id, ok: false, error: redact(err instanceof Error ? err.message : String(err)) });
    }
  }
  return results;
}

// ───────────────────────────── History for display and the assistant ─────────────────────────────

export interface MonitorHistory {
  /** Equivalent-configuration series of the tracked plan (quotes only). */
  series: PriceSeries[];
  separationNotes: string[];
  /** Totals of the tracked plan at each check: re-evaluations with stored prices, not live checks. */
  evaluations: { checkedAt: string; totalCents: number; complete: boolean; dataStatus: string; requestHash: string; fingerprint: string }[];
  observations: ObservationRecord[];
  trackedFingerprint: string | null;
}

export async function monitorHistory(db: Db, monitor: MonitorRecord, trip: SavedTrip, now = new Date()): Promise<MonitorHistory> {
  const base = baselineConfiguration(trip.request);
  const fp = "config" in base ? fingerprint(configKey(base.config, trip.request)) : null;
  const observations = fp ? await observationsForFingerprints(db.query, [fp]) : [];
  const series = buildSeries(observations, todayIso(now), monitor.settings.staleAfterDays);
  const checks = await listChecks(db, monitor.id, 200);
  return {
    series,
    separationNotes: seriesSeparationNotes(series),
    evaluations: checks
      .filter((c) => c.snapshot.tracked)
      .map((c) => ({
        checkedAt: c.checkedAt,
        totalCents: c.snapshot.tracked!.totalCents,
        complete: c.snapshot.tracked!.complete,
        dataStatus: c.snapshot.tracked!.dataStatus,
        requestHash: c.snapshot.requestHash,
        fingerprint: c.snapshot.tracked!.fingerprint,
      }))
      .reverse(),
    observations,
    trackedFingerprint: fp,
  };
}

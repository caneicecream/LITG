import type { StoreFile, UserPriceEntry } from "@/data/store";
import { priceEntrySchema } from "@/data/entrySchema";
import { withValue } from "@/data/observations";
import { isIsoDate } from "@/domain/dates";
import { insertObservation } from "./observations";
import { observationFromEntry, type ObservationRecord } from "@/monitoring/observations";
import type { Db } from "./pool";

/**
 * One-way import of the JSON store into PostgreSQL. Safe to re-run:
 *  - the JSON file is only read, never modified or deleted;
 *  - rows that already exist (same id) are left untouched, and differences are reported;
 *  - everything happens in one transaction, so a failure imports nothing;
 *  - entries that fail today's validation are still imported verbatim (they were
 *    already in use), and listed as warnings so nothing is dropped silently.
 */

export interface ImportReport {
  dryRun: boolean;
  prices: { imported: number; alreadyPresent: number; differing: string[] };
  observations: { imported: number; identicalRepeatsMerged: number };
  trips: { imported: number; alreadyPresent: number; runsImported: number };
  conversations: { imported: number; alreadyPresent: number; differing: string[] };
  warnings: string[];
}

const KINDS = new Set(["room_rate", "ticket_price", "dining_plan_price", "stay_quote", "promotion", "ticket_rule", "point_chart", "point_cost"]);

/** Structural problems that make an entry impossible to store (these abort the import). */
export function structuralErrors(file: StoreFile): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  file.prices.forEach((e, i) => {
    const at = `prices[${i}]`;
    if (typeof e?.id !== "string" || !e.id) return errors.push(`${at}: missing id`);
    if (seen.has(e.id)) errors.push(`${at}: duplicate id ${e.id}`);
    seen.add(e.id);
    if (!KINDS.has(e.kind)) errors.push(`${at} (${e.id}): unknown kind ${String(e.kind)}`);
    if (!e.provenance || !isIsoDate(e.provenance.observedAt) || typeof e.provenance.source !== "string") {
      errors.push(`${at} (${e.id}): provenance needs a source and an observedAt date`);
    }
    for (const [j, h] of (e.history ?? []).entries()) {
      if (!isIsoDate(h.observedAt) || typeof h.supersededAt !== "string" || Number.isNaN(Date.parse(h.supersededAt))) {
        errors.push(`${at} (${e.id}): history[${j}] needs observedAt and supersededAt`);
      }
    }
  });
  file.trips.forEach((t, i) => {
    if (typeof t?.id !== "string" || !t.request || typeof t.name !== "string") errors.push(`trips[${i}]: needs id, name and request`);
  });
  file.conversations.forEach((c, i) => {
    if (typeof c?.id !== "string" || !Array.isArray(c.messages)) errors.push(`conversations[${i}]: needs id and messages`);
  });
  return errors;
}

const RECONSTRUCTED =
  "Imported from the JSON store's history, which kept only the price, date, status and source of earlier observations; other details are assumed unchanged from the next observation.";

/**
 * Observations for one JSON entry: one per history item (oldest first), then
 * the current state. Recorded times are reconstructed from `supersededAt`.
 */
export function observationsForImport(entry: UserPriceEntry, importedAt: string): ObservationRecord[] {
  const history = entry.history ?? [];
  const { history: _h, ...current } = entry;
  const out: ObservationRecord[] = [];
  history.forEach((h, i) => {
    const provenance = { status: h.status, source: h.source, observedAt: h.observedAt, ...(h.sourceUrl ? { sourceUrl: h.sourceUrl } : {}), ...(h.notes ? { notes: h.notes } : {}) };
    let snap = { ...current, provenance } as UserPriceEntry;
    if (h.value !== null) snap = withValue(snap, h.value);
    const observedNoon = `${h.observedAt}T12:00:00.000Z`;
    const recordedAt = i > 0 ? history[i - 1]!.supersededAt : observedNoon < h.supersededAt ? observedNoon : h.supersededAt;
    out.push(observationFromEntry(snap, "import", new Date(recordedAt).toISOString(), { assumptions: [RECONSTRUCTED] }));
  });
  const recordedAt = history.length ? new Date(history[history.length - 1]!.supersededAt).toISOString() : importedAt;
  out.push(observationFromEntry(current as UserPriceEntry, "import", recordedAt, { assumptions: ["Imported from the JSON store."] }));
  return out;
}

class DryRunRollback extends Error {}

export async function importJsonStore(db: Db, file: StoreFile, opts: { dryRun?: boolean; now?: string } = {}): Promise<ImportReport> {
  const errors = structuralErrors(file);
  if (errors.length) throw new Error(`The JSON store has problems that prevent import (nothing was imported):\n- ${errors.join("\n- ")}`);
  const now = opts.now ?? new Date().toISOString();
  const report: ImportReport = {
    dryRun: !!opts.dryRun,
    prices: { imported: 0, alreadyPresent: 0, differing: [] },
    observations: { imported: 0, identicalRepeatsMerged: 0 },
    trips: { imported: 0, alreadyPresent: 0, runsImported: 0 },
    conversations: { imported: 0, alreadyPresent: 0, differing: [] },
    warnings: [],
  };
  for (const e of file.prices) {
    const { id: _id, history: _h, ...rest } = e;
    const res = priceEntrySchema.safeParse(rest);
    if (!res.success) report.warnings.push(`Entry ${e.id} doesn't pass current validation (${res.error.issues.map((i) => i.message).join("; ")}); imported as stored.`);
  }

  try {
    await db.tx(async (q) => {
      for (const e of file.prices) {
        const { history: _h, ...data } = e;
        const existing = await q<{ data: object }>("SELECT data FROM price_entries WHERE id = $1", [e.id]);
        if (existing[0]) {
          report.prices.alreadyPresent++;
          if (JSON.stringify(sortKeys(existing[0].data)) !== JSON.stringify(sortKeys(data))) report.prices.differing.push(e.id);
          continue;
        }
        const obs = observationsForImport(e, now);
        await q("INSERT INTO price_entries (id, kind, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)", [
          e.id, e.kind, JSON.stringify(data), obs[0]!.recordedAt, obs[obs.length - 1]!.recordedAt,
        ]);
        report.prices.imported++;
        for (const o of obs) {
          if (await insertObservation(q, o)) report.observations.imported++;
          else report.observations.identicalRepeatsMerged++;
        }
      }
      for (const t of file.trips) {
        const existing = await q("SELECT 1 FROM trips WHERE id = $1", [t.id]);
        if (existing.length) report.trips.alreadyPresent++;
        else {
          await q("INSERT INTO trips (id, name, request, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)", [t.id, t.name, JSON.stringify(t.request), t.createdAt, t.updatedAt]);
          report.trips.imported++;
        }
        // Runs are merged either way: a run is identified by its time, so re-importing adds nothing twice.
        for (const r of t.runs ?? []) {
          const ins = await q("INSERT INTO trip_runs (trip_id, run_at, snapshot) VALUES ($1, $2, $3) ON CONFLICT (trip_id, run_at) DO NOTHING RETURNING id", [t.id, r.runAt, JSON.stringify(r)]);
          report.trips.runsImported += ins.length;
        }
      }
      for (const c of file.conversations) {
        const existing = await q<{ data: object }>("SELECT data FROM conversations WHERE id = $1", [c.id]);
        if (existing[0]) {
          report.conversations.alreadyPresent++;
          if (JSON.stringify(sortKeys(existing[0].data)) !== JSON.stringify(sortKeys(c))) report.conversations.differing.push(c.id);
          continue;
        }
        await q("INSERT INTO conversations (id, title, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)", [c.id, c.title, JSON.stringify(c), c.createdAt, c.updatedAt]);
        report.conversations.imported++;
      }
      if (opts.dryRun) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  if (report.prices.differing.length) report.warnings.push(`${report.prices.differing.length} price entr${report.prices.differing.length === 1 ? "y differs" : "ies differ"} from the database copy and were left unchanged: ${report.prices.differing.join(", ")}.`);
  if (report.conversations.differing.length) report.warnings.push(`${report.conversations.differing.length} conversation(s) differ from the database copy and were left unchanged.`);
  return report;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

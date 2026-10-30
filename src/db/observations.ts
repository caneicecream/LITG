import type { QueryResultRow } from "pg";
import type { PriceObservation } from "@/domain/types";
import type { ObservationRecord } from "@/monitoring/observations";
import type { Db } from "./pool";

/** Data access for the append-only `price_observations` table. */

export type Query = <R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => Promise<R[]>;

const COLUMNS = `id, entry_id, kind, content_hash, observed_on, recorded_at, origin, status, source, source_url, notes,
  value, value_unit, fingerprint, series_key, comparable_total_cents, resort_id, room_type_id, check_in, check_out,
  adults, children, booking_method, ticket_option, ticket_days, dining, tax_included, tax_cents, terms, assumptions, snapshot`;

/** Insert one observation. Returns false (and inserts nothing) if the entry already has identical content. */
export async function insertObservation(q: Query, o: ObservationRecord): Promise<boolean> {
  const c = o.config;
  const rows = await q(
    `INSERT INTO price_observations (${COLUMNS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
     ON CONFLICT (entry_id, content_hash) DO NOTHING
     RETURNING id`,
    [
      o.id, o.entryId, o.kind, o.contentHash, o.observedOn, o.recordedAt, o.origin, o.status, o.source, o.sourceUrl, o.notes,
      o.value, o.valueUnit, o.fingerprint, o.seriesKey, o.comparableTotalCents,
      c?.resortId ?? null, c?.roomTypeId ?? null, c?.checkIn ?? null, c?.checkOut ?? null, c?.adults ?? null, c?.children ?? null,
      c?.bookingMethod ?? null, c?.ticketOption ?? null, c?.ticketDays ?? null, c?.dining ?? null,
      o.taxIncluded, o.taxCents, o.terms === null ? null : JSON.stringify(o.terms), JSON.stringify(o.assumptions), JSON.stringify(o.snapshot),
    ],
  );
  return rows.length > 0;
}

interface Row {
  id: string;
  entry_id: string;
  kind: ObservationRecord["kind"];
  content_hash: string;
  observed_on: string;
  recorded_at: string;
  origin: ObservationRecord["origin"];
  status: ObservationRecord["status"];
  source: string;
  source_url: string | null;
  notes: string | null;
  value: number | null;
  value_unit: ObservationRecord["valueUnit"];
  fingerprint: string | null;
  series_key: string | null;
  comparable_total_cents: number | null;
  resort_id: string | null;
  room_type_id: string | null;
  check_in: string | null;
  check_out: string | null;
  adults: number | null;
  children: number | null;
  booking_method: string | null;
  ticket_option: string | null;
  ticket_days: number | null;
  dining: string | null;
  tax_included: boolean | null;
  tax_cents: number | null;
  terms: ObservationRecord["terms"];
  assumptions: string[];
  snapshot: ObservationRecord["snapshot"];
}

function fromRow(r: Row): ObservationRecord {
  return {
    id: r.id,
    entryId: r.entry_id,
    kind: r.kind,
    contentHash: r.content_hash,
    observedOn: r.observed_on,
    recordedAt: r.recorded_at,
    origin: r.origin,
    status: r.status,
    source: r.source,
    sourceUrl: r.source_url,
    notes: r.notes,
    value: r.value,
    valueUnit: r.value_unit,
    fingerprint: r.fingerprint,
    seriesKey: r.series_key,
    comparableTotalCents: r.comparable_total_cents,
    config:
      r.resort_id === null
        ? null
        : {
            resortId: r.resort_id,
            roomTypeId: r.room_type_id!,
            checkIn: r.check_in!,
            checkOut: r.check_out!,
            adults: r.adults!,
            children: r.children!,
            bookingMethod: r.booking_method!,
            ticketOption: r.ticket_option,
            ticketDays: r.ticket_days,
            dining: r.dining!,
          },
    taxIncluded: r.tax_included,
    taxCents: r.tax_cents,
    terms: r.terms,
    assumptions: r.assumptions,
    snapshot: r.snapshot,
  };
}

const ORDER = "ORDER BY recorded_at, observed_on, id";

export async function observationsForEntries(q: Query | Db["query"], entryIds: string[]): Promise<ObservationRecord[]> {
  if (!entryIds.length) return [];
  const rows = await q<Row & QueryResultRow>(`SELECT ${COLUMNS} FROM price_observations WHERE entry_id = ANY($1) ${ORDER}`, [entryIds]);
  return rows.map(fromRow);
}

/** Stay-quote observations whose configuration matches one of the fingerprints (any tax treatment). */
export async function observationsForFingerprints(q: Query | Db["query"], fingerprints: string[]): Promise<ObservationRecord[]> {
  if (!fingerprints.length) return [];
  const rows = await q<Row & QueryResultRow>(`SELECT ${COLUMNS} FROM price_observations WHERE fingerprint = ANY($1) ${ORDER}`, [fingerprints]);
  return rows.map(fromRow);
}

/**
 * The legacy per-entry `history` view, rebuilt from observations: every
 * observation but the latest, each superseded when the next one was recorded.
 */
export function historyFromObservations(obs: ObservationRecord[]): PriceObservation[] {
  return obs.slice(0, -1).map((o, i) => ({
    observedAt: o.observedOn,
    supersededAt: obs[i + 1]!.recordedAt,
    status: o.status,
    source: o.source,
    ...(o.sourceUrl ? { sourceUrl: o.sourceUrl } : {}),
    ...(o.notes ? { notes: o.notes } : {}),
    value: o.value,
  }));
}

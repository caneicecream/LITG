import { createHash, randomUUID } from "node:crypto";
import { addDays, type IsoDate } from "@/domain/dates";
import type { StoredPriceStatus } from "@/domain/provenance";
import type { PaymentTerms } from "@/domain/types";
import type { UserPriceEntry } from "@/data/store";
import { priceUnit, priceValue } from "@/data/observations";
import { comparableTotal, fingerprint, quoteKey, seriesKey, taxTreatment } from "./fingerprint";

/**
 * A durable, immutable record of one observed price. Created when an entry is
 * added, re-checked, imported, or reported by an authorized adapter; never
 * updated afterwards (enforced by a database trigger).
 */
export interface ObservationRecord {
  id: string;
  entryId: string;
  kind: UserPriceEntry["kind"];
  contentHash: string;
  observedOn: IsoDate;
  recordedAt: string;
  origin: "entry" | "recheck" | "import" | "adapter";
  status: StoredPriceStatus;
  source: string;
  sourceUrl: string | null;
  notes: string | null;
  value: number | null;
  valueUnit: "cents" | "points" | null;
  fingerprint: string | null;
  seriesKey: string | null;
  comparableTotalCents: number | null;
  config: {
    resortId: string;
    roomTypeId: string;
    checkIn: IsoDate;
    checkOut: IsoDate;
    adults: number;
    children: number;
    bookingMethod: string;
    ticketOption: string | null;
    ticketDays: number | null;
    dining: string;
  } | null;
  taxIncluded: boolean | null;
  taxCents: number | null;
  terms: PaymentTerms | null;
  assumptions: string[];
  snapshot: Omit<UserPriceEntry, "history">;
}

/** Deterministic JSON (sorted keys) so equal content always hashes equally. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export const contentHashOf = (snapshot: object) => createHash("sha256").update(stable(snapshot)).digest("hex").slice(0, 32);

export function observationFromEntry(
  entry: UserPriceEntry,
  origin: ObservationRecord["origin"],
  recordedAt: string,
  opts: { id?: string; assumptions?: string[] } = {},
): ObservationRecord {
  const { history: _h, ...snapshot } = entry;
  const contentHash = contentHashOf(snapshot);
  const p = entry.provenance;
  const base: ObservationRecord = {
    id: opts.id ?? `obs-${randomUUID()}`,
    entryId: entry.id,
    kind: entry.kind,
    contentHash,
    observedOn: p.observedAt,
    recordedAt,
    origin,
    status: p.status,
    source: p.source,
    sourceUrl: p.sourceUrl ?? null,
    notes: p.notes ?? null,
    value: priceValue(entry),
    valueUnit: priceUnit(entry),
    fingerprint: null,
    seriesKey: null,
    comparableTotalCents: null,
    config: null,
    taxIncluded: null,
    taxCents: null,
    terms: null,
    assumptions: opts.assumptions ?? [],
    snapshot,
  };
  if (entry.kind !== "stay_quote") return base;
  const k = quoteKey(entry);
  const fp = fingerprint(k);
  const treatment = taxTreatment(entry);
  const assumptions: string[] = [...(opts.assumptions ?? [])];
  if (entry.taxIncluded) assumptions.push("Total includes taxes as quoted.");
  else if (entry.taxCents !== undefined) assumptions.push("Taxes were quoted separately and are added to the total.");
  else assumptions.push("Total excludes taxes and no tax amount was quoted; it is only comparable with other pre-tax totals.");
  if (entry.bookingMethod === "points") assumptions.push("DVC point rental: no per-stay lodging tax is assumed.");
  if (!entry.terms) assumptions.push("Payment and cancellation terms were not recorded.");
  return {
    ...base,
    fingerprint: fp,
    seriesKey: seriesKey(fp, treatment),
    comparableTotalCents: comparableTotal(entry),
    config: {
      resortId: k.resortId,
      roomTypeId: k.roomTypeId,
      checkIn: k.checkIn,
      checkOut: addDays(k.checkIn, k.nights),
      adults: k.adults,
      children: k.children,
      bookingMethod: k.bookingMethod,
      ticketOption: k.ticket?.option ?? null,
      ticketDays: k.ticket?.days ?? null,
      dining: k.dining,
    },
    taxIncluded: entry.taxIncluded,
    taxCents: entry.taxCents ?? null,
    terms: entry.terms ?? null,
    assumptions,
  };
}

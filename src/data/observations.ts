import type { Provenance } from "@/domain/provenance";
import type { PriceObservation } from "@/domain/types";
import type { UserPriceEntry } from "./store";

/**
 * Re-checking a price ("is this quote still current?"). Pure functions; the
 * store persists the result. The previous observation is always appended to
 * `history`, so nothing is silently overwritten.
 */

/** The entry's main price field: cents for prices, points for point charts, none for rules and promotions. */
export function priceValue(e: UserPriceEntry): number | null {
  switch (e.kind) {
    case "stay_quote":
      return e.totalCents;
    case "room_rate":
      return e.nightlyCents;
    case "ticket_price":
      return e.cents;
    case "dining_plan_price":
      return e.perNightCents;
    case "point_chart":
      return e.pointsPerNight;
    case "point_cost":
      return e.centsPerPoint;
    case "promotion":
    case "ticket_rule":
      return null;
  }
}

export function priceUnit(e: UserPriceEntry): "cents" | "points" | null {
  if (e.kind === "point_chart") return "points";
  return priceValue(e) === null ? null : "cents";
}

export function withValue(e: UserPriceEntry, value: number): UserPriceEntry {
  switch (e.kind) {
    case "stay_quote":
      return { ...e, totalCents: value };
    case "room_rate":
      return { ...e, nightlyCents: value };
    case "ticket_price":
      return { ...e, cents: value };
    case "dining_plan_price":
      return { ...e, perNightCents: value };
    case "point_chart":
      return { ...e, pointsPerNight: value };
    case "point_cost":
      return { ...e, centsPerPoint: value };
    case "promotion":
    case "ticket_rule":
      return e;
  }
}

export interface RecheckInput {
  observedAt: string;
  status?: Provenance["status"];
  source?: string;
  sourceUrl?: string | null;
  notes?: string | null;
  /** New price (cents, or points for point charts). Omit when the price is unchanged ("still current"). */
  value?: number;
  /** Tax-inclusive flag for a stay quote, if the recheck changed it. */
  taxIncluded?: boolean;
}

export type RecheckResult = { ok: true; entry: UserPriceEntry } | { ok: false; error: string };

export function applyRecheck(e: UserPriceEntry, input: RecheckInput, nowIso: string): RecheckResult {
  if (input.observedAt < e.provenance.observedAt) {
    return { ok: false, error: `The new observation date must not be earlier than the current one (${e.provenance.observedAt}).` };
  }
  if (input.value !== undefined && priceValue(e) === null) {
    return { ok: false, error: "This entry has no price to update." };
  }
  if (input.value !== undefined && (!Number.isInteger(input.value) || input.value <= 0)) {
    return { ok: false, error: "The new price must be a positive whole number of cents (or points)." };
  }
  const previous: PriceObservation = {
    observedAt: e.provenance.observedAt,
    supersededAt: nowIso,
    status: e.provenance.status,
    source: e.provenance.source,
    ...(e.provenance.sourceUrl ? { sourceUrl: e.provenance.sourceUrl } : {}),
    ...(e.provenance.notes ? { notes: e.provenance.notes } : {}),
    value: priceValue(e),
  };
  const provenance: Provenance = {
    status: input.status ?? e.provenance.status,
    source: input.source?.trim() || e.provenance.source,
    observedAt: input.observedAt,
  };
  const url = input.sourceUrl === null ? undefined : (input.sourceUrl ?? e.provenance.sourceUrl);
  if (url) provenance.sourceUrl = url;
  const notes = input.notes === null ? undefined : (input.notes ?? e.provenance.notes);
  if (notes) provenance.notes = notes;

  let next = input.value !== undefined ? withValue(e, input.value) : e;
  if (next.kind === "stay_quote" && input.taxIncluded !== undefined) {
    next = { ...next, taxIncluded: input.taxIncluded, ...(input.taxIncluded ? { taxCents: undefined } : {}) };
  }
  return { ok: true, entry: { ...next, provenance, history: [...(e.history ?? []), previous] } as UserPriceEntry };
}

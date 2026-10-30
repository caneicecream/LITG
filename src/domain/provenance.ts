import { daysBetween, type IsoDate } from "./dates";

/**
 * Where a number came from and how much it can be trusted. These statuses are
 * part of the data model: every price, tax rate, promotion, and cost line
 * carries one, and the optimizer uses them for resolution and ranking.
 */
export type PriceStatus =
  /** Obtained from a reliable source with evidence it applies to this configuration. Reserved for vetted data adapters. */
  | "verified"
  /** Entered by the user from a real quote or booking page. */
  | "manual"
  /** Calculated from an explicitly documented estimate or assumption. */
  | "estimated"
  /** Artificial data for demonstrating the interface/algorithm. Never a real offer. */
  | "illustrative"
  /** Could not be established. */
  | "unavailable"
  /** A verified/manual observation old enough that it needs revalidation. Derived, never stored. */
  | "stale";

/** Statuses that may be stored on source data. "stale" is computed from age; "unavailable" means no data. */
export type StoredPriceStatus = Exclude<PriceStatus, "stale" | "unavailable">;

export interface Provenance {
  status: StoredPriceStatus;
  /** Human-readable source, e.g. "disneyworld.com quote" or "Illustrative demo dataset". */
  source: string;
  sourceUrl?: string;
  /** When the value was observed or entered (ISO date). */
  observedAt: IsoDate;
  notes?: string;
}

export const STATUS_LABEL: Record<PriceStatus, string> = {
  verified: "Verified",
  manual: "Manually entered",
  estimated: "Estimated",
  illustrative: "Illustrative",
  unavailable: "Unavailable",
  stale: "Stale",
};

/**
 * Trust rank used when choosing between competing sources for the same price
 * (lower is better). Fresh real observations beat stale ones, which beat
 * documented estimates, which beat illustrative demo data.
 */
export const STATUS_RANK: Record<PriceStatus, number> = {
  verified: 0,
  manual: 1,
  stale: 2,
  estimated: 3,
  illustrative: 4,
  unavailable: 5,
};

/** Only real observations can go stale; estimates and demo data have no "freshness". */
export function effectiveStatus(p: Provenance, today: IsoDate, staleAfterDays: number): PriceStatus {
  if ((p.status === "verified" || p.status === "manual") && daysBetween(p.observedAt, today) > staleAfterDays) {
    return "stale";
  }
  return p.status;
}

/** The weakest (least trustworthy) of several statuses. */
export function weakestStatus(statuses: readonly PriceStatus[]): PriceStatus {
  let worst: PriceStatus = "verified";
  for (const s of statuses) if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  return worst;
}

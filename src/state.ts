import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tier, Verdict } from "./evaluate.ts";
import type { Availability, Listing } from "./types.ts";

export interface ListingState {
  title: string;
  retailer: string;
  url: string;
  lastSeenAt: string;
  priceCents: number | null;
  availability: Availability;
  tier: Tier;
  /** Whether it qualified for an alert on the last check. */
  alertable: boolean;
  lastAlert?: { at: string; priceCents: number; tier: Tier };
}

export interface SourceHealth {
  consecutiveFailures: number;
  lastOkAt?: string;
  lastError?: string;
  /** Set once the "this source keeps failing" alert has gone out; cleared on recovery. */
  failureAlerted?: boolean;
}

export interface State {
  version: 1;
  listings: Record<string, ListingState>;
  sources: Record<string, SourceHealth>;
}

export const emptyState = (): State => ({ version: 1, listings: {}, sources: {} });

export async function loadState(path: string): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as State;
    if (parsed?.version !== 1 || typeof parsed.listings !== "object" || typeof parsed.sources !== "object") {
      throw new Error("unrecognised state file");
    }
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw new Error(`Could not read ${path}: ${(e as Error).message}. Move it aside to start fresh.`);
  }
}

/** Writes atomically so a crash mid-write can't corrupt the state. */
export async function saveState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, path);
}

/** Minimum gap between repeat alerts for the same listing, unless the price drops. */
const FLAP_GUARD_MS = 30 * 60_000;

/**
 * Decides whether a qualifying listing deserves a (new) alert:
 * first sighting, a lower price than last alerted, a better tier, a return to
 * qualifying after being out of stock or too expensive, or a reminder after
 * `realertHours`.
 */
export function alertReason(
  prev: ListingState | undefined,
  listing: Listing,
  verdict: Verdict,
  now: Date,
  realertHours: number,
): string | null {
  if (!verdict.alertable || listing.priceCents === null) return null;
  const last = prev?.lastAlert;
  if (!last) return "new";
  const since = now.getTime() - Date.parse(last.at);
  if (listing.priceCents < last.priceCents) return "price dropped";
  if (last.tier === "near_msrp" && verdict.tier === "at_or_below_msrp") return "now at or under MSRP";
  // A deal post is a one-time tip, not a stock reading: never remind about it.
  if (listing.sourceKind === "deal_feed") return null;
  if (since < FLAP_GUARD_MS) return null;
  if (prev && !prev.alertable) return prev.availability === "out_of_stock" ? "back in stock" : "qualifies again";
  if (since >= realertHours * 3_600_000) return "still available";
  return null;
}

export function recordListing(prev: ListingState | undefined, listing: Listing, verdict: Verdict): ListingState {
  return {
    title: listing.title,
    retailer: listing.retailer,
    url: listing.url,
    lastSeenAt: listing.observedAt,
    priceCents: listing.priceCents,
    availability: listing.availability,
    tier: verdict.tier,
    alertable: verdict.alertable,
    lastAlert: prev?.lastAlert,
  };
}

/** Drops listings not seen for 30 days so the file doesn't grow forever. */
export function pruneState(state: State, now: Date): void {
  const cutoff = now.getTime() - 30 * 24 * 3_600_000;
  for (const [key, l] of Object.entries(state.listings)) {
    if (Date.parse(l.lastSeenAt) < cutoff) delete state.listings[key];
  }
}

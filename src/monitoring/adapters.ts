import type { StayQuote } from "@/domain/types";
import type { ConfigKey } from "./fingerprint";

/**
 * Authorized price-source adapters. An adapter turns a configuration into
 * fresh quotes from a source the user is permitted to query programmatically
 * (for example a travel-trade API under contract). Adapters must never scrape
 * or automate Disney's consumer website.
 *
 * None are registered: no authorized source is available to this project
 * (see docs/ROADMAP.md, Milestone 0). Monitoring therefore records new
 * observations only from your own entries and re-checks.
 */
export interface ObservationAdapter {
  id: string;
  name: string;
  /** Shown to the user next to every observation it produces. */
  limitations: string;
  /**
   * Quotes for the configuration as plain data. They are validated like a
   * user's quote before being stored, and their status becomes "verified".
   */
  fetchQuotes(config: ConfigKey, signal: AbortSignal): Promise<unknown[]>;
}

export type AdapterQuote = Omit<StayQuote, "id" | "history">;

export const ADAPTERS: ObservationAdapter[] = [];

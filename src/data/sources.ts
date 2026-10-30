import type { PriceData } from "@/domain/types";
import { ILLUSTRATIVE_DATA } from "./illustrative";
import { TAX_RATES, TRANSPORT } from "./reference";
import { listPrices, type UserPriceEntry } from "./store";

/**
 * Data acquisition layer. Each source contributes price data tagged with its
 * own provenance; the optimizer's resolution rules decide which source wins.
 * New sources (e.g. an authorized booking-partner feed) are added here as
 * another `PriceSource` without changing the optimizer.
 */
export interface PriceSource {
  id: string;
  name: string;
  load(): Promise<Partial<PriceData>>;
}

export const referenceSource: PriceSource = {
  id: "reference",
  name: "Reference estimates (taxes, parking)",
  load: async () => ({ taxRates: TAX_RATES, transport: TRANSPORT }),
};

export const illustrativeSource: PriceSource = {
  id: "illustrative",
  name: "Illustrative demo dataset",
  load: async () => ILLUSTRATIVE_DATA,
};

export const manualSource: PriceSource = {
  id: "manual",
  name: "Your quotes and prices",
  load: async () => splitEntries(await listPrices()),
};

export function splitEntries(entries: UserPriceEntry[]): Partial<PriceData> {
  const out: PriceData = emptyPriceData();
  for (const e of entries) {
    switch (e.kind) {
      case "room_rate":
        out.roomRates.push(e);
        break;
      case "ticket_price":
        out.ticketPrices.push(e);
        break;
      case "dining_plan_price":
        out.diningPlanPrices.push(e);
        break;
      case "stay_quote":
        out.stayQuotes.push(e);
        break;
      case "promotion": {
        const { kind: _k, ...promo } = e;
        out.promotions.push(promo);
        break;
      }
    }
  }
  return out;
}

export function emptyPriceData(): PriceData {
  return { roomRates: [], ticketPrices: [], diningPlanPrices: [], stayQuotes: [], transport: [], taxRates: [], promotions: [] };
}

export function mergePriceData(parts: Partial<PriceData>[]): PriceData {
  const out = emptyPriceData();
  for (const p of parts) {
    for (const k of Object.keys(out) as (keyof PriceData)[]) {
      const items = p[k];
      if (items) (out[k] as unknown[]).push(...items);
    }
  }
  return out;
}

/**
 * Load all price data. Illustrative data is loaded only when requested, and the
 * resolver additionally ignores it when excluded, so the two checks are redundant
 * on purpose.
 */
export async function loadPriceData(opts: { includeIllustrative: boolean }): Promise<PriceData> {
  const sources = [referenceSource, manualSource, ...(opts.includeIllustrative ? [illustrativeSource] : [])];
  return mergePriceData(await Promise.all(sources.map((s) => s.load())));
}

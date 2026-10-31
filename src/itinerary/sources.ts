import type { IsoDate } from "@/domain/dates";
import type { ParkInfo } from "./types";

/**
 * Extension point for an AUTHORIZED park-information source (for example a
 * licensed data feed). Its items would carry provenance status "verified" or
 * "predicted" with the source's name and retrieval time, and would be validated
 * with `parkInfoSchema` like everything else.
 *
 * None is registered: this project has no authorized source for park hours,
 * closures, waits, crowds or availability, and never scrapes Disney's websites.
 * The interface existing does not mean a live integration exists.
 */
export interface ParkInfoSource {
  id: string;
  name: string;
  /** Shown next to every item it provides. */
  limitations: string;
  load(dates: IsoDate[], parkIds: string[], signal: AbortSignal): Promise<Partial<ParkInfo>>;
}

export const PARK_INFO_SOURCES: ParkInfoSource[] = [];

import { addDays, type IsoDate } from "@/domain/dates";
import type { Cents } from "@/domain/money";
import type { BookingMethod, Configuration, DiningChoice, StayQuote, TicketOption, TripRequest } from "@/domain/types";

/**
 * Equivalence of vacation configurations. Two prices belong on the same trend
 * line only if they price the same thing: same resort, room, dates, party,
 * booking method, tickets and dining, AND the same tax treatment.
 */
export interface ConfigKey {
  resortId: string;
  roomTypeId: string;
  checkIn: IsoDate;
  nights: number;
  adults: number;
  children: number;
  bookingMethod: BookingMethod;
  ticket: { option: TicketOption; days: number } | null;
  dining: DiningChoice;
}

export function fingerprint(k: ConfigKey): string {
  return [
    k.resortId,
    k.roomTypeId,
    k.checkIn,
    `${k.nights}n`,
    `${k.adults}a${k.children}c`,
    k.bookingMethod,
    k.ticket ? `${k.ticket.option}:${k.ticket.days}d` : "no-tickets",
    k.dining,
  ].join("|");
}

/** Tax treatment splits series: an all-in total and a pre-tax total are not comparable. */
export type TaxTreatment = "all_in" | "pre_tax";

export function taxTreatment(q: Pick<StayQuote, "taxIncluded" | "taxCents">): TaxTreatment {
  return q.taxIncluded || q.taxCents !== undefined ? "all_in" : "pre_tax";
}

export const seriesKey = (fp: string, t: TaxTreatment) => `${fp}#${t}`;

/** The comparable value of a quote within its series: all-in total, or the pre-tax total in a pre-tax series. */
export function comparableTotal(q: Pick<StayQuote, "totalCents" | "taxIncluded" | "taxCents">): Cents {
  return q.taxIncluded ? q.totalCents : q.totalCents + (q.taxCents ?? 0);
}

export function quoteKey(q: StayQuote): ConfigKey {
  return {
    resortId: q.resortId,
    roomTypeId: q.roomTypeId,
    checkIn: q.checkIn,
    nights: q.nights,
    adults: q.adults,
    children: q.children,
    bookingMethod: q.bookingMethod,
    ticket: q.ticket ? { option: q.ticket.option, days: q.ticket.days } : null,
    dining: q.dining,
  };
}

/** The configuration key of an optimizer configuration for a given trip request. */
export function configKey(c: Configuration, req: TripRequest): ConfigKey {
  return {
    resortId: c.resortId,
    roomTypeId: c.roomTypeId,
    checkIn: c.arrival,
    nights: c.nights,
    adults: req.party.adults,
    children: req.party.children,
    bookingMethod: c.bookingMethod,
    ticket: c.ticketOption ? { option: c.ticketOption, days: req.tickets.parkDays } : null,
    dining: c.dining,
  };
}

/** Human-readable differences between two configurations (empty = equivalent). */
export function configDifferences(a: ConfigKey, b: ConfigKey): string[] {
  const d: string[] = [];
  if (a.resortId !== b.resortId || a.roomTypeId !== b.roomTypeId) d.push("different resort or room");
  if (a.checkIn !== b.checkIn) d.push(`different arrival (${a.checkIn} vs ${b.checkIn})`);
  if (a.nights !== b.nights) d.push(`${b.nights} vs ${a.nights} nights`);
  if (a.adults !== b.adults || a.children !== b.children) d.push("different party");
  if (a.bookingMethod !== b.bookingMethod) d.push("different booking method");
  if (JSON.stringify(a.ticket) !== JSON.stringify(b.ticket)) d.push("different tickets");
  if (a.dining !== b.dining) d.push("different dining");
  return d;
}

export const checkOut = (k: ConfigKey) => addDays(k.checkIn, k.nights);

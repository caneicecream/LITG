/**
 * Calendar-date helpers. Dates are ISO strings "YYYY-MM-DD" interpreted as
 * calendar days (no time zone). All arithmetic is done in UTC to avoid DST bugs.
 */
export type IsoDate = string;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  if (!ISO_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Hot path: inputs are validated at the boundary (request schema), so only a cheap shape check here. */
function toUtc(d: IsoDate): number {
  const t = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  if (d.length !== 10 || Number.isNaN(t)) throw new Error(`Invalid ISO date: ${d}`);
  return t;
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return new Date(toUtc(d) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(d: IsoDate): number {
  return new Date(toUtc(d)).getUTCDay();
}

/** Inclusive range check on ISO dates (lexicographic order equals chronological order). */
export function inRange(d: IsoDate, from: IsoDate, to: IsoDate): boolean {
  return d >= from && d <= to;
}

/** The calendar dates of each night of a stay: check-in .. check-out - 1. */
export function stayNights(checkIn: IsoDate, nights: number): IsoDate[] {
  return Array.from({ length: nights }, (_, i) => addDays(checkIn, i));
}

export function todayIso(now: Date = new Date()): IsoDate {
  return now.toISOString().slice(0, 10);
}

const LONG = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const SHORT = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

export function formatDate(d: IsoDate): string {
  return LONG.format(new Date(toUtc(d)));
}

export function formatShortDate(d: IsoDate): string {
  return SHORT.format(new Date(toUtc(d)));
}

import { addDays, daysBetween, isIsoDate, type IsoDate } from "@/domain/dates";
import type { InfoProvenance, ParkInfo } from "../types";

/**
 * Park hours pasted from an official park calendar (copied by the user; the
 * app never fetches it). Lenient about layout, strict about values: a line is
 * used only when its date, park and times are unambiguous, and every line that
 * isn't used is reported with the reason.
 *
 * Accepted shapes (one park per line; a date may head a block or prefix a line):
 *   Mon, Feb 2                         2027-02-03 EPCOT 9am-9pm
 *   Magic Kingdom 9:00 AM – 10:00 PM   Feb 4: Hollywood Studios 8:30 AM to 9:00 PM
 *   Early Entry 8:30 AM                Animal Kingdom 8:00–19:00 (Early Entry 7:30 AM)
 */

export type HoursEntry = ParkInfo["hours"][number];

export interface HoursImport {
  entries: HoursEntry[];
  /** Lines that were not used, with the reason. */
  skipped: { line: string; reason: string }[];
  warnings: string[];
}

const PARK_PATTERNS: [RegExp, string][] = [
  [/\bmagic kingdom\b|\bmk\b/i, "magic-kingdom"],
  [/\bepcot\b/i, "epcot"],
  [/\bhollywood studios\b|\bdhs\b|\bhs\b/i, "hollywood-studios"],
  [/\banimal kingdom\b|\bdak\b|\bak\b/i, "animal-kingdom"],
];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "9:00 AM", "9am", "21:00", "9 PM" → minutes; null when ambiguous (a bare "9"). */
function timeOf(raw: string): number | null {
  const m = raw.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|noon|midnight)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3];
  if (min > 59) return null;
  if (!ap && !m[2]) return null;
  if (ap?.startsWith("p") && h < 12) h += 12;
  if (ap?.startsWith("a") && h === 12) h = 0;
  if (ap === "noon") h = 12;
  if (h > 23) return null;
  return h * 60 + min;
}
const TIME = String.raw`\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?`;
const RANGE = new RegExp(`(${TIME})\\s*(?:-|–|—|to|until)\\s*(${TIME})`, "i");
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** A date at the start of a line, resolved within the trip; the rest of the line is returned. */
function leadingDate(line: string, trip: { arrival: IsoDate; departure: IsoDate }): { date: IsoDate | null; rest: string; found: boolean } {
  const t = line.trim().replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, "");
  let m = t.match(/^(\d{4}-\d{2}-\d{2})\b[:,]?\s*/);
  if (m) return { date: isIsoDate(m[1]!) ? m[1]! : null, rest: t.slice(m[0].length), found: true };
  m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b[:,]?\s*/);
  if (m) return { date: resolve(Number(m[1]), Number(m[2]), m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : null, trip), rest: t.slice(m[0].length), found: true };
  m = t.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b[:,]?\s*/i);
  if (m) return { date: resolve(MONTHS.indexOf(m[1]!.toLowerCase()) + 1, Number(m[2]), m[3] ? Number(m[3]) : null, trip), rest: t.slice(m[0].length), found: true };
  return { date: null, rest: line, found: false };
}

/** Month/day (and optional year) → a date within the trip; without a year, the trip decides the year. */
function resolve(month: number, day: number, year: number | null, trip: { arrival: IsoDate; departure: IsoDate }): IsoDate | null {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (year) {
    const iso = `${year}-${pad(month)}-${pad(day)}`;
    return isIsoDate(iso) ? iso : null;
  }
  for (let i = 0; i <= daysBetween(trip.arrival, trip.departure); i++) {
    const d = addDays(trip.arrival, i);
    if (Number(d.slice(5, 7)) === month && Number(d.slice(8, 10)) === day) return d;
  }
  // Not in the trip: still a date (reported as outside the trip) using the arrival year.
  const iso = `${trip.arrival.slice(0, 4)}-${pad(month)}-${pad(day)}`;
  return isIsoDate(iso) ? iso : null;
}

export function parseParkHours(text: string, trip: { arrival: IsoDate; departure: IsoDate }, provenance: InfoProvenance): HoursImport {
  const entries: HoursEntry[] = [];
  const skipped: HoursImport["skipped"] = [];
  const warnings: string[] = [];
  let current: IsoDate | null = null;
  let last: HoursEntry | null = null;
  const key = (e: HoursEntry) => `${e.date}|${e.parkId}`;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const lead = leadingDate(line, trip);
    if (lead.found) {
      if (!lead.date) {
        skipped.push({ line, reason: "the date isn't a valid calendar date" });
        current = null;
        continue;
      }
      current = lead.date;
      if (!lead.rest.trim()) continue; // a heading line
    }
    const body = lead.found ? lead.rest : line;
    const lower = body.toLowerCase();

    // "Early Entry 8:30 AM" on its own line applies to the park just above it.
    if (/early (theme park )?entry/.test(lower) && !PARK_PATTERNS.some(([re]) => re.test(body))) {
      const t = body.match(new RegExp(TIME, "ig"))?.map(timeOf).find((x) => x !== null);
      if (!last || t === undefined || t === null) skipped.push({ line, reason: "early entry needs a time and a park line above it" });
      else if (t >= toMinutes(last.open)) skipped.push({ line, reason: "early entry must start before the park opens" });
      else last.earlyEntryMin = toMinutes(last.open) - t;
      continue;
    }
    if (/extended evening/.test(lower)) {
      skipped.push({ line, reason: "extended evening hours apply only to some resort guests; enter them yourself if you qualify" });
      continue;
    }
    const parks = PARK_PATTERNS.filter(([re]) => re.test(body)).map(([, id]) => id);
    const range = body.match(RANGE);
    if (!parks.length && !range) {
      skipped.push({ line, reason: "no park or hours found" });
      continue;
    }
    if (parks.length !== 1) {
      skipped.push({ line, reason: parks.length ? "more than one park on the line" : "no park name found" });
      continue;
    }
    if (!range) {
      skipped.push({ line, reason: /closed/i.test(body) ? "the park is listed as closed" : "no opening and closing times found (e.g. 9:00 AM – 10:00 PM)" });
      continue;
    }
    if (!current) {
      skipped.push({ line, reason: "no date for this line (put a date before it)" });
      continue;
    }
    const open = timeOf(range[1]!);
    let close = timeOf(range[2]!);
    if (open === null || close === null) {
      skipped.push({ line, reason: "the times are ambiguous (use 9:00 AM or 21:00)" });
      continue;
    }
    if (close <= open) {
      if (close < 6 * 60) {
        warnings.push(`${current} ${parks[0]}: closes after midnight (${range[2]!.trim()}); recorded as closing at 11:59 PM.`);
        close = 23 * 60 + 59;
      } else {
        skipped.push({ line, reason: "closing time is before opening time" });
        continue;
      }
    }
    if (current < trip.arrival || current > trip.departure) {
      skipped.push({ line, reason: `${current} is outside your trip (${trip.arrival} to ${trip.departure})` });
      continue;
    }
    const entry: HoursEntry = { date: current, parkId: parks[0]!, open: hhmm(open), close: hhmm(close), earlyEntryMin: null, provenance };
    const ee = body.match(/early (?:theme park )?entry[^0-9]*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i);
    if (ee) {
      const t = timeOf(ee[1]!);
      if (t !== null && t < open) entry.earlyEntryMin = open - t;
      else warnings.push(`${current} ${parks[0]}: the early entry time wasn't understood and was left out.`);
    }
    const dup = entries.findIndex((e) => key(e) === key(entry));
    if (dup >= 0) {
      warnings.push(`${current} ${parks[0]}: listed twice; the later line is used.`);
      entries.splice(dup, 1);
    }
    entries.push(entry);
    last = entry;
  }
  return { entries, skipped, warnings };
}

const toMinutes = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));

/** Merge imported hours into park information: same date and park replaces the existing entry (reported). */
export function mergeHours(info: ParkInfo, entries: HoursEntry[]): { info: ParkInfo; replaced: number } {
  const keys = new Set(entries.map((e) => `${e.date}|${e.parkId}`));
  const kept = info.hours.filter((h) => !keys.has(`${h.date}|${h.parkId}`));
  return { info: { ...info, hours: [...kept, ...entries] }, replaced: info.hours.length - kept.length };
}

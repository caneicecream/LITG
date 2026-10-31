import { addDays, daysBetween, formatShortDate, type IsoDate } from "@/domain/dates";
import { advisoriesFor, ATTRACTIONS, areaOf, attractionById, CATALOG_PROVENANCE, parkById, PARKS, type Attraction } from "./catalog";
import type {
  DayPlan,
  DerivedInfoStatus,
  InfoProvenance,
  Itinerary,
  ItineraryInput,
  ParkInfo,
  PlannedItem,
  Preferences,
  ScoreComponent,
  TripContext,
} from "./types";

/**
 * Deterministic itinerary planner.
 *
 *   1. Which dates can be park days (trip dates, arrival/departure choices,
 *      ticket admission days, use-within window, expiration, blocked dates).
 *   2. Park-day allocation: a bounded beam search over (date → park / hop /
 *      no park), honouring pins, reservations and the ticket. Allocations are
 *      ranked by a cheap coverage estimate; the top few are scheduled in full.
 *   3. Day scheduling: a few route orderings per day (priority-weighted
 *      nearest neighbour, clockwise and counter-clockwise sweeps), simulated
 *      minute by minute with travel, waits, meals, breaks and fixed reservations.
 *   4. Scoring with documented components; the highest-scoring candidate is
 *      returned. It is the best candidate found, not a proven optimum.
 *   5. An independent check of hard constraints on the result.
 *
 * Same input → same output (no randomness, no clock reads except `today`).
 */

export const ITINERARY_ENGINE_VERSION = "2026-10-31.m5";

/** Limits that keep the search bounded. */
export const LIMITS = { maxTripDays: 21, beamWidth: 60, candidatesScheduled: 4, maxAttractionsPerDay: 40 };

// ───────────────────────────── Small helpers ─────────────────────────────

export const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export function fmtTime(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Deterministic FNV-1a hash of sorted-key JSON (runs in the browser and on the server). */
export function stableHash(v: unknown): string {
  const s = stableJson(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Freshness: user-entered or observed park information goes stale after `staleAfterDays`. */
export function effectiveStatus(p: InfoProvenance, today: IsoDate, staleAfterDays: number): DerivedInfoStatus {
  if (p.status === "illustrative" || p.status === "estimated") return p.status;
  const d = p.observedAt.slice(0, 10);
  return daysBetween(d, today) > staleAfterDays ? "stale" : p.status;
}

function walkMinutes(parkId: string, from: string | null, to: string, mobility: Preferences["mobility"]): number {
  const a = from ? areaOf(parkId, from) : { x: 0, y: 0 };
  const b = areaOf(parkId, to);
  if (!a || !b) return 10;
  if (from === to) return 3;
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  return Math.round((d + 2) * (mobility === "slower" ? 1.4 : 1));
}

const HOP_TRANSFER_MIN = 40;
const OFFSITE_DINING_TRANSFER_MIN = 30;
const PACE = {
  relaxed: { target: 0.55, breakEvery: 150, breakMin: 20, mealExtra: 15 },
  moderate: { target: 0.7, breakEvery: 210, breakMin: 15, mealExtra: 0 },
  packed: { target: 0.85, breakEvery: Infinity, breakMin: 0, mealExtra: 0 },
} as const;
const CROWD_FACTOR = { low: 0.6, moderate: 1, high: 1.5 } as const;
/** Day-ordering penalty per hour a must-do starts after the day's start (a heuristic, documented in ARCHITECTURE.md). */
const MUST_LATENESS_PER_HOUR = 6;

// ───────────────────────────── Activities ─────────────────────────────

interface Activity {
  id: string;
  name: string;
  parkId: string;
  areaId: string;
  durationMin: number;
  intensity: number;
  priority: "must" | "want" | "optional";
  custom: boolean;
  category: Attraction["category"] | "custom";
  schedule: Attraction["schedule"] | "custom";
  minHeightIn?: number;
}

function activities(input: ItineraryInput, parks: string[]): Activity[] {
  const prefs = input.prefs;
  const out: Activity[] = [];
  for (const x of ATTRACTIONS) {
    if (!parks.includes(x.parkId)) continue;
    const p = prefs.attractions[x.id];
    if (p === "avoid") continue;
    const priority = p === "must" ? "must" : p === "want" ? "want" : "optional";
    // Evening shows and parades are never added as extras: they need a time you entered.
    if (x.schedule === "spectacular" && priority === "optional") continue;
    out.push({ ...x, intensity: x.intensity, priority, custom: false });
  }
  for (const c of prefs.custom) {
    if (!parks.includes(c.parkId)) continue;
    out.push({ id: c.id, name: c.name, parkId: c.parkId, areaId: c.areaId, durationMin: c.durationMin, intensity: 1, priority: c.priority, custom: true, category: "custom", schedule: "custom" });
  }
  return out;
}

// ───────────────────────────── 1. Which dates can be park days ─────────────────────────────

interface DateInfo {
  date: IsoDate;
  isArrival: boolean;
  isDeparture: boolean;
  /** Reason the date can't be a park day, or null. */
  blocked: string | null;
}

function tripDates(ctx: TripContext): DateInfo[] {
  const n = Math.min(daysBetween(ctx.arrival, ctx.departure), LIMITS.maxTripDays - 1);
  const usage = ctx.ticket?.usage ?? null;
  const out: DateInfo[] = [];
  for (let i = 0; i <= n; i++) {
    const date = addDays(ctx.arrival, i);
    const isArrival = i === 0;
    const isDeparture = date === ctx.departure;
    let blocked: string | null = null;
    if (isArrival && !ctx.parkOnArrivalDay) blocked = "arrival day (no park planned, as in your trip settings)";
    else if (isDeparture && !ctx.parkOnDepartureDay) blocked = "departure day (no park planned, as in your trip settings)";
    else if (usage?.expiresOn && date > usage.expiresOn) blocked = `the ticket expires ${formatShortDate(usage.expiresOn)}`;
    else if (usage?.blockoutDates?.includes(date)) blocked = "a blocked-out date for your ticket";
    out.push({ date, isArrival, isDeparture, blocked });
  }
  return out;
}

// ───────────────────────────── 2. Allocation ─────────────────────────────

type Slot = { kind: "none" } | { kind: "park"; parkId: string } | { kind: "hop"; parkIds: [string, string] };
const slotKey = (s: Slot) => (s.kind === "none" ? "-" : s.kind === "park" ? s.parkId : `${s.parkIds[0]}>${s.parkIds[1]}`);
const slotParks = (s: Slot): string[] => (s.kind === "none" ? [] : s.kind === "park" ? [s.parkId] : s.parkIds);

interface PlanContext {
  input: ItineraryInput;
  today: IsoDate;
  staleAfterDays: number;
  dates: DateInfo[];
  wantedParks: string[];
  parkDaysAllowed: number;
  /** date → parks the user is committed to (reservations, dining, Lightning Lane). */
  required: Map<IsoDate, Set<string>>;
  /** date → earliest committed time (minutes) per park, to order park-hop days. */
  commitTimes: Map<IsoDate, Map<string, number>>;
  /** date → parks with a park reservation (when reservations are required). */
  reserved: Map<IsoDate, Set<string>>;
  demand: Map<string, { must: number; want: number; optional: number; intensity: number }>;
  dayMinutes: Map<IsoDate, number>;
  conflicts: string[];
  infeasible: string[];
}

function windowFor(pc: PlanContext, date: IsoDate, parkId: string): { start: number; end: number; basis: DayPlan["window"]["basis"]; detail: string; known: boolean } {
  const prefs = pc.input.prefs;
  const di = pc.dates.find((d) => d.date === date)!;
  let start = toMin(di.isArrival ? (prefs.arrivalDayStart > prefs.dayStart ? prefs.arrivalDayStart : prefs.dayStart) : prefs.dayStart);
  let end = toMin(di.isDeparture ? (prefs.departureDayEnd < prefs.dayEnd ? prefs.departureDayEnd : prefs.dayEnd) : prefs.dayEnd);
  const hours = pc.input.parkInfo.hours.find((h) => h.date === date && h.parkId === parkId);
  if (!hours) {
    return { start, end, basis: "planning_window", detail: `Park hours unknown: using your planning window ${fmtTime(start)}–${fmtTime(end)}. Check the actual hours.`, known: false };
  }
  const early = prefs.useEarlyEntry && hours.earlyEntryMin ? hours.earlyEntryMin : 0;
  const open = toMin(hours.open) - early;
  const close = toMin(hours.close);
  start = Math.max(start, open);
  end = Math.min(end, close);
  const status = effectiveStatus(hours.provenance, pc.today, pc.staleAfterDays);
  return {
    start,
    end: Math.max(start, end),
    basis: hours.provenance.status === "illustrative" ? "illustrative_hours" : "park_hours",
    detail: `${hours.provenance.status === "illustrative" ? "Illustrative" : "Park"} hours ${fmtTime(toMin(hours.open))}–${fmtTime(close)}${early ? ` with ${early} min early entry` : ""} (${hours.provenance.source}${status === "stale" ? ", stale" : ""}); your window ${fmtTime(start)}–${fmtTime(Math.max(start, end))}.`,
    known: hours.provenance.status !== "illustrative",
  };
}

function validSlot(pc: PlanContext, date: IsoDate, slot: Slot): boolean {
  const req = pc.required.get(date);
  if (slot.kind === "none") return !req || req.size === 0;
  const parks = slotParks(slot);
  if (req) for (const p of req) if (!parks.includes(p)) return false;
  const res = pc.reserved.get(date);
  if (res && res.size > 0) for (const p of parks) if (!res.has(p)) return false;
  if (slot.kind === "hop") {
    // The first park of a hop day must not have its commitments after the second park's.
    const times = pc.commitTimes.get(date);
    const a = times?.get(slot.parkIds[0]);
    const b = times?.get(slot.parkIds[1]);
    if (a !== undefined && b !== undefined && a > b) return false;
  }
  return true;
}

/** Cheap estimate of an allocation's value (used to rank allocations before full scheduling). */
function allocationEstimate(pc: PlanContext, slots: Slot[]): number {
  const cap = new Map<string, number>();
  const target = PACE[pc.input.prefs.pace].target;
  slots.forEach((s, i) => {
    const date = pc.dates[i]!.date;
    const parks = slotParks(s);
    const minutes = (pc.dayMinutes.get(date) ?? 600) - (s.kind === "hop" ? HOP_TRANSFER_MIN : 0);
    for (const p of parks) cap.set(p, (cap.get(p) ?? 0) + (minutes * target) / parks.length);
  });
  let must = 0;
  let mustTotal = 0;
  let want = 0;
  let wantTotal = 0;
  let optional = 0;
  for (const [p, d] of pc.demand) {
    const c = cap.get(p) ?? 0;
    mustTotal += d.must;
    wantTotal += d.want;
    const m = Math.min(c, d.must);
    must += m;
    const w = Math.min(c - m, d.want);
    want += Math.max(0, w);
    optional += Math.max(0, Math.min(c - m - Math.max(0, w), d.optional));
  }
  const visited = new Set(slots.flatMap(slotParks));
  const parkCoverage = pc.wantedParks.length ? pc.wantedParks.filter((p) => visited.has(p)).length / pc.wantedParks.length : 1;
  let score = 1000 * (mustTotal ? must / mustTotal : 1) + 250 * (wantTotal ? want / wantTotal : 1) + 150 * parkCoverage + optional / 60;
  // Spending a second day at a park before every wanted park has one is penalised.
  const counts = new Map<string, number>();
  for (const p of slots.flatMap(slotParks)) counts.set(p, (counts.get(p) ?? 0) + 1);
  score -= 5 * slots.filter((s) => s.kind === "hop").length;
  // Unused admission days are only worth leaving unused for a rest-day preference.
  score += 0.5 * slots.filter((s) => s.kind !== "none").length;
  // Most demanding park day first (right after arrival) is penalised when the user asked.
  if (pc.input.prefs.avoidDemandingArrivalDay) {
    const parkDays = slots.map((s, i) => ({ s, i })).filter((x) => x.s.kind !== "none");
    if (parkDays.length > 1) {
      const intensity = (s: Slot) => slotParks(s).reduce((t, p) => t + (pc.demand.get(p)?.intensity ?? 0) / (counts.get(p) ?? 1), 0);
      const first = parkDays[0]!;
      const max = Math.max(...parkDays.map((x) => intensity(x.s)));
      if (intensity(first.s) >= max && parkDays.some((x) => intensity(x.s) < max)) score -= 40;
    }
  }
  // Rest-day preference: a non-park day between park days.
  const inner = slots.map((s, i) => ({ s, d: pc.dates[i]! })).filter((x) => !x.d.blocked);
  const firstPark = inner.findIndex((x) => x.s.kind !== "none");
  const lastPark = inner.length - 1 - [...inner].reverse().findIndex((x) => x.s.kind !== "none");
  const midRest = firstPark >= 0 && inner.slice(firstPark, lastPark + 1).some((x) => x.s.kind === "none");
  if (pc.input.prefs.restDay === "prefer" && midRest) score += 30;
  if (pc.input.prefs.restDay === "avoid" && midRest) score -= 30;
  return score;
}

interface Allocation {
  slots: Slot[];
  estimate: number;
}

function allocate(pc: PlanContext): { allocations: Allocation[]; considered: number; limited: boolean } {
  const prefs = pc.input.prefs;
  const hopper = !!pc.input.context.ticket?.hopper && prefs.allowHopping;
  const parkOptions: Slot[] = pc.wantedParks.map((p) => ({ kind: "park", parkId: p }));
  const hopOptions: Slot[] = hopper ? pc.wantedParks.flatMap((a) => pc.wantedParks.filter((b) => b !== a).map((b) => ({ kind: "hop" as const, parkIds: [a, b] as [string, string] }))) : [];
  const useWithin = pc.input.context.ticket?.usage?.useWithinDays ?? null;

  let beam: { slots: Slot[]; used: number; first: number | null }[] = [{ slots: [], used: 0, first: null }];
  let considered = 0;
  let limited = false;
  pc.dates.forEach((d, i) => {
    const pin = prefs.pins.find((p) => p.date === d.date);
    let options: Slot[];
    if (pin) options = [pin.plan.kind === "rest" ? { kind: "none" } : pin.plan.kind === "park" ? { kind: "park", parkId: pin.plan.parkId } : { kind: "hop", parkIds: pin.plan.parkIds }];
    else if (d.blocked) options = [{ kind: "none" }];
    else options = [{ kind: "none" }, ...parkOptions, ...hopOptions];
    const next: typeof beam = [];
    for (const b of beam) {
      for (const o of options) {
        considered++;
        if (o.kind !== "none") {
          if (d.blocked && !pin) continue;
          if (b.used + 1 > pc.parkDaysAllowed) continue;
          if (useWithin !== null && b.first !== null && i - b.first + 1 > useWithin) continue;
        }
        if (!pin && !validSlot(pc, d.date, o)) continue;
        next.push({ slots: [...b.slots, o], used: b.used + (o.kind === "none" ? 0 : 1), first: o.kind !== "none" && b.first === null ? i : b.first });
      }
    }
    // Rank partial allocations by their estimate (plus the remaining potential), keep the beam.
    const scored = next.map((n) => ({ n, s: allocationEstimate(pc, [...n.slots, ...pc.dates.slice(i + 1).map(() => ({ kind: "none" }) as Slot)]) }));
    scored.sort((a, b) => b.s - a.s || a.n.slots.map(slotKey).join(",").localeCompare(b.n.slots.map(slotKey).join(",")));
    if (scored.length > LIMITS.beamWidth) limited = true;
    beam = scored.slice(0, LIMITS.beamWidth).map((x) => x.n);
  });
  const allocations = beam
    .map((b) => ({ slots: b.slots, estimate: allocationEstimate(pc, b.slots) }))
    .sort((a, b) => b.estimate - a.estimate || a.slots.map(slotKey).join(",").localeCompare(b.slots.map(slotKey).join(",")));
  return { allocations, considered, limited };
}

// ───────────────────────────── 3. Day scheduling ─────────────────────────────

interface Fixed {
  start: number;
  end: number;
  item: PlannedItem;
  /** Area to walk to before it (null = transfer outside the park). */
  areaId: string | null;
  transferMin: number;
}

interface DayResult {
  day: DayPlan;
  scheduled: Set<string>;
}

function waitFor(pc: PlanContext, a: Activity, date: IsoDate): { min: number; basis: PlannedItem["waitBasis"]; label: { label: string; status: DerivedInfoStatus } | null } {
  if (a.category === "spectacular") return { min: 30, basis: "none", label: { label: "Arrive ~30 min early for a viewing spot (assumed)", status: "estimated" } };
  if (a.category === "show" || a.category === "walkthrough" || a.custom) return { min: a.category === "show" ? 10 : 0, basis: "none", label: null };
  const entries = pc.input.parkInfo.waits.filter((w) => w.attractionId === a.id && (w.kind === "your_estimate" || w.kind === "predicted"));
  const e = entries.find((w) => w.date === date) ?? entries.find((w) => w.date === null);
  if (e) {
    const st = effectiveStatus(e.provenance, pc.today, pc.staleAfterDays);
    const what = e.provenance.status === "illustrative" ? "illustrative demo value" : e.kind === "predicted" ? "prediction" : "your estimate";
    return { min: e.minutes, basis: e.kind === "predicted" ? "predicted" : "your_estimate", label: { label: `Wait ${e.minutes} min (${what})`, status: st } };
  }
  const crowd = pc.input.parkInfo.crowds.find((c) => c.date === date && c.parkId === a.parkId);
  const factor = crowd ? CROWD_FACTOR[crowd.level] : 1;
  const min = Math.round(pc.input.prefs.waitBufferMin * factor);
  return {
    min,
    basis: "assumed_buffer",
    label: { label: `Wait unknown: ${min}-min planning buffer${crowd ? ` (scaled for your "${crowd.level}" crowd estimate)` : ""}`, status: "unavailable" },
  };
}

function attractionOpen(pc: PlanContext, a: Activity, date: IsoDate): { closed: string | null; window: [number, number] | null } {
  const c = pc.input.parkInfo.closures.find((x) => x.attractionId === a.id && x.from <= date && date <= x.to);
  if (c) return { closed: `closed ${formatShortDate(c.from)}–${formatShortDate(c.to)} (${c.provenance.source})`, window: null };
  const h = pc.input.parkInfo.attractionHours.find((x) => x.attractionId === a.id && (x.date === date || x.date === null));
  return { closed: null, window: h ? [toMin(h.start), toMin(h.end)] : null };
}

function fixedEvents(pc: PlanContext, date: IsoDate, parkIds: string[], win: { start: number; end: number }): { fixed: Fixed[]; notes: string[]; conflicts: string[] } {
  const info = pc.input.parkInfo;
  const prefs = pc.input.prefs;
  const items: Fixed[] = [];
  const notes: string[] = [];
  const conflicts: string[] = [];
  const st = (p: InfoProvenance) => effectiveStatus(p, pc.today, pc.staleAfterDays);
  for (const d of info.dining.filter((x) => x.date === date)) {
    const start = toMin(d.time);
    const inPark = d.parkId !== null && parkIds.includes(d.parkId);
    const transfer = inPark ? 0 : OFFSITE_DINING_TRANSFER_MIN;
    items.push({
      start,
      end: start + d.durationMin,
      areaId: null,
      transferMin: transfer,
      item: {
        kind: "dining",
        start,
        end: start + d.durationMin,
        title: d.name,
        parkId: d.parkId ?? undefined,
        travelMin: transfer,
        waitMin: 0,
        waitBasis: "none",
        durationMin: d.durationMin,
        basis: [{ label: `Reservation ${fmtTime(start)} (${d.provenance.source})`, status: st(d.provenance) }],
        notes: inPark ? [] : [`Outside today's park: about ${transfer} min each way (estimated).`],
      },
    });
  }
  for (const l of info.lightningLane.filter((x) => x.date === date)) {
    const a = attractionById.get(l.attractionId);
    if (!a || !parkIds.includes(a.parkId)) continue;
    if (prefs.attractions[a.id] === "avoid") {
      notes.push(`Lightning Lane for ${a.name} not used: you chose to skip it.`);
      continue;
    }
    const start = toMin(l.start);
    const dur = a.durationMin + 10;
    items.push({
      start,
      end: start + dur,
      areaId: a.areaId,
      transferMin: 0,
      item: {
        kind: "lightning_lane",
        start,
        end: start + dur,
        title: `${a.name} (Lightning Lane)`,
        attractionId: a.id,
        areaId: a.areaId,
        parkId: a.parkId,
        travelMin: 0,
        waitMin: 10,
        waitBasis: "lightning_lane",
        durationMin: a.durationMin,
        priority: prefs.attractions[a.id] === "must" ? "must" : prefs.attractions[a.id] === "want" ? "want" : "optional",
        basis: [{ label: `Your return window ${fmtTime(start)}–${fmtTime(toMin(l.end))} (${l.provenance.source}); 10-min Lightning Lane wait assumed`, status: st(l.provenance) }],
        notes: [],
      },
    });
  }
  if (prefs.middayBreak) {
    const start = Math.max(win.start, 13 * 60);
    items.push({
      start,
      end: start + prefs.middayBreakMin,
      areaId: null,
      transferMin: 0,
      item: { kind: "break", start, end: start + prefs.middayBreakMin, title: "Midday rest (your preference; includes getting to your rest spot)", travelMin: 0, waitMin: 0, waitBasis: "none", durationMin: prefs.middayBreakMin, basis: [], notes: [] },
    });
  }
  if (prefs.flexibleAfternoons && win.start < 16 * 60 && win.end > 14 * 60) {
    const start = Math.max(win.start, 14 * 60);
    const end = Math.min(win.end, 16 * 60);
    items.push({ start, end, areaId: null, transferMin: 0, item: { kind: "flexible", start, end, title: "Flexible time (kept free as you asked)", travelMin: 0, waitMin: 0, waitBasis: "none", durationMin: end - start, basis: [], notes: [] } });
  }
  // Fixed items may not overlap each other: the first (earliest-starting) one wins; the clash is reported.
  items.sort((a, b) => a.start - b.start || a.item.kind.localeCompare(b.item.kind));
  const kept: Fixed[] = [];
  for (const f of items) {
    const prev = kept[kept.length - 1];
    if (prev && f.start - f.transferMin < prev.end + (prev.transferMin && prev.item.kind === "dining" ? prev.transferMin : 0)) {
      if (f.item.kind === "flexible" || f.item.kind === "break") {
        // Preferences give way to reservations.
        const start = prev.end + prev.transferMin;
        if (start + 30 <= f.end) kept.push({ ...f, start, item: { ...f.item, start, durationMin: f.end - start } });
        continue;
      }
      conflicts.push(`${formatShortDate(date)}: "${f.item.title}" at ${fmtTime(f.start)} overlaps "${prev.item.title}" at ${fmtTime(prev.start)}. Only the earlier one is planned; change one of them.`);
      continue;
    }
    kept.push(f);
  }
  for (const f of kept) {
    if (f.start < win.start || f.end > win.end) notes.push(`"${f.item.title}" at ${fmtTime(f.start)} is outside the day's window (${fmtTime(win.start)}–${fmtTime(win.end)}); it is kept because it is a reservation or your own block.`);
  }
  return { fixed: kept, notes, conflicts };
}

type Ordering = Activity[];

function orderings(acts: Activity[], parkId: string, prefs: Preferences): Ordering[] {
  const prio = (a: Activity) => (a.priority === "must" ? 0 : a.priority === "want" ? 1 : 2);
  const park = parkById.get(parkId)!;
  const angle = (areaId: string) => {
    const ar = park.areas.find((x) => x.id === areaId)!;
    return Math.atan2(ar.x, ar.y);
  };
  const sweep = (dir: 1 | -1) =>
    [...acts].sort((a, b) => dir * (angle(a.areaId) - angle(b.areaId)) || prio(a) - prio(b) || a.id.localeCompare(b.id));
  // Priority-weighted nearest neighbour from the entrance.
  const nn: Activity[] = [];
  const left = [...acts].sort((a, b) => prio(a) - prio(b) || a.id.localeCompare(b.id));
  let at: string | null = null;
  const seen = new Set<string>();
  const bonus = { must: 25, want: 10, optional: 0 };
  while (left.length) {
    let best = 0;
    let bestCost = Infinity;
    left.forEach((a, i) => {
      const revisit = at !== a.areaId && seen.has(a.areaId) ? (prefs.priorities.reduceBacktracking ? 30 : 15) : 0;
      const cost = walkMinutes(parkId, at, a.areaId, prefs.mobility) * (prefs.priorities.minimizeWalking ? 2 : 1) + revisit - bonus[a.priority];
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    });
    const a = left.splice(best, 1)[0]!;
    if (at) seen.add(at);
    at = a.areaId;
    nn.push(a);
  }
  // Must-dos first (in walking order), then everything else: favours early must-dos when walking allows.
  const musts = nn.filter((a) => a.priority === "must");
  const mustFirst = [...musts, ...nn.filter((a) => a.priority !== "must")];
  return [nn, mustFirst, sweep(1), sweep(-1)];
}

function simulate(pc: PlanContext, date: IsoDate, parkId: string, win: { start: number; end: number }, order: Ordering, fixed: Fixed[], mealsDone: { lunch: boolean; dinner: boolean }): { items: PlannedItem[]; scheduled: Set<string>; unscheduled: DayPlan["unscheduled"]; missedBreaks: number; lateMeals: number } {
  const prefs = pc.input.prefs;
  const pace = PACE[prefs.pace];
  const items: PlannedItem[] = [];
  const scheduled = new Set<string>();
  const unscheduled: DayPlan["unscheduled"] = [];
  let t = win.start;
  let pos: string | null = null;
  let sinceBreak = 0;
  let missedBreaks = 0;
  let lateMeals = 0;
  let activityMin = 0;
  const skippedMeals: ("lunch" | "dinner")[] = [];
  const queue = [...order];
  const fx = [...fixed];
  const meals = (["lunch", "dinner"] as const).filter((m) => prefs[m] && !mealsDone[m]);
  const target = pace.target * (win.end - win.start);

  const placeMeal = (m: "lunch" | "dinner") => {
    const w = prefs[m]!;
    const start = Math.max(t, toMin(w.start));
    const dur = prefs.mealMin + pace.mealExtra;
    if (start + dur > win.end) return false;
    const nf = fx[0];
    if (nf && start + dur > nf.start - nf.transferMin) return false;
    const late = start > toMin(w.end);
    if (late) lateMeals++;
    if (start > t + 14) items.push({ kind: "flexible", start: t, end: start, title: "Free time", parkId, travelMin: 0, waitMin: 0, waitBasis: "none", durationMin: start - t, basis: [], notes: [] });
    items.push({ kind: "meal", start, end: start + dur, title: m === "lunch" ? "Lunch" : "Dinner", areaId: pos ?? undefined, parkId, travelMin: 0, waitMin: 0, waitBasis: "none", durationMin: dur, basis: [], notes: late ? ["Later than your meal window: the morning ran long."] : [] });
    t = start + dur;
    sinceBreak = 0;
    meals.splice(meals.indexOf(m), 1);
    mealsDone[m] = true;
    return true;
  };

  for (let guard = 0; guard < 500; guard++) {
    // Meals covered by a dining reservation (or, for lunch, a midday rest) in the window need no separate block.
    for (const m of [...meals]) {
      const w = prefs[m]!;
      const covered = fixed.some(
        (f) => (f.item.kind === "dining" && f.start >= toMin(w.start) - 60 && f.start <= toMin(w.end)) || (m === "lunch" && f.item.kind === "break" && f.start < toMin(w.end) && f.end > toMin(w.start)),
      );
      if (covered) {
        meals.splice(meals.indexOf(m), 1);
        mealsDone[m] = true;
        const brk = fixed.find((f) => f.item.kind === "break");
        const LUNCH_NOTE = "Lunch during your midday rest.";
        if (m === "lunch" && brk && !brk.item.notes.includes(LUNCH_NOTE) && !fixed.some((f) => f.item.kind === "dining" && f.start >= toMin(w.start) - 60 && f.start <= toMin(w.end))) brk.item.notes = [...brk.item.notes, LUNCH_NOTE];
        continue;
      }
      // A meal more than two hours past its window is dropped (and reported) rather than eaten at an odd hour.
      if (t > toMin(w.end) + 120) {
        meals.splice(meals.indexOf(m), 1);
        mealsDone[m] = true;
        skippedMeals.push(m);
      }
    }
    const nf = fx[0];
    // A meal is due once its window opens.
    const due = meals.find((m) => t >= toMin(prefs[m]!.start));
    if (due && placeMeal(due)) continue;
    if (pace.breakEvery !== Infinity && sinceBreak >= pace.breakEvery) {
      const nfx = fx[0];
      const restSoon = nfx && (nfx.item.kind === "break" || nfx.item.kind === "flexible") && nfx.start - t <= 60;
      if (restSoon) sinceBreak = 0;
      else if (t + pace.breakMin <= win.end && (!nfx || t + pace.breakMin <= nfx.start - nfx.transferMin)) {
        items.push({ kind: "break", start: t, end: t + pace.breakMin, title: "Rest break", areaId: pos ?? undefined, parkId, travelMin: 0, waitMin: 0, waitBasis: "none", durationMin: pace.breakMin, basis: [], notes: [] });
        t += pace.breakMin;
        sinceBreak = 0;
        continue;
      }
    }
    // Next activity that fits before the next fixed item and the day's end.
    let picked = -1;
    type Plan = { travel: number; begin: number; wait: ReturnType<typeof waitFor> };
    let plan: Plan | null = null;
    // An item that can only start much later (its window opens later) is deferred while something else fits now.
    let deferred = null as { i: number; plan: Plan } | null;
    for (let i = 0; i < queue.length; i++) {
      const a = queue[i]!;
      if (a.priority === "optional" && activityMin >= target) continue;
      const travel = walkMinutes(parkId, pos, a.areaId, prefs.mobility);
      const open = attractionOpen(pc, a, date);
      const wait = waitFor(pc, a, date);
      let begin = t + travel;
      // A performance's entered time is when it starts: arriving early happens before it. Rides queue inside their window.
      const performance = a.schedule === "showtimes" || a.schedule === "spectacular";
      if (open.window) begin = Math.max(begin, open.window[0] - (performance ? wait.min : 0));
      const end = begin + wait.min + a.durationMin;
      if (open.window && end > open.window[1]) continue;
      if (end > win.end) continue;
      if (nf && end + (nf.areaId ? walkMinutes(parkId, a.areaId, nf.areaId, prefs.mobility) : nf.transferMin) > nf.start) continue;
      // Don't let a meal window pass entirely while riding.
      const lateMeal = meals.find((m) => t < toMin(prefs[m]!.start) && end > toMin(prefs[m]!.end));
      if (lateMeal) continue;
      if (begin - (t + travel) > 20) {
        if (!deferred || begin < deferred.plan.begin) deferred = { i, plan: { travel, begin, wait } };
        continue;
      }
      picked = i;
      plan = { travel, begin, wait };
      break;
    }
    if (picked < 0 && deferred && (!nf || deferred.plan.begin < nf.start)) {
      picked = deferred.i;
      plan = deferred.plan;
    }
    if (picked >= 0 && plan) {
      const a = queue.splice(picked, 1)[0]!;
      const startWalk = plan.begin - plan.travel;
      if (startWalk > t + 14) {
        items.push({ kind: "flexible", start: t, end: startWalk, title: "Free time", parkId, travelMin: 0, waitMin: 0, waitBasis: "none", durationMin: startWalk - t, basis: [], notes: [] });
      }
      const begin = plan.begin;
      const total = plan.wait.min + a.durationMin;
      const area = areaOf(parkId, a.areaId);
      items.push({
        kind: a.custom ? "custom" : "attraction",
        start: begin,
        end: begin + total,
        title: a.name,
        attractionId: a.custom ? undefined : a.id,
        areaId: a.areaId,
        parkId,
        travelMin: plan.travel,
        waitMin: plan.wait.min,
        waitBasis: plan.wait.basis,
        durationMin: a.durationMin,
        priority: a.priority,
        basis: [
          ...(plan.wait.label ? [plan.wait.label] : []),
          ...(a.schedule === "showtimes" && !attractionOpen(pc, a, date).window ? [{ label: "Performance times unknown: check the schedule", status: "unavailable" as const }] : []),
          ...(a.minHeightIn && pc.input.context.party.children > 0 ? [{ label: `Reported minimum height ${a.minHeightIn} in (verify)`, status: "estimated" as const }] : []),
          ...(attractionById.get(a.id) ? advisoriesFor(attractionById.get(a.id)!, date, date).map((x) => ({ label: `Reported: ${x.text} (verify)`, status: "unavailable" as const })) : []),
          a.custom ? { label: "Your activity", status: "manual" as const } : { label: `~${a.durationMin} min (catalog estimate)`, status: "estimated" as const },
        ],
        notes: area ? [] : ["Location unknown"],
      });
      scheduled.add(a.id);
      t = begin + total;
      sinceBreak += total + plan.travel;
      activityMin += total;
      pos = a.areaId;
      continue;
    }
    if (nf) {
      fx.shift();
      const walk = nf.areaId ? walkMinutes(parkId, pos, nf.areaId, prefs.mobility) : nf.transferMin;
      const arrive = t + walk;
      if (nf.start - walk > t + 14) {
        items.push({ kind: "flexible", start: t, end: nf.start - walk, title: "Free time", parkId, travelMin: 0, waitMin: 0, waitBasis: "none", durationMin: nf.start - walk - t, basis: [], notes: [] });
      }
      const start = Math.max(nf.start, arrive);
      const item = { ...nf.item, start, end: start + (nf.end - nf.start), travelMin: walk };
      if (start > nf.start) item.notes = [...item.notes, `Reaching it takes longer than the time available; you may be ${start - nf.start} min late.`];
      items.push(item);
      if (nf.item.attractionId) scheduled.add(nf.item.attractionId);
      t = item.end + (nf.item.kind === "dining" ? nf.transferMin : 0);
      if (nf.areaId) pos = nf.areaId;
      if (nf.item.kind === "break" || nf.item.kind === "flexible" || nf.item.kind === "dining") sinceBreak = 0;
      else sinceBreak += item.end - item.start;
      continue;
    }
    // Nothing else fits. A meal still due is placed if possible, then the day ends.
    const pending = meals.find((m) => toMin(prefs[m]!.start) < win.end);
    if (pending && placeMeal(pending)) continue;
    break;
  }
  if (pace.breakEvery !== Infinity && sinceBreak > pace.breakEvery + 60) missedBreaks++;
  for (const a of queue) {
    if (a.priority === "optional") continue;
    const open = attractionOpen(pc, a, date);
    const need = waitFor(pc, a, date).min + a.durationMin;
    unscheduled.push({
      id: a.id,
      name: a.name,
      reason: open.window
        ? `didn't fit within its known operating window (${fmtTime(open.window[0])}–${fmtTime(open.window[1])}) alongside the day's other plans`
        : `didn't fit in the day: it needs about ${need} min (wait + experience) and the day ran out of time after ${a.priority === "must" ? "other must-dos, " : ""}meals, breaks and reservations`,
    });
  }
  items.sort((a, b) => a.start - b.start);
  for (const m of skippedMeals) {
    unscheduled.push({ id: `meal-${m}`, name: m === "lunch" ? "Lunch" : "Dinner", reason: "no room near your meal window (reservations or rest blocks fill it); adjust the day or the window" });
    lateMeals++;
  }
  return { items, scheduled, unscheduled, missedBreaks, lateMeals };
}

function backtracks(items: PlannedItem[]): number {
  const seq = items.filter((i) => i.areaId).map((i) => i.areaId!);
  const left = new Set<string>();
  let n = 0;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] !== seq[i - 1]) {
      left.add(seq[i - 1]!);
      if (left.has(seq[i]!)) n++;
    }
  }
  return n;
}

function dayScore(pc: PlanContext, r: ReturnType<typeof simulate>, win: { start: number; end: number }): number {
  const walk = r.items.reduce((t, i) => t + i.travelMin, 0);
  const activity = r.items.filter((i) => i.kind === "attraction" || i.kind === "custom" || i.kind === "lightning_lane").reduce((t, i) => t + (i.end - i.start), 0);
  const must = r.items.filter((i) => i.priority === "must").length;
  const want = r.items.filter((i) => i.priority === "want").length;
  const opt = r.items.filter((i) => i.priority === "optional").length;
  const bt = backtracks(r.items);
  const util = (walk + activity) / Math.max(1, win.end - win.start);
  const target = PACE[pc.input.prefs.pace].target;
  const w = pc.input.prefs.priorities;
  // Must-dos earlier in the day leave room for the unexpected (waits, weather); weighed against walking, not forced.
  const mustLateHours = r.items.filter((i) => i.priority === "must" && i.kind !== "lightning_lane" && !attractionOpen(pc, { id: i.attractionId ?? "" } as Activity, "").window).reduce((t, i) => t + Math.max(0, i.start - win.start) / 60, 0);
  return must * 100 + want * 30 + opt * (w.maximizeAttractions ? 8 : 4) - walk * (w.minimizeWalking ? 1.5 : 0.6) - bt * (w.reduceBacktracking ? 25 : 10) - Math.max(0, util - target) * 200 - r.missedBreaks * 20 - r.lateMeals * 15 - mustLateHours * MUST_LATENESS_PER_HOUR;
}

function scheduleDay(pc: PlanContext, date: IsoDate, slot: Slot, pool: Map<string, Activity[]>): DayResult {
  const parkIds = slotParks(slot);
  const notes: string[] = [];
  const allItems: PlannedItem[] = [];
  const scheduled = new Set<string>();
  const unscheduled: DayPlan["unscheduled"] = [];
  const firstWin = windowFor(pc, date, parkIds[0]!);
  let win = { start: firstWin.start, end: firstWin.end };
  let windowInfo: DayPlan["window"] = { start: firstWin.start, end: firstWin.end, basis: firstWin.basis, detail: firstWin.detail };
  const dayFixed = fixedEvents(pc, date, parkIds, win);
  pc.conflicts.push(...dayFixed.conflicts);
  notes.push(...dayFixed.notes);
  const mealsDone = { lunch: false, dinner: false };
  const halves: { parkId: string; start: number; end: number }[] = [];
  if (slot.kind === "hop") {
    const second = windowFor(pc, date, parkIds[1]!);
    // Hop around the middle of the day, but never through a rest block or a first-park commitment.
    let split = Math.round((win.start + Math.min(win.end, second.end)) / 2 / 15) * 15;
    for (const f of dayFixed.fixed) {
      const blocksSplit = (f.item.kind === "break" || f.item.kind === "flexible") && f.start < split && f.end > split;
      const firstParkLater = f.item.parkId === parkIds[0] && f.end > split;
      if (blocksSplit || firstParkLater) split = Math.max(split, f.end);
    }
    halves.push({ parkId: parkIds[0]!, start: win.start, end: split });
    halves.push({ parkId: parkIds[1]!, start: Math.max(split + HOP_TRANSFER_MIN, second.start), end: second.end });
    windowInfo = { start: win.start, end: second.end, basis: firstWin.basis === "park_hours" && second.basis === "park_hours" ? "park_hours" : firstWin.basis === "illustrative_hours" ? "illustrative_hours" : "planning_window", detail: `${firstWin.detail} Then ${parkById.get(parkIds[1]!)!.name}: ${second.detail}` };
    win = { start: win.start, end: second.end };
  } else {
    halves.push({ parkId: parkIds[0]!, start: win.start, end: win.end });
  }
  let missed = 0;
  halves.forEach((h, idx) => {
    if (idx === 1) {
      allItems.push({ kind: "transfer", start: halves[0]!.end, end: halves[0]!.end + HOP_TRANSFER_MIN, title: `Park hop to ${parkById.get(h.parkId)!.name}`, parkId: h.parkId, travelMin: 0, waitMin: 0, waitBasis: "none", durationMin: HOP_TRANSFER_MIN, basis: [{ label: `About ${HOP_TRANSFER_MIN} min between parks (estimated)`, status: "estimated" }], notes: [] });
    }
    const candidates = (pool.get(h.parkId) ?? []).slice(0, LIMITS.maxAttractionsPerDay);
    const usable: Activity[] = [];
    for (const a of candidates) {
      const open = attractionOpen(pc, a, date);
      if (open.closed) {
        if (a.priority !== "optional") unscheduled.push({ id: a.id, name: a.name, reason: open.closed });
        continue;
      }
      if (a.schedule === "spectacular" && !open.window) {
        unscheduled.push({ id: a.id, name: a.name, reason: "its showtime isn't known: add it under “What you already know → Show and attraction times” to plan it" });
        continue;
      }
      if (dayFixed.fixed.some((f) => f.item.attractionId === a.id)) continue;
      usable.push(a);
    }
    // Each fixed item belongs to the half of the day it starts in.
    const from = idx === 0 ? -Infinity : halves[0]!.end;
    const to = idx === halves.length - 1 ? Infinity : h.end;
    const fixed = dayFixed.fixed.filter((f) => f.start >= from && f.start < to);
    let best: ReturnType<typeof simulate> | null = null;
    let bestScore = -Infinity;
    for (const order of orderings(usable, h.parkId, pc.input.prefs)) {
      const r = simulate(pc, date, h.parkId, h, order, fixed, { ...mealsDone });
      const s = dayScore(pc, r, h);
      if (s > bestScore) {
        best = r;
        bestScore = s;
      }
    }
    const r = best ?? simulate(pc, date, h.parkId, h, [], fixed, { ...mealsDone });
    // Say why a must-do ended up late in the day (no silent deprioritisation).
    const mustsInOrder = r.items.filter((i) => i.priority === "must");
    mustsInOrder.forEach((i, k) => {
      if (i.start - h.start < 180 || i.kind === "lightning_lane") return;
      const win = i.attractionId ? attractionOpen(pc, { id: i.attractionId } as Activity, date).window : null;
      const area = i.areaId ? areaOf(h.parkId, i.areaId)?.name : undefined;
      i.notes.push(
        win && win[0] >= i.start - 30
          ? `Planned for ${fmtTime(i.start)}: its operating window starts at ${fmtTime(win[0])}.`
          : k >= 2
            ? `Planned later in the day: ${k} other must-dos come first, and the planner weighs earlier must-dos against extra walking.`
            : `Planned later in the day to group it with nearby attractions${area ? ` in ${area}` : ""} and limit walking. Fix the order by making it a Lightning Lane window or a reservation if you need it earlier.`,
      );
    });
    for (const i of r.items) if (i.kind === "meal") mealsDone[i.title === "Lunch" ? "lunch" : "dinner"] = true;
    allItems.push(...r.items);
    r.scheduled.forEach((id) => scheduled.add(id));
    unscheduled.push(...r.unscheduled.filter((u) => !scheduled.has(u.id)));
    missed += r.missedBreaks;
  });
  allItems.sort((a, b) => a.start - b.start);
  const lastEnd = allItems.length ? Math.max(...allItems.map((i) => i.end)) : win.start;
  if (win.end - lastEnd >= 60) notes.push(`Nothing planned from ${fmtTime(lastEnd)} to ${fmtTime(win.end)}: free time, or room for more if you want a busier day.`);
  const walkingMin = allItems.reduce((t, i) => t + (i.kind === "dining" ? 0 : i.travelMin), 0);
  const activityItems = allItems.filter((i) => i.kind === "attraction" || i.kind === "custom" || i.kind === "lightning_lane");
  if (missed) notes.push("A long stretch without a break: consider adding one.");
  return {
    day: {
      date,
      kind: slot.kind === "hop" ? "hop" : "park",
      parkIds,
      window: windowInfo,
      items: allItems,
      walkingMin,
      activityMin: activityItems.reduce((t, i) => t + (i.end - i.start), 0),
      waitMin: activityItems.reduce((t, i) => t + i.waitMin, 0),
      backtracks: backtracks(allItems),
      intensity: activityItems.reduce((t, i) => t + (i.attractionId ? (attractionById.get(i.attractionId)?.intensity ?? 1) : 1), 0),
      notes,
      unscheduled: dedupe(unscheduled),
    },
    scheduled,
  };
}

const dedupe = <T extends { id: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.id, x])).values()];

// ───────────────────────────── 4. Scoring ─────────────────────────────

const SCORE_MEANING =
  "The score measures how well this plan fits your stated priorities with the information available: must-do coverage, other preferences, walking and backtracking, pacing, and how much of the plan rests on known rather than assumed data. It is not a measure of how good the vacation will be, and it can't account for real waits, weather or closures you haven't entered.";

export function weightsFor(prefs: Preferences): Record<ScoreComponent["key"], number> {
  const w = { must_do: 35, preferences: 20, travel: 15, pacing: 20, certainty: 10 };
  if (prefs.priorities.minimizeWalking) w.travel += 15;
  if (prefs.priorities.reduceBacktracking) w.travel += 10;
  if (prefs.priorities.maximizeAttractions) w.preferences += 15;
  if (prefs.priorities.relaxedSchedule) w.pacing += 15;
  return w;
}

function score(pc: PlanContext, days: DayPlan[], coverage: Itinerary["coverage"], optional: { scheduled: number; available: number }, demandingFirst: boolean): Itinerary["score"] {
  const parkDays = days.filter((d) => d.kind === "park" || d.kind === "hop");
  if (!parkDays.length) return null;
  const prefs = pc.input.prefs;
  const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
  const mustScore = coverage.must.total ? (100 * coverage.must.scheduled) / coverage.must.total : 100;
  const wantRatio = coverage.want.total ? coverage.want.scheduled / coverage.want.total : 1;
  const parkRatio = coverage.parksRequested.length ? coverage.parksRequested.filter((p) => coverage.parksVisited.includes(p)).length / coverage.parksRequested.length : 1;
  const optRatio = Math.min(1, optional.scheduled / Math.max(1, optional.available * 0.3));
  const prefScore = 70 * wantRatio + 20 * parkRatio + 10 * optRatio;
  const walk = parkDays.reduce((t, d) => t + d.walkingMin, 0);
  const act = parkDays.reduce((t, d) => t + d.activityMin, 0);
  const bt = parkDays.reduce((t, d) => t + d.backtracks, 0);
  const travelScore = 100 * (1 - (2 * walk) / Math.max(1, walk + act)) - bt * (prefs.priorities.reduceBacktracking ? 12 : 6);
  const target = PACE[prefs.pace].target;
  const pacingPerDay = parkDays.map((d) => {
    const util = (d.activityMin + d.walkingMin) / Math.max(1, d.window.end - d.window.start);
    const late = d.items.filter((i) => i.kind === "meal" && i.notes.length).length;
    return 100 - 150 * Math.max(0, util - target) - (d.notes.some((n) => n.startsWith("A long stretch")) ? 15 : 0) - late * 10;
  });
  const pacingScore = pacingPerDay.reduce((a, b) => a + b, 0) / pacingPerDay.length - (demandingFirst ? 15 : 0);
  const knownHours = parkDays.filter((d) => d.window.basis === "park_hours").length / parkDays.length;
  const rideItems = parkDays.flatMap((d) => d.items.filter((i) => i.kind === "attraction"));
  const assumedWait = rideItems.length ? rideItems.filter((i) => i.waitBasis === "assumed_buffer").length / rideItems.length : 0;
  const certaintyScore = 100 - 50 * (1 - knownHours) - 50 * assumedWait;
  const w = weightsFor(prefs);
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const pct = (k: keyof typeof w) => Math.round((100 * w[k]) / total);
  const components: ScoreComponent[] = [
    { key: "must_do", label: "Must-do coverage", score: clamp(mustScore), weightPct: pct("must_do"), detail: `${coverage.must.scheduled} of ${coverage.must.total} must-dos scheduled` },
    { key: "preferences", label: "Other preferences", score: clamp(prefScore), weightPct: pct("preferences"), detail: `${coverage.want.scheduled} of ${coverage.want.total} "would like" items; ${coverage.parksVisited.length} of ${coverage.parksRequested.length || coverage.parksVisited.length} requested parks; ${optional.scheduled} extra attractions` },
    { key: "travel", label: "Walking & backtracking", score: clamp(travelScore), weightPct: pct("travel"), detail: `${walk} min walking (estimated) for ${act} min of activities; ${bt} backtrack${bt === 1 ? "" : "s"}` },
    { key: "pacing", label: "Pacing & breaks", score: clamp(pacingScore), weightPct: pct("pacing"), detail: `Busy-ness target for "${prefs.pace}" pace: ${Math.round(target * 100)}% of the day${demandingFirst ? "; the most demanding day is the first park day" : ""}` },
    { key: "certainty", label: "Data certainty", score: clamp(certaintyScore), weightPct: pct("certainty"), detail: `${Math.round(knownHours * 100)}% of park days have entered park hours; ${Math.round(assumedWait * 100)}% of rides use an assumed wait buffer` },
  ];
  const sum = components.reduce((t, c) => t + c.score * w[c.key], 0) / total;
  return { total: Math.round(sum), components, meaning: SCORE_MEANING };
}

// ───────────────────────────── 5. Independent check ─────────────────────────────

/** Re-check hard constraints on a finished itinerary. Any violation makes it infeasible. */
export function verifyItinerary(input: ItineraryInput, it: Pick<Itinerary, "days">): string[] {
  const errors: string[] = [];
  const ctx = input.context;
  const usage = ctx.ticket?.usage ?? null;
  const parkDays = it.days.filter((d) => d.kind === "park" || d.kind === "hop");
  if (parkDays.length && !ctx.ticket) errors.push("Park days planned without park tickets.");
  if (ctx.ticket && parkDays.length > ctx.ticket.days) errors.push(`${parkDays.length} park days planned but the ticket has ${ctx.ticket.days}.`);
  if (parkDays.some((d) => d.kind === "hop") && !ctx.ticket?.hopper) errors.push("A park-hop day was planned but the ticket doesn't include Park Hopper.");
  if (usage?.useWithinDays && parkDays.length) {
    const span = daysBetween(parkDays[0]!.date, parkDays[parkDays.length - 1]!.date) + 1;
    if (span > usage.useWithinDays) errors.push(`Park days span ${span} days but the ticket must be used within ${usage.useWithinDays}.`);
  }
  for (const d of parkDays) {
    if (d.date < ctx.arrival || d.date > ctx.departure) errors.push(`${d.date} is outside the trip.`);
    if (usage?.blockoutDates?.includes(d.date)) errors.push(`${d.date} is blocked out for the ticket.`);
    if (usage?.expiresOn && d.date > usage.expiresOn) errors.push(`${d.date} is after the ticket expires.`);
    const res = input.parkInfo.parkReservations.filter((r) => r.date === d.date);
    if (res.length && d.parkIds.some((p) => !res.some((r) => r.parkId === p))) errors.push(`${d.date}: planned park doesn't match your park reservation.`);
    let prevEnd = -1;
    for (const i of d.items) {
      if (i.end < i.start) errors.push(`${d.date}: "${i.title}" ends before it starts.`);
      if (i.start - (i.kind === "dining" ? 0 : i.travelMin) < prevEnd) errors.push(`${d.date}: "${i.title}" overlaps the previous item.`);
      prevEnd = i.end + (i.kind === "dining" && i.travelMin ? i.travelMin : 0);
      const fixed = i.kind === "dining" || i.kind === "lightning_lane" || i.kind === "break" || i.kind === "flexible";
      if (!fixed && (i.start < d.window.start || i.end > d.window.end)) errors.push(`${d.date}: "${i.title}" is outside the day's window.`);
      if (i.attractionId) {
        if (input.prefs.attractions[i.attractionId] === "avoid") errors.push(`${d.date}: "${i.title}" was scheduled although you chose to skip it.`);
        const closed = input.parkInfo.closures.find((c) => c.attractionId === i.attractionId && c.from <= d.date && d.date <= c.to);
        if (closed) errors.push(`${d.date}: "${i.title}" is closed that day.`);
        const h = input.parkInfo.attractionHours.find((x) => x.attractionId === i.attractionId && (x.date === d.date || x.date === null));
        const performance = ["showtimes", "spectacular"].includes(attractionById.get(i.attractionId)?.schedule ?? "");
        if (h && i.kind === "attraction" && (i.start + (performance ? i.waitMin : 0) < toMin(h.start) || i.end > toMin(h.end))) errors.push(`${d.date}: "${i.title}" is outside its operating window.`);
        if (!d.parkIds.includes(attractionById.get(i.attractionId)?.parkId ?? "")) errors.push(`${d.date}: "${i.title}" is not in the park planned for that day.`);
      }
    }
  }
  return errors;
}

// ───────────────────────────── Entry point ─────────────────────────────

export interface PlanOptions {
  today: IsoDate;
  /** User-entered park information older than this is shown as stale. */
  staleAfterDays?: number;
}

export function planItinerary(input: ItineraryInput, opts: PlanOptions): Itinerary {
  const { context: ctx, prefs, parkInfo } = input;
  const staleAfterDays = opts.staleAfterDays ?? 30;
  const conflicts: string[] = [];
  const infeasible: string[] = [];
  const assumptions: string[] = [];
  const unknowns: string[] = [];
  const inputHash = stableHash({ input, engine: ITINERARY_ENGINE_VERSION, today: opts.today, staleAfterDays });
  const dates = tripDates(ctx);
  if (daysBetween(ctx.arrival, ctx.departure) >= LIMITS.maxTripDays) {
    conflicts.push(`Only the first ${LIMITS.maxTripDays} days of the trip are planned (search limit).`);
  }

  // Reference checks: unknown ids are reported and ignored.
  for (const id of Object.keys(prefs.attractions)) if (!attractionById.has(id)) conflicts.push(`Unknown attraction "${id}" was ignored.`);
  for (const p of prefs.parks) if (!parkById.has(p)) conflicts.push(`Unknown park "${p}" was ignored.`);
  for (const c of prefs.custom) if (!areaOf(c.parkId, c.areaId)) conflicts.push(`Activity "${c.name}" has an unknown park or area and was ignored.`);

  const wantedParks = (() => {
    const explicit = prefs.parks.filter((p) => parkById.has(p));
    if (explicit.length) return explicit;
    const fromPrefs = PARKS.filter((p) => ATTRACTIONS.some((a) => a.parkId === p.id && (prefs.attractions[a.id] === "must" || prefs.attractions[a.id] === "want"))).map((p) => p.id);
    return fromPrefs.length ? fromPrefs : PARKS.map((p) => p.id);
  })();
  if (!prefs.parks.length) assumptions.push(`No parks chosen: planning for ${wantedParks.map((p) => parkById.get(p)!.name).join(", ")}${wantedParks.length < PARKS.length ? " (the parks with attractions you marked)" : ""}.`);

  if (!ctx.ticket) infeasible.push("This trip has no park tickets (0 park days), so there are no park days to plan.");
  const parkDaysAllowed = Math.min(ctx.ticket?.days ?? 0, prefs.maxParkDays ?? Infinity);
  const usage = ctx.ticket?.usage ?? null;
  if (ctx.ticket) {
    if (!usage) unknowns.push("Your ticket's usage rules (use-within window, expiration, blocked dates, park reservation requirement) aren't recorded; none are assumed. Add a ticket rule on Price data if you know them.");
    else {
      if (usage.useWithinDays === null) unknowns.push("The ticket's use-within window is unknown.");
      if (usage.parkReservationRequired === null) unknowns.push("Whether park reservations are required is unknown; check before your trip.");
    }
    if (!ctx.ticket.hopper && prefs.allowHopping) conflicts.push("Park hopping was requested, but the trip's ticket doesn't include Park Hopper: one park per day.");
    if (prefs.maxParkDays !== null && prefs.maxParkDays < ctx.ticket.days) assumptions.push(`Using ${prefs.maxParkDays} of the ticket's ${ctx.ticket.days} park days, as you asked.`);
  }

  // Commitments that tie a date to a park.
  const required = new Map<IsoDate, Set<string>>();
  const add = (date: IsoDate, park: string) => required.set(date, new Set([...(required.get(date) ?? []), park]));
  for (const d of parkInfo.dining) {
    if (d.date < ctx.arrival || d.date > ctx.departure) conflicts.push(`Dining "${d.name}" on ${d.date} is outside the trip and was ignored.`);
    else if (d.parkId && parkById.has(d.parkId)) add(d.date, d.parkId);
  }
  for (const l of parkInfo.lightningLane) {
    const a = attractionById.get(l.attractionId);
    if (!a) conflicts.push(`Lightning Lane entry for an unknown attraction was ignored.`);
    else if (l.date < ctx.arrival || l.date > ctx.departure) conflicts.push(`Lightning Lane for ${a.name} on ${l.date} is outside the trip and was ignored.`);
    else add(l.date, a.parkId);
  }
  const reserved = new Map<IsoDate, Set<string>>();
  for (const r of parkInfo.parkReservations) {
    reserved.set(r.date, new Set([...(reserved.get(r.date) ?? []), r.parkId]));
    if (r.date >= ctx.arrival && r.date <= ctx.departure && parkById.has(r.parkId)) add(r.date, r.parkId);
  }

  // Pins are hard constraints: validate them.
  for (const pin of prefs.pins) {
    const di = dates.find((d) => d.date === pin.date);
    if (!di) {
      infeasible.push(`You fixed ${pin.date}, which is not a day of this trip.`);
      continue;
    }
    if (pin.plan.kind === "rest") continue;
    if (di.blocked) infeasible.push(`You fixed a park day on ${formatShortDate(pin.date)}, but it is ${di.blocked}.`);
    if (pin.plan.kind === "hop" && !ctx.ticket?.hopper) infeasible.push(`You fixed a park-hop day on ${formatShortDate(pin.date)}, but the ticket doesn't include Park Hopper.`);
    const parks = pin.plan.kind === "park" ? [pin.plan.parkId] : pin.plan.parkIds;
    for (const p of parks) if (!parkById.has(p)) infeasible.push(`Unknown park on ${pin.date}.`);
    const req = required.get(pin.date);
    if (req) for (const p of req) if (!parks.includes(p)) conflicts.push(`${formatShortDate(pin.date)}: you fixed ${parks.map((x) => parkById.get(x)?.name).join(" + ")}, but you have a reservation at ${parkById.get(p)?.name}.`);
  }
  const pinnedParkDays = prefs.pins.filter((p) => p.plan.kind !== "rest").length;
  if (ctx.ticket && pinnedParkDays > parkDaysAllowed) infeasible.push(`You fixed ${pinnedParkDays} park days, but only ${parkDaysAllowed} are available on the ticket.`);
  if (usage?.useWithinDays) {
    const pinned = prefs.pins.filter((p) => p.plan.kind !== "rest").map((p) => p.date).sort();
    if (pinned.length > 1 && daysBetween(pinned[0]!, pinned[pinned.length - 1]!) + 1 > usage.useWithinDays) {
      infeasible.push(`Your fixed park days span more than the ticket's ${usage.useWithinDays}-day use window.`);
    }
  }
  if (usage?.parkReservationRequired === true) {
    unknowns.push("Your ticket requires park reservations. The planner can't check availability: park days without a reservation you entered are marked as needing one.");
  }

  const pool0 = activities(input, wantedParks);
  const demand = new Map<string, { must: number; want: number; optional: number; intensity: number }>();
  for (const a of pool0) {
    const d = demand.get(a.parkId) ?? { must: 0, want: 0, optional: 0, intensity: 0 };
    const minutes = a.durationMin + (a.category === "show" || a.category === "walkthrough" || a.custom ? 5 : prefs.waitBufferMin) + 8;
    d[a.priority] += minutes;
    if (a.priority !== "optional") d.intensity += a.intensity;
    demand.set(a.parkId, d);
  }
  for (const p of wantedParks) if (!demand.has(p)) demand.set(p, { must: 0, want: 0, optional: 0, intensity: 0 });
  const dayMinutes = new Map<IsoDate, number>();
  const commitTimes = new Map<IsoDate, Map<string, number>>();
  const commit = (date: IsoDate, park: string, t: number) => {
    const m = commitTimes.get(date) ?? new Map<string, number>();
    m.set(park, Math.min(m.get(park) ?? Infinity, t));
    commitTimes.set(date, m);
  };
  for (const d of parkInfo.dining) if (d.parkId) commit(d.date, d.parkId, toMin(d.time));
  for (const l of parkInfo.lightningLane) {
    const a = attractionById.get(l.attractionId);
    if (a) commit(l.date, a.parkId, toMin(l.start));
  }
  const pc: PlanContext = { input, today: opts.today, staleAfterDays, dates, wantedParks, parkDaysAllowed, required, commitTimes, reserved, demand, dayMinutes, conflicts, infeasible };
  for (const d of dates) {
    const w = windowFor(pc, d.date, wantedParks[0] ?? "magic-kingdom");
    dayMinutes.set(d.date, w.end - w.start);
  }
  for (const [date, parks] of required) {
    const di = dates.find((d) => d.date === date);
    if (di?.blocked && !prefs.pins.some((p) => p.date === date)) conflicts.push(`You have a reservation at ${[...parks].map((p) => parkById.get(p)?.name).join(" and ")} on ${formatShortDate(date)}, but that date is ${di.blocked}.`);
    if (parks.size > 1 && !ctx.ticket?.hopper) infeasible.push(`${formatShortDate(date)}: reservations at ${[...parks].map((p) => parkById.get(p)?.name).join(" and ")} need Park Hopper, which the ticket doesn't include.`);
    if (parks.size > 1 && ctx.ticket?.hopper && !prefs.allowHopping) conflicts.push(`${formatShortDate(date)}: reservations at two parks; turn on park hopping to plan both.`);
  }

  const base = { engineVersion: ITINERARY_ENGINE_VERSION, inputHash, demo: input.demo };
  const empty = (reasons: string[], search: Itinerary["search"]): Itinerary => ({
    ...base,
    status: "infeasible",
    provisional: true,
    headline: "No feasible itinerary: see the reasons below.",
    days: [],
    coverage: { must: { total: 0, scheduled: 0, missing: [] }, want: { total: 0, scheduled: 0 }, parksRequested: wantedParks, parksVisited: [] },
    score: null,
    conflicts,
    infeasibleReasons: reasons,
    assumptions,
    unknowns,
    dataUsed: [],
    search,
  });
  const noSearch = { allocationsConsidered: 0, candidatesScheduled: 0, limited: false, note: "No search was run." };
  if (infeasible.length) return empty(infeasible, noSearch);
  const usableDates = dates.filter((d) => !d.blocked);
  if (!usableDates.length || parkDaysAllowed <= 0) return empty([`No date of this trip can be a park day (${dates.map((d) => `${formatShortDate(d.date)}: ${d.blocked}`).join("; ")}).`], noSearch);

  const { allocations, considered, limited } = allocate(pc);
  if (!allocations.length || allocations.every((a) => a.slots.every((s) => s.kind === "none"))) {
    return empty(["No allocation of park days satisfies your fixed days, reservations and ticket rules together."], { ...noSearch, allocationsConsidered: considered });
  }

  // Schedule the top allocations in full and keep the best-scoring one.
  const top = allocations.filter((a) => a.slots.some((s) => s.kind !== "none")).slice(0, LIMITS.candidatesScheduled);
  let best: { it: Itinerary; total: number } | null = null;
  for (const alloc of top) {
    const localConflicts: string[] = [];
    const pcx = { ...pc, conflicts: localConflicts };
    const it = buildFromAllocation(pcx, alloc.slots, pool0);
    it.conflicts = [...conflicts, ...localConflicts];
    const total = it.score?.total ?? -1;
    if (!best || total > best.total) best = { it, total };
  }
  const it = best!.it;
  it.inputHash = inputHash;
  it.assumptions = [...assumptions, ...it.assumptions];
  it.unknowns = [...unknowns, ...it.unknowns];
  it.search = {
    allocationsConsidered: considered,
    candidatesScheduled: top.length,
    limited,
    note: `${top.length} park-day allocation${top.length === 1 ? "" : "s"} (of ${considered.toLocaleString()} considered${limited ? `, keeping the best ${LIMITS.beamWidth} at each day` : ""}) were scheduled in full; this is the highest-scoring candidate found, not a proven optimum.`,
  };
  const errors = verifyItinerary(input, it);
  if (errors.length) {
    it.status = "infeasible";
    it.infeasibleReasons = [...it.infeasibleReasons, ...errors.map((e) => `Consistency check: ${e}`)];
    it.headline = "The planner could not produce a valid itinerary from these inputs (consistency check failed).";
    it.score = null;
  }
  return it;
}

function buildFromAllocation(pc: PlanContext, slots: Slot[], pool0: Activity[]): Itinerary {
  const { input } = pc;
  const prefs = input.prefs;
  const remaining = new Map<string, Activity[]>();
  for (const a of pool0) remaining.set(a.parkId, [...(remaining.get(a.parkId) ?? []), a]);
  const prio = (a: Activity) => (a.priority === "must" ? 0 : a.priority === "want" ? 1 : 2);
  for (const list of remaining.values()) list.sort((a, b) => prio(a) - prio(b) || a.id.localeCompare(b.id));
  const days: DayPlan[] = [];
  const done = new Set<string>();
  const lastReason = new Map<string, string>();
  slots.forEach((slot, i) => {
    const d = pc.dates[i]!;
    if (slot.kind === "none") {
      days.push({
        date: d.date,
        kind: d.blocked ? "no_park" : "rest",
        parkIds: [],
        window: { start: 0, end: 0, basis: "planning_window", detail: d.blocked ? `Not a park day: ${d.blocked}.` : "Rest or free day (no park admission used)." },
        items: [],
        walkingMin: 0,
        activityMin: 0,
        waitMin: 0,
        backtracks: 0,
        intensity: 0,
        notes: [],
        unscheduled: [],
      });
      return;
    }
    const r = scheduleDay(pc, d.date, slot, remaining);
    for (const id of r.scheduled) done.add(id);
    for (const [p, list] of remaining) remaining.set(p, list.filter((a) => !done.has(a.id)));
    for (const u of r.day.unscheduled) lastReason.set(u.id, `${formatShortDate(d.date)}: ${u.reason}`);
    r.day.unscheduled = r.day.unscheduled.filter((u) => !done.has(u.id));
    const res = input.parkInfo.parkReservations.filter((x) => x.date === d.date);
    if (input.context.ticket?.usage?.parkReservationRequired && !res.length) r.day.notes.push("Needs a park reservation (not entered). Availability is not checked.");
    days.push(r.day);
  });

  // Coverage
  const musts = pool0.filter((a) => a.priority === "must");
  const wants = pool0.filter((a) => a.priority === "want");
  const visited = [...new Set(days.flatMap((d) => d.parkIds))];
  const avoidedMust = Object.entries(prefs.attractions).filter(([id, p]) => p === "must" && attractionById.has(id) && !pc.wantedParks.includes(attractionById.get(id)!.parkId));
  const missing = [
    ...musts.filter((a) => !done.has(a.id)).map((a) => ({ id: a.id, name: a.name, reason: visited.includes(a.parkId) ? (lastReason.get(a.id) ?? "didn't fit in the time available") : `no day at ${parkById.get(a.parkId)!.name} fits the ticket and your other choices` })),
    ...avoidedMust.map(([id]) => ({ id, name: attractionById.get(id)!.name, reason: `its park (${parkById.get(attractionById.get(id)!.parkId)!.name}) isn't among the parks you chose` })),
  ];
  const coverage: Itinerary["coverage"] = {
    must: { total: musts.length + avoidedMust.length, scheduled: musts.filter((a) => done.has(a.id)).length, missing },
    want: { total: wants.length, scheduled: wants.filter((a) => done.has(a.id)).length },
    parksRequested: pc.wantedParks,
    parksVisited: visited,
  };
  const optional = { scheduled: pool0.filter((a) => a.priority === "optional" && done.has(a.id)).length, available: pool0.filter((a) => a.priority === "optional").length };

  // Most demanding day first?
  const parkDays = days.filter((d) => d.kind === "park" || d.kind === "hop");
  const demandingFirst = prefs.avoidDemandingArrivalDay && parkDays.length > 1 && parkDays[0]!.intensity === Math.max(...parkDays.map((d) => d.intensity)) && parkDays.some((d) => d.intensity < parkDays[0]!.intensity);

  const assumptions: string[] = [];
  const unknowns: string[] = [];
  if (pc.parkDaysAllowed > parkDays.length && parkDays.length > 0 && !coverage.must.missing.length) {
    assumptions.push(`Uses ${parkDays.length} of ${pc.parkDaysAllowed} available park days: everything you chose fits, and the other days are left free. Add parks or attractions, or fix days, to use more.`);
  }
  const unknownHours = parkDays.filter((d) => d.window.basis === "planning_window");
  if (unknownHours.length) unknowns.push(`Park hours are not entered for ${unknownHours.length} park day${unknownHours.length === 1 ? "" : "s"}: those days use your planning window (${prefs.dayStart}–${prefs.dayEnd}). Real hours may be shorter or longer.`);
  if (parkDays.some((d) => d.window.basis === "illustrative_hours")) assumptions.push("DEMONSTRATION: park hours and waits are illustrative, not real operating schedules or current waits.");
  const buffers = parkDays.flatMap((d) => d.items.filter((i) => i.waitBasis === "assumed_buffer"));
  if (buffers.length) assumptions.push(`Waits are unknown for ${buffers.length} ride${buffers.length === 1 ? "" : "s"}: each uses your ${prefs.waitBufferMin}-minute planning buffer (scaled only by crowd levels you entered). Actual waits will change the schedule.`);
  assumptions.push("Walking times are estimates from a schematic park map, not measured routes.");
  assumptions.push("Experience durations are approximate and exclude waits; height and accessibility requirements are not modelled.");
  if (input.context.ticket && !prefs.pins.length) assumptions.push("Which park on which day is the planner's choice: no crowd calendar is used, so no weekday is claimed to be objectively better.");
  if (prefs.lightningLane === "if_held" && !input.parkInfo.lightningLane.length) unknowns.push("Lightning Lane availability is unknown and not assumed. Enter return windows you actually hold to use them.");
  if (!input.parkInfo.lightningLaneRules) unknowns.push("Lightning Lane eligibility and rules for your trip aren't recorded.");
  const observed = input.parkInfo.waits.filter((w) => w.kind === "observed");
  if (observed.length) assumptions.push(`${observed.length} observed wait time${observed.length === 1 ? " is" : "s are"} shown for reference only: a past observation is not a forecast.`);
  if (!input.parkInfo.closures.length) unknowns.push("No closures are entered; refurbishments are not known to the planner.");
  // Reported (unconfirmed) changes for attractions you chose: shown, never applied.
  const chosen = new Set([...done, ...Object.entries(prefs.attractions).filter(([, p]) => p !== "avoid").map(([id]) => id)]);
  for (const id of chosen) {
    const x = attractionById.get(id);
    if (!x) continue;
    for (const adv of advisoriesFor(x, input.context.arrival, input.context.departure)) {
      unknowns.push(`${x.name}: ${adv.text} (${adv.source}, checked ${adv.checkedAt}). Not applied — if it's confirmed for your dates, add it as a closure under “What you already know”.`);
    }
  }
  if (input.context.party.children > 0) {
    const tall = [...done].map((id) => attractionById.get(id)).filter((x) => x?.minHeightIn);
    if (tall.length) assumptions.push(`${tall.length} planned attraction${tall.length === 1 ? " has" : "s have"} a reported minimum height (third-party guides; verify with Disney). Children's heights aren't known to the planner.`);
  }

  // Data provenance summary.
  const st = (p: InfoProvenance) => effectiveStatus(p, pc.today, pc.staleAfterDays);
  const dataUsed: Itinerary["dataUsed"] = [
    { label: "Park and attraction catalog", status: "estimated", source: CATALOG_PROVENANCE.source, observedAt: CATALOG_PROVENANCE.observedAt },
    ...input.parkInfo.hours.filter((h) => parkDays.some((d) => d.date === h.date && d.parkIds.includes(h.parkId))).map((h) => ({ label: `${parkById.get(h.parkId)?.name} hours ${h.date}`, status: st(h.provenance), source: h.provenance.source, observedAt: h.provenance.observedAt })),
    ...input.parkInfo.waits.map((w) => ({ label: `${attractionById.get(w.attractionId)?.name ?? w.attractionId}: ${w.minutes} min (${w.kind.replace("_", " ")})`, status: st(w.provenance), source: w.provenance.source, observedAt: w.provenance.observedAt })),
    ...input.parkInfo.crowds.map((c) => ({ label: `Crowd ${c.level} at ${parkById.get(c.parkId)?.name} ${c.date}`, status: st(c.provenance), source: c.provenance.source, observedAt: c.provenance.observedAt })),
    ...input.parkInfo.closures.map((c) => ({ label: `${attractionById.get(c.attractionId)?.name ?? c.attractionId} closed ${c.from}–${c.to}`, status: st(c.provenance), source: c.provenance.source, observedAt: c.provenance.observedAt })),
    ...input.parkInfo.dining.map((d) => ({ label: `Dining: ${d.name} ${d.date} ${d.time}`, status: st(d.provenance), source: d.provenance.source, observedAt: d.provenance.observedAt })),
    ...input.parkInfo.lightningLane.map((l) => ({ label: `Lightning Lane: ${attractionById.get(l.attractionId)?.name} ${l.date} ${l.start}–${l.end}`, status: st(l.provenance), source: l.provenance.source, observedAt: l.provenance.observedAt })),
    ...input.parkInfo.parkReservations.map((r) => ({ label: `Park reservation: ${parkById.get(r.parkId)?.name} ${r.date}`, status: st(r.provenance), source: r.provenance.source, observedAt: r.provenance.observedAt })),
    ...(input.context.ticket?.usageSource ? [{ label: "Ticket usage rules", status: "manual" as DerivedInfoStatus, source: input.context.ticket.usageSource, observedAt: "" }] : []),
  ];
  if (dataUsed.some((d) => d.status === "stale")) unknowns.push("Some information you entered is stale (older than the freshness setting). Re-check it.");

  const sc = score(pc, days, coverage, optional, demandingFirst);
  const status: Itinerary["status"] = parkDays.length === 0 ? "infeasible" : coverage.must.missing.length ? "partial" : "feasible";
  const provisional = input.demo || unknownHours.length > 0 || buffers.length > 0 || parkDays.some((d) => d.notes.some((n) => n.startsWith("Needs a park reservation")));
  const headline =
    status === "infeasible"
      ? "No park day could be planned."
      : `${input.demo ? "Demonstration — " : ""}Best candidate found: ${parkDays.length} park day${parkDays.length === 1 ? "" : "s"}, ${coverage.must.scheduled} of ${coverage.must.total} must-dos scheduled${provisional ? " (provisional)" : ""}.`;
  return {
    engineVersion: ITINERARY_ENGINE_VERSION,
    inputHash: "",
    status,
    provisional,
    demo: input.demo,
    headline,
    days,
    coverage,
    score: sc,
    conflicts: [],
    infeasibleReasons: status === "infeasible" ? ["No park day could be scheduled."] : [],
    assumptions,
    unknowns,
    dataUsed,
    search: { allocationsConsidered: 0, candidatesScheduled: 0, limited: false, note: "" },
  };
}

/** Same facts, different preferences: e.g. relaxed vs ride-focused. */
export interface Variant {
  label: string;
  prefs: Partial<Preferences>;
  differs: string[];
}

export const STANDARD_VARIANTS: Variant[] = [
  {
    label: "Relaxed",
    prefs: { pace: "relaxed", middayBreak: true, priorities: { minimizeWalking: true, maximizeAttractions: false, reduceBacktracking: true, relaxedSchedule: true } },
    differs: ["Relaxed pace", "Midday rest", "Less walking and backtracking"],
  },
  {
    label: "Ride-focused",
    prefs: { pace: "packed", middayBreak: false, flexibleAfternoons: false, priorities: { minimizeWalking: false, maximizeAttractions: true, reduceBacktracking: false, relaxedSchedule: false } },
    differs: ["Packed pace", "No midday rest or flexible afternoons", "Maximize attractions"],
  },
];

export function compareVariants(input: ItineraryInput, variants: Variant[], opts: PlanOptions): { label: string; differs: string[]; input: ItineraryInput; itinerary: Itinerary }[] {
  return variants.map((v) => {
    const vInput = { ...input, prefs: { ...input.prefs, ...v.prefs, priorities: { ...input.prefs.priorities, ...(v.prefs.priorities ?? {}) } } };
    return { label: v.label, differs: v.differs, input: vInput, itinerary: planItinerary(vInput, opts) };
  });
}

// ───────────────────────────── Comparison ─────────────────────────────

export interface ComparisonSide {
  label: string;
  input: ItineraryInput;
  itinerary: Itinerary;
}

export interface ItineraryComparison {
  /** Both plans use the same trip and park information (preferences may differ). */
  sameFacts: boolean;
  factDifferences: string[];
  preferenceDifferences: string[];
  rows: { label: string; a: string; b: string }[];
  scores: { label: string; a: number; b: number; weightA: number; weightB: number }[];
  /** Totals are only directly comparable when both use the same component weights. */
  scoresComparable: boolean;
  tradeoffs: string[];
}

interface Metrics {
  must: string;
  activities: number;
  walking: number;
  waitEstimated: number;
  waitAssumed: number;
  meals: number;
  breaks: number;
  free: number;
  unplanned: number;
  earliest: number | null;
  latest: number | null;
  parkDays: number;
}

function metrics(it: Itinerary): Metrics {
  const days = it.days.filter((d) => d.kind === "park" || d.kind === "hop");
  const all = days.flatMap((d) => d.items);
  const sum = (f: (i: PlannedItem) => boolean, v: (i: PlannedItem) => number) => all.filter(f).reduce((t, i) => t + v(i), 0);
  const rides = (i: PlannedItem) => i.kind === "attraction" || i.kind === "lightning_lane" || i.kind === "custom";
  return {
    must: `${it.coverage.must.scheduled} of ${it.coverage.must.total}`,
    activities: all.filter(rides).length,
    walking: days.reduce((t, d) => t + d.walkingMin, 0) + sum((i) => i.kind === "transfer", (i) => i.end - i.start),
    waitEstimated: sum((i) => rides(i) && (i.waitBasis === "your_estimate" || i.waitBasis === "predicted"), (i) => i.waitMin),
    waitAssumed: sum((i) => rides(i) && (i.waitBasis === "assumed_buffer" || i.waitBasis === "lightning_lane"), (i) => i.waitMin),
    meals: sum((i) => i.kind === "meal" || i.kind === "dining", (i) => i.end - i.start),
    breaks: sum((i) => i.kind === "break", (i) => i.end - i.start),
    free: sum((i) => i.kind === "flexible", (i) => i.end - i.start),
    unplanned: days.reduce((t, d) => t + Math.max(0, d.window.end - (d.items.length ? Math.max(...d.items.map((i) => i.end)) : d.window.start)), 0),
    earliest: days.length ? Math.min(...days.map((d) => (d.items.length ? d.items[0]!.start - d.items[0]!.travelMin : d.window.start))) : null,
    latest: days.length ? Math.max(...days.map((d) => (d.items.length ? Math.max(...d.items.map((i) => i.end)) : d.window.start))) : null,
    parkDays: days.length,
  };
}

function preferenceDiff(a: Preferences, b: Preferences): string[] {
  const out: string[] = [];
  const yn = (x: boolean) => (x ? "on" : "off");
  if (a.pace !== b.pace) out.push(`Pace: ${a.pace} vs ${b.pace}`);
  for (const [k, label] of [
    ["minimizeWalking", "Minimize walking"],
    ["reduceBacktracking", "Avoid crossing the park"],
    ["maximizeAttractions", "Fit in as much as possible"],
    ["relaxedSchedule", "Keep it relaxed"],
  ] as const)
    if (a.priorities[k] !== b.priorities[k]) out.push(`${label}: ${yn(a.priorities[k])} vs ${yn(b.priorities[k])}`);
  for (const [k, label] of [
    ["middayBreak", "Midday rest"],
    ["flexibleAfternoons", "Free afternoons"],
    ["allowHopping", "Park hopping"],
  ] as const)
    if (a[k] !== b[k]) out.push(`${label}: ${yn(a[k])} vs ${yn(b[k])}`);
  if ((a.maxParkDays ?? 0) !== (b.maxParkDays ?? 0)) out.push(`Park days used: ${a.maxParkDays ?? "all"} vs ${b.maxParkDays ?? "all"}`);
  if (a.dayStart !== b.dayStart || a.dayEnd !== b.dayEnd) out.push(`Day window: ${a.dayStart}–${a.dayEnd} vs ${b.dayStart}–${b.dayEnd}`);
  if (a.waitBufferMin !== b.waitBufferMin) out.push(`Wait buffer: ${a.waitBufferMin} vs ${b.waitBufferMin} min`);
  if (stableHash(a.attractions) !== stableHash(b.attractions) || stableHash(a.custom) !== stableHash(b.custom)) out.push("Attraction choices differ");
  return out;
}

export function compareItineraries(A: ComparisonSide, B: ComparisonSide): ItineraryComparison {
  const ma = metrics(A.itinerary);
  const mb = metrics(B.itinerary);
  const factDifferences: string[] = [];
  if (stableHash(A.input.context) !== stableHash(B.input.context)) factDifferences.push("The two plans are for different trip details (dates, resort, party or tickets).");
  if (stableHash(A.input.parkInfo) !== stableHash(B.input.parkInfo)) factDifferences.push("The two plans use different park information (hours, reservations, closures or wait estimates).");
  if (A.input.demo !== B.input.demo) factDifferences.push("One plan is a demonstration with illustrative data.");
  if (A.itinerary.engineVersion !== B.itinerary.engineVersion) factDifferences.push(`The plans were made by different planner versions (${A.itinerary.engineVersion} vs ${B.itinerary.engineVersion}).`);
  const t = (m: number | null) => (m === null ? "—" : fmtTime(m));
  const status = (it: Itinerary) => `${it.status === "feasible" ? "All hard constraints met" : it.status === "partial" ? "Some must-dos left out" : "Not feasible"}${it.provisional ? " (provisional)" : ""}`;
  const rows = [
    { label: "Feasibility", a: status(A.itinerary), b: status(B.itinerary) },
    { label: "Must-dos scheduled", a: ma.must, b: mb.must },
    { label: "Park days", a: String(ma.parkDays), b: String(mb.parkDays) },
    { label: "Attractions and activities", a: String(ma.activities), b: String(mb.activities) },
    { label: "Walking and transfers (estimated)", a: `${ma.walking} min`, b: `${mb.walking} min` },
    { label: "Waiting from your estimates", a: `${ma.waitEstimated} min`, b: `${mb.waitEstimated} min` },
    { label: "Waiting assumed (buffer, unknown real waits)", a: `${ma.waitAssumed} min`, b: `${mb.waitAssumed} min` },
    { label: "Meals", a: `${ma.meals} min`, b: `${mb.meals} min` },
    { label: "Breaks", a: `${ma.breaks} min`, b: `${mb.breaks} min` },
    { label: "Free time within the plan", a: `${ma.free} min`, b: `${mb.free} min` },
    { label: "Unplanned time at day ends", a: `${ma.unplanned} min`, b: `${mb.unplanned} min` },
    { label: "Earliest start", a: t(ma.earliest), b: t(mb.earliest) },
    { label: "Latest finish", a: t(ma.latest), b: t(mb.latest) },
    { label: "Conflicts", a: String(A.itinerary.conflicts.length), b: String(B.itinerary.conflicts.length) },
    { label: "Unknowns noted", a: String(A.itinerary.unknowns.length), b: String(B.itinerary.unknowns.length) },
  ];
  const sa = A.itinerary.score;
  const sb = B.itinerary.score;
  const scores =
    sa && sb
      ? sa.components.map((c) => {
          const o = sb.components.find((x) => x.key === c.key)!;
          return { label: c.label, a: c.score, b: o.score, weightA: c.weightPct, weightB: o.weightPct };
        })
      : [];
  const scoresComparable = !!sa && !!sb && scores.every((x) => x.weightA === x.weightB) && factDifferences.length === 0;

  const tradeoffs: string[] = [];
  const more = ma.activities === mb.activities ? null : ma.activities > mb.activities ? [A, B, ma, mb] as const : [B, A, mb, ma] as const;
  if (more) {
    const [X, Y, mx, my] = more;
    const restX = mx.breaks + mx.free + mx.unplanned;
    const restY = my.breaks + my.free + my.unplanned;
    tradeoffs.push(
      `“${X.label}” fits ${mx.activities - my.activities} more attraction${mx.activities - my.activities === 1 ? "" : "s"} than “${Y.label}”` +
        (restY > restX ? `, at the cost of ${restY - restX} fewer minutes of breaks and free time` : "") +
        (mx.walking > my.walking ? ` and ${mx.walking - my.walking} more minutes of walking` : "") +
        (mx.latest !== null && my.latest !== null && mx.latest > my.latest ? `, finishing as late as ${fmtTime(mx.latest)} (vs ${fmtTime(my.latest)})` : "") +
        ". More activities isn't automatically better: it depends on how much rest your group needs.",
    );
  }
  if (A.itinerary.coverage.must.scheduled !== B.itinerary.coverage.must.scheduled) {
    const [X, Y] = A.itinerary.coverage.must.scheduled > B.itinerary.coverage.must.scheduled ? [A, B] : [B, A];
    tradeoffs.push(`Only “${X.label}” fits all the must-dos it could (${X.itinerary.coverage.must.scheduled} vs ${Y.itinerary.coverage.must.scheduled}); see “Must-dos not scheduled” in “${Y.label}”.`);
  }
  if (ma.waitAssumed + mb.waitAssumed > 0) tradeoffs.push("Much of the waiting in both plans is an assumed buffer, not a forecast: real waits can change either plan.");
  if (!scoresComparable && sa && sb) {
    tradeoffs.push(
      factDifferences.length
        ? "The plans don't use the same facts, so their scores can't be compared directly."
        : "Each plan's score weighs the components by its own priorities, so compare the rows above rather than the two totals.",
    );
  }
  const onlyA = A.itinerary.assumptions.filter((x) => !B.itinerary.assumptions.includes(x));
  const onlyB = B.itinerary.assumptions.filter((x) => !A.itinerary.assumptions.includes(x));
  for (const x of onlyA) tradeoffs.push(`Assumption only in “${A.label}”: ${x}`);
  for (const x of onlyB) tradeoffs.push(`Assumption only in “${B.label}”: ${x}`);
  return { sameFacts: factDifferences.length === 0, factDifferences, preferenceDifferences: preferenceDiff(A.input.prefs, B.input.prefs), rows, scores, scoresComparable, tradeoffs };
}

/** Facts for comparing two itineraries built from the same inputs. */
export function compareSummary(a: Itinerary, b: Itinerary): string[] {
  const parkDays = (x: Itinerary) => x.days.filter((d) => d.kind === "park" || d.kind === "hop");
  const rides = (x: Itinerary) => parkDays(x).reduce((t, d) => t + d.items.filter((i) => i.kind === "attraction" || i.kind === "lightning_lane" || i.kind === "custom").length, 0);
  const walk = (x: Itinerary) => parkDays(x).reduce((t, d) => t + d.walkingMin, 0);
  const breaks = (x: Itinerary) => parkDays(x).reduce((t, d) => t + d.items.filter((i) => i.kind === "break" || i.kind === "flexible").reduce((s, i) => s + (i.end - i.start), 0), 0);
  return [
    `Must-dos: ${a.coverage.must.scheduled} of ${a.coverage.must.total} vs ${b.coverage.must.scheduled} of ${b.coverage.must.total}.`,
    `Attractions and activities scheduled: ${rides(a)} vs ${rides(b)}.`,
    `Estimated walking: ${walk(a)} min vs ${walk(b)} min.`,
    `Breaks and free time: ${breaks(a)} min vs ${breaks(b)} min.`,
    `Park days: ${parkDays(a).length} vs ${parkDays(b).length}.`,
  ];
}

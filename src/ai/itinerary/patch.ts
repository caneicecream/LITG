import { z } from "zod";
import { formatShortDate, type IsoDate } from "@/domain/dates";
import { attractionById, parkById } from "@/itinerary/catalog";
import { itineraryInputSchema, type ItineraryInput } from "@/itinerary/types";

/**
 * Itinerary proposals: what the assistant (AI or basic mode) may change. Like
 * the trip patch, every field is nullable ("leave unchanged") and the patch is
 * applied deterministically, then validated with the itinerary input schema.
 * The assistant can never set park hours, waits, crowds, closures or
 * availability; it can only record reservations whose date and time the user
 * stated in their own words.
 */

const n = <T extends z.ZodType>(t: T) => t.nullable();
const hhmm = z.string().describe("HH:MM, 24-hour");

export const itineraryPatchSchema = z
  .object({
    pace: n(z.enum(["relaxed", "moderate", "packed"])),
    minimizeWalking: n(z.boolean()),
    reduceBacktracking: n(z.boolean()),
    maximizeAttractions: n(z.boolean()),
    relaxedSchedule: n(z.boolean()),
    middayBreak: n(z.boolean()),
    flexibleAfternoons: n(z.boolean()),
    avoidDemandingArrivalDay: n(z.boolean().describe("Keep the most demanding park day away from the start of the trip")),
    restDay: n(z.enum(["avoid", "allow", "prefer"])),
    allowHopping: n(z.boolean()),
    parks: n(z.array(z.string()).describe("Park ids to visit; [] = let the planner choose")),
    parkDays: n(z.int().describe("Use this many park days (at most the ticket's)")),
    attractions: n(z.array(z.object({ attractionId: z.string(), preference: z.enum(["must", "want", "avoid", "neutral"]) }).strict())),
    addDining: n(
      z.array(
        z
          .object({
            date: z.string().describe("YYYY-MM-DD, a day of the trip the user named"),
            time: hhmm,
            parkId: n(z.string()),
            name: z.string(),
            durationMinutes: n(z.int()),
          })
          .strict(),
      ),
    ),
    addLightningLane: n(z.array(z.object({ date: z.string(), attractionId: z.string(), start: hhmm, end: hhmm }).strict())),
    dayStart: n(hhmm),
    dayEnd: n(hhmm),
  })
  .strict();
export type ItineraryPatch = z.infer<typeof itineraryPatchSchema>;

export const EMPTY_ITINERARY_PATCH: ItineraryPatch = {
  pace: null,
  minimizeWalking: null,
  reduceBacktracking: null,
  maximizeAttractions: null,
  relaxedSchedule: null,
  middayBreak: null,
  flexibleAfternoons: null,
  avoidDemandingArrivalDay: null,
  restDay: null,
  allowHopping: null,
  parks: null,
  parkDays: null,
  attractions: null,
  addDining: null,
  addLightningLane: null,
  dayStart: null,
  dayEnd: null,
};

export const itineraryProposalSchema = z
  .object({
    intent: z.enum(["update", "explain", "clarify", "unsupported", "chat"]),
    reply: z.string(),
    patch: itineraryPatchSchema,
    evidence: z.array(z.object({ field: z.string(), userQuote: z.string() }).strict()),
    /** Alternative preference sets to plan side by side from the same facts. */
    comparisons: z.array(z.object({ label: z.string(), patch: itineraryPatchSchema }).strict()),
    clarifications: z.array(z.string()),
    unsupported: z.array(z.string()),
  })
  .strict();
export type ItineraryProposal = z.infer<typeof itineraryProposalSchema>;

/** Times a user wrote, normalized to HH:MM ("6:30 pm", "18:30", "6pm"). */
export function timesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=\W|$)/g)) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    const ap = m[3]?.[0];
    if (!m[2] && !ap) continue; // a bare number is not a time
    if (h > 23 || min > 59) continue;
    if (ap === "p" && h < 12) h += 12;
    if (ap === "a" && h === 12) h = 0;
    out.push(`${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
  }
  return out;
}

const PREF_LABEL = { must: "must-do", want: "would like", avoid: "skip", neutral: "no preference" } as const;

export interface AppliedItineraryPatch {
  input: ItineraryInput | null;
  diff: string[];
  errors: string[];
  warnings: string[];
}

/**
 * Apply a patch deterministically. Reservations and windows are accepted only
 * when their times appear in the user's own messages; dates must be trip days.
 */
export function applyItineraryPatch(base: ItineraryInput, patch: ItineraryPatch, userTexts: string[], today: IsoDate): AppliedItineraryPatch {
  const errors: string[] = [];
  const warnings: string[] = [];
  const diff: string[] = [];
  const next: ItineraryInput = structuredClone(base);
  const p = next.prefs;
  const stated = new Set(userTexts.flatMap(timesIn));
  const inTrip = (d: string) => d >= base.context.arrival && d <= base.context.departure;
  const yn = (b: boolean) => (b ? "on" : "off");
  const setFlag = <K extends "middayBreak" | "flexibleAfternoons" | "avoidDemandingArrivalDay" | "allowHopping">(k: K, label: string) => {
    const v = patch[k];
    if (v !== null && v !== p[k]) {
      diff.push(`${label}: ${yn(p[k])} → ${yn(v)}`);
      p[k] = v;
    }
  };
  if (patch.pace && patch.pace !== p.pace) {
    diff.push(`Pace: ${p.pace} → ${patch.pace}`);
    p.pace = patch.pace;
  }
  for (const [k, label] of [
    ["minimizeWalking", "Minimize walking"],
    ["reduceBacktracking", "Avoid crossing the park repeatedly"],
    ["maximizeAttractions", "Fit in as much as possible"],
    ["relaxedSchedule", "Keep it relaxed"],
  ] as const) {
    const v = patch[k];
    if (v !== null && v !== p.priorities[k]) {
      diff.push(`${label}: ${yn(p.priorities[k])} → ${yn(v)}`);
      p.priorities = { ...p.priorities, [k]: v };
    }
  }
  setFlag("middayBreak", "Midday rest");
  setFlag("flexibleAfternoons", "Keep 2–4 pm free");
  setFlag("avoidDemandingArrivalDay", "Not the busiest day first");
  if (patch.allowHopping) {
    if (!base.context.ticket?.hopper) errors.push("Park hopping needs a Park Hopper ticket, and this trip's ticket doesn't include it.");
    else setFlag("allowHopping", "Park hopping");
  } else setFlag("allowHopping", "Park hopping");
  if (patch.restDay && patch.restDay !== p.restDay) {
    diff.push(`Rest day: ${p.restDay} → ${patch.restDay}`);
    p.restDay = patch.restDay;
  }
  if (patch.parks) {
    const bad = patch.parks.filter((x) => !parkById.has(x));
    if (bad.length) errors.push(`Unknown park: ${bad.join(", ")}.`);
    else if (patch.parks.join() !== p.parks.join()) {
      diff.push(`Parks: ${p.parks.map((x) => parkById.get(x)!.name).join(", ") || "planner chooses"} → ${patch.parks.map((x) => parkById.get(x)!.name).join(", ") || "planner chooses"}`);
      p.parks = patch.parks;
    }
  }
  if (patch.parkDays !== null) {
    const max = base.context.ticket?.days ?? 0;
    if (patch.parkDays < 1) errors.push("At least one park day is needed.");
    else if (patch.parkDays > max) errors.push(`The ticket has ${max} park day${max === 1 ? "" : "s"}, so a ${patch.parkDays}-day plan isn't possible with it.`);
    else if (patch.parkDays !== (p.maxParkDays ?? max)) {
      diff.push(`Park days used: ${p.maxParkDays ?? max} → ${patch.parkDays}`);
      p.maxParkDays = patch.parkDays === max ? null : patch.parkDays;
    }
  }
  for (const a of patch.attractions ?? []) {
    const x = attractionById.get(a.attractionId);
    if (!x) {
      errors.push(`Unknown attraction "${a.attractionId}".`);
      continue;
    }
    const cur = p.attractions[a.attractionId] ?? "neutral";
    if (cur === a.preference) continue;
    diff.push(`${x.name}: ${PREF_LABEL[cur]} → ${PREF_LABEL[a.preference]}`);
    if (a.preference === "neutral") delete p.attractions[a.attractionId];
    else p.attractions[a.attractionId] = a.preference;
  }
  const prov = { status: "manual" as const, source: "You told the assistant", observedAt: today };
  for (const d of patch.addDining ?? []) {
    if (!inTrip(d.date)) errors.push(`${d.date} is not a day of this trip.`);
    else if (!stated.has(d.time)) errors.push(`I can only add a reservation at a time you stated; ${d.time} isn't in your messages.`);
    else if (d.parkId && !parkById.has(d.parkId)) errors.push(`Unknown park "${d.parkId}".`);
    else {
      next.parkInfo.dining.push({ id: `din-${d.date}-${d.time}`, date: d.date, parkId: d.parkId, name: d.name.trim().slice(0, 100) || "Dining reservation", time: d.time, durationMin: Math.min(240, Math.max(15, d.durationMinutes ?? 75)), provenance: prov });
      diff.push(`Dining reservation: + ${d.name || "reservation"} at ${d.time} on ${formatShortDate(d.date)}${d.parkId ? ` (${parkById.get(d.parkId)!.name})` : ""}`);
    }
  }
  for (const l of patch.addLightningLane ?? []) {
    const x = attractionById.get(l.attractionId);
    if (!x) errors.push(`Unknown attraction "${l.attractionId}".`);
    else if (!inTrip(l.date)) errors.push(`${l.date} is not a day of this trip.`);
    else if (!stated.has(l.start) || !stated.has(l.end)) errors.push("I can only add a Lightning Lane return window whose times you stated.");
    else {
      next.parkInfo.lightningLane.push({ id: `ll-${l.date}-${l.attractionId}`, date: l.date, attractionId: l.attractionId, start: l.start, end: l.end, provenance: prov });
      diff.push(`Lightning Lane return window: + ${x.name} ${l.start}–${l.end} on ${formatShortDate(l.date)} (as you told me; availability is not checked)`);
    }
  }
  for (const k of ["dayStart", "dayEnd"] as const) {
    const v = patch[k];
    if (v && v !== p[k]) {
      if (!stated.has(v)) errors.push(`The ${k === "dayStart" ? "start" : "end"} time ${v} isn't in your messages.`);
      else {
        diff.push(`${k === "dayStart" ? "Start the day at" : "End the day by"}: ${p[k]} → ${v}`);
        p[k] = v;
      }
    }
  }
  if (errors.length) return { input: null, diff, errors, warnings };
  const parsed = itineraryInputSchema.safeParse(next);
  if (!parsed.success) return { input: null, diff, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`), warnings };
  return { input: parsed.data as ItineraryInput, diff, errors, warnings };
}

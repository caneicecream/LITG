import { z } from "zod";
import { isIsoDate, type IsoDate } from "@/domain/dates";
import type { TicketOption, TicketUsage } from "@/domain/types";

/**
 * Itinerary planning model. Everything the planner knows about the parks is
 * an `Info` item that carries its own provenance. Nothing here is fetched
 * live: there is no authorized source for park hours, closures, waits, crowds,
 * reservations or Lightning Lane availability. Items are entered by the user,
 * come from the project's approximate catalog, or are illustrative (demo).
 */

// ───────────────────────────── Provenance ─────────────────────────────

/** Statuses that may be stored. "stale" and "unavailable" are derived. */
export const infoStatus = z.enum(["verified", "manual", "estimated", "predicted", "illustrative"]);
export type InfoStatus = z.infer<typeof infoStatus>;
export type DerivedInfoStatus = InfoStatus | "stale" | "unavailable";

export const INFO_STATUS_LABEL: Record<DerivedInfoStatus, string> = {
  verified: "Verified",
  manual: "You entered",
  estimated: "Estimated",
  predicted: "Predicted",
  illustrative: "Illustrative (demo)",
  stale: "Stale",
  unavailable: "Unknown",
};

const isoDate = z.string().refine(isIsoDate, "Expected YYYY-MM-DD");
/** "HH:MM", 24-hour. */
export const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM (24-hour)");

export const provenanceSchema = z.object({
  status: infoStatus,
  source: z.string().trim().min(1, "Say where this came from").max(200),
  /** When it was observed or entered (date or timestamp). */
  observedAt: z.string().min(10).max(40),
  notes: z.string().max(500).optional(),
});
export type InfoProvenance = z.infer<typeof provenanceSchema>;

/**
 * User entries can never claim to be verified: "verified" is reserved for an
 * authorized source adapter, and "illustrative" for the demo scenario.
 */
export const userProvenanceSchema = provenanceSchema.extend({ status: z.enum(["manual", "estimated", "predicted"]) });

// ───────────────────────────── Park information ─────────────────────────────

const startBeforeEnd = (w: { start: string; end: string }) => w.start < w.end;
const endAfterStart = { message: "End must be after start", path: ["end"] };

export const parkInfoSchema = z.object({
  /** Park operating hours on a date. Without these, the user's planning window is used and labelled as such. */
  hours: z
    .array(
      z
        .object({
          date: isoDate,
          parkId: z.string(),
          open: clock,
          close: clock,
          /** Minutes of early entry, if the user confirmed they have it on this date. */
          earlyEntryMin: z.number().int().min(0).max(120).nullable().default(null),
          provenance: provenanceSchema,
        })
        .refine((h) => h.open < h.close, { message: "Closing time must be after opening time", path: ["close"] }),
    )
    .max(200)
    .default([]),
  /** Known attraction closures (refurbishments, seasonal). */
  closures: z
    .array(
      z
        .object({ attractionId: z.string(), from: isoDate, to: isoDate, provenance: provenanceSchema })
        .refine((c) => c.from <= c.to, { message: "End date must be on or after start", path: ["to"] }),
    )
    .max(200)
    .default([]),
  /** Attraction operating windows narrower than the park's (e.g. a show's first and last performance). */
  attractionHours: z
    .array(z.object({ attractionId: z.string(), date: isoDate.nullable(), start: clock, end: clock, provenance: provenanceSchema }).refine(startBeforeEnd, endAfterStart))
    .max(200)
    .default([]),
  /**
   * Waiting-time information. Only "your_estimate" (and "predicted" from an
   * authorized source) is used for planning; an "observed" wait is a moment in
   * the past and is shown for reference only.
   */
  waits: z
    .array(
      z.object({
        attractionId: z.string(),
        minutes: z.number().int().min(0).max(300),
        kind: z.enum(["your_estimate", "observed", "predicted"]),
        date: isoDate.nullable().default(null),
        provenance: provenanceSchema,
      }),
    )
    .max(500)
    .default([]),
  /** Expected crowd conditions. Never invented: only what the user (or an authorized source) supplies. */
  crowds: z
    .array(z.object({ date: isoDate, parkId: z.string(), level: z.enum(["low", "moderate", "high"]), provenance: provenanceSchema }))
    .max(200)
    .default([]),
  /** Theme park reservations the user holds. */
  parkReservations: z.array(z.object({ date: isoDate, parkId: z.string(), provenance: provenanceSchema })).max(60).default([]),
  /** Dining reservations (fixed time). */
  dining: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        date: isoDate,
        parkId: z.string().nullable(),
        name: z.string().trim().min(1).max(100),
        time: clock,
        durationMin: z.number().int().min(15).max(240).default(75),
        provenance: provenanceSchema,
      }),
    )
    .max(100)
    .default([]),
  /** Lightning Lane return windows the user already holds. Availability is never assumed. */
  lightningLane: z
    .array(z.object({ id: z.string().min(1).max(60), date: isoDate, attractionId: z.string(), start: clock, end: clock, provenance: provenanceSchema }).refine(startBeforeEnd, endAfterStart))
    .max(100)
    .default([]),
  /** What is known about Lightning Lane eligibility/rules for this trip (null = unknown). */
  lightningLaneRules: z.object({ summary: z.string().max(500), provenance: provenanceSchema }).nullable().default(null),
});
export type ParkInfo = z.infer<typeof parkInfoSchema>;
export const emptyParkInfo = (): ParkInfo => parkInfoSchema.parse({});

// ───────────────────────────── Preferences ─────────────────────────────

export const attractionPref = z.enum(["must", "want", "avoid"]);
export type AttractionPref = z.infer<typeof attractionPref>;

const dayPlanPin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("park"), parkId: z.string() }),
  z.object({ kind: z.literal("hop"), parkIds: z.tuple([z.string(), z.string()]) }),
  z.object({ kind: z.literal("rest") }),
]);
export type DayPin = z.infer<typeof dayPlanPin>;

export const preferencesSchema = z.object({
  /** Parks the user wants to visit (empty = any park with selected attractions, else all). */
  parks: z.array(z.string()).max(4).default([]),
  /** Days the user fixed themselves (hard constraints). */
  pins: z.array(z.object({ date: isoDate, plan: dayPlanPin })).max(30).default([]),
  /** Attraction id → must / want / avoid. Unlisted attractions are optional extras. */
  attractions: z.record(z.string(), attractionPref).default({}),
  /** The user's own activities (a parade spot, character meal, shopping...). */
  custom: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        name: z.string().trim().min(1).max(100),
        parkId: z.string(),
        areaId: z.string(),
        durationMin: z.number().int().min(5).max(480),
        priority: z.enum(["must", "want"]),
      }),
    )
    .max(50)
    .default([]),
  pace: z.enum(["relaxed", "moderate", "packed"]).default("moderate"),
  priorities: z
    .object({
      minimizeWalking: z.boolean().default(false),
      maximizeAttractions: z.boolean().default(false),
      reduceBacktracking: z.boolean().default(false),
      relaxedSchedule: z.boolean().default(false),
    })
    .prefault({}),
  /** When you want to start and end a park day (your planning window). */
  dayStart: clock.default("09:00"),
  dayEnd: clock.default("21:00"),
  /** Earliest start on the arrival day (check-in, travel). */
  arrivalDayStart: clock.default("14:00"),
  /** Latest end on the departure day. */
  departureDayEnd: clock.default("13:00"),
  lunch: z.object({ start: clock, end: clock }).nullable().default({ start: "11:30", end: "13:30" }),
  dinner: z.object({ start: clock, end: clock }).nullable().default({ start: "17:30", end: "19:30" }),
  mealMin: z.number().int().min(15).max(120).default(45),
  /** A longer midday rest (e.g. back to the hotel or a quiet spot). */
  middayBreak: z.boolean().default(false),
  middayBreakMin: z.number().int().min(30).max(240).default(90),
  /** Keep 2–4 pm unscheduled. */
  flexibleAfternoons: z.boolean().default(false),
  /** Don't put the most demanding park day on the arrival day. */
  avoidDemandingArrivalDay: z.boolean().default(true),
  restDay: z.enum(["avoid", "allow", "prefer"]).default("allow"),
  /** Use Park Hopper (only if the ticket includes it). */
  allowHopping: z.boolean().default(false),
  /** Use early entry where the user confirmed it in park hours. */
  useEarlyEntry: z.boolean().default(true),
  lightningLane: z.enum(["none", "if_held"]).default("if_held"),
  /** Planning buffer per ride when no wait estimate exists (your assumption, not a forecast). */
  waitBufferMin: z.number().int().min(0).max(120).default(20),
  mobility: z.enum(["standard", "slower"]).default("standard"),
  /** Use fewer park days than the ticket allows (null = all). */
  maxParkDays: z.number().int().min(1).max(14).nullable().default(null),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences = (): Preferences => preferencesSchema.parse({});

// ───────────────────────────── Trip context ─────────────────────────────

/** The validated trip the itinerary is for (derived from a saved trip / planner request). */
export interface TripContext {
  source: { kind: "saved_trip" | "request" | "demo"; tripId?: string; label: string };
  arrival: IsoDate;
  departure: IsoDate;
  party: { adults: number; children: number; infants: number };
  resortId: string;
  resortName: string;
  disneyResort: boolean;
  ticket: {
    option: TicketOption;
    /** Admission days on the ticket. */
    days: number;
    hopper: boolean;
    usage: TicketUsage | null;
    usageSource: string | null;
  } | null;
  parkOnArrivalDay: boolean;
  parkOnDepartureDay: boolean;
}

export const tripContextSchema = z.object({
  source: z.object({ kind: z.enum(["saved_trip", "request", "demo"]), tripId: z.string().optional(), label: z.string().max(200) }),
  arrival: isoDate,
  departure: isoDate,
  party: z.object({ adults: z.number().int().min(1).max(12), children: z.number().int().min(0).max(12), infants: z.number().int().min(0).max(6) }),
  resortId: z.string(),
  resortName: z.string(),
  disneyResort: z.boolean(),
  ticket: z
    .object({
      option: z.enum(["base", "park_hopper", "park_hopper_plus"]),
      days: z.number().int().min(1).max(14),
      hopper: z.boolean(),
      usage: z
        .object({
          useWithinDays: z.number().int().nullable(),
          expiresOn: isoDate.optional(),
          blockoutDates: z.array(isoDate).optional(),
          parkReservationRequired: z.boolean().nullable(),
          notes: z.string().optional(),
        })
        .nullable(),
      usageSource: z.string().nullable(),
    })
    .nullable(),
  parkOnArrivalDay: z.boolean(),
  parkOnDepartureDay: z.boolean(),
}).refine((c) => c.arrival < c.departure, { message: "Departure must be after arrival", path: ["departure"] });

export const itineraryInputSchema = z.object({
  context: tripContextSchema,
  prefs: preferencesSchema,
  parkInfo: parkInfoSchema,
  /** Demonstration scenario: illustrative hours and waits, never real. */
  demo: z.boolean().default(false),
});
export type ItineraryInput = { context: TripContext; prefs: Preferences; parkInfo: ParkInfo; demo: boolean };

// ───────────────────────────── Output ─────────────────────────────

export type ItemKind = "attraction" | "custom" | "lightning_lane" | "meal" | "dining" | "break" | "flexible" | "transfer";

export interface PlannedItem {
  kind: ItemKind;
  /** Minutes from midnight. */
  start: number;
  end: number;
  title: string;
  attractionId?: string;
  areaId?: string;
  parkId?: string;
  /** Walking/transport minutes before this item. */
  travelMin: number;
  /** Planned waiting minutes, and what that number is based on. */
  waitMin: number;
  waitBasis: "your_estimate" | "predicted" | "assumed_buffer" | "lightning_lane" | "none";
  durationMin: number;
  priority?: "must" | "want" | "optional";
  /** Labels of the data this item relies on (shown as provenance chips). */
  basis: { label: string; status: DerivedInfoStatus }[];
  notes: string[];
}

export interface DayPlan {
  date: IsoDate;
  kind: "park" | "hop" | "rest" | "no_park";
  parkIds: string[];
  /** The day's planning window and what it is based on. */
  window: { start: number; end: number; basis: "park_hours" | "planning_window" | "illustrative_hours"; detail: string };
  items: PlannedItem[];
  walkingMin: number;
  activityMin: number;
  waitMin: number;
  /** Times you leave an area and later come back to it. */
  backtracks: number;
  intensity: number;
  notes: string[];
  unscheduled: { id: string; name: string; reason: string }[];
}

export interface ScoreComponent {
  key: "must_do" | "preferences" | "travel" | "pacing" | "certainty";
  label: string;
  /** 0–100. */
  score: number;
  /** Share of the total, in percent. */
  weightPct: number;
  detail: string;
}

export interface Itinerary {
  engineVersion: string;
  inputHash: string;
  /** feasible: hard constraints met; partial: must-dos left out; infeasible: no valid plan. */
  status: "feasible" | "partial" | "infeasible";
  /** True when the plan relies on assumed hours or waits (always true without park hours). */
  provisional: boolean;
  demo: boolean;
  headline: string;
  days: DayPlan[];
  coverage: {
    must: { total: number; scheduled: number; missing: { id: string; name: string; reason: string }[] };
    want: { total: number; scheduled: number };
    parksRequested: string[];
    parksVisited: string[];
  };
  score: { total: number; components: ScoreComponent[]; meaning: string } | null;
  conflicts: string[];
  infeasibleReasons: string[];
  assumptions: string[];
  unknowns: string[];
  /** Data used, with provenance and freshness. */
  dataUsed: { label: string; status: DerivedInfoStatus; source: string; observedAt: string }[];
  search: { allocationsConsidered: number; candidatesScheduled: number; limited: boolean; note: string };
}

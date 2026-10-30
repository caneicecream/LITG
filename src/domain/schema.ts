import { z } from "zod";
import { daysBetween, isIsoDate } from "./dates";
import type { TripRequest } from "./types";

/**
 * Validation schema for a trip request. This is the single structured contract
 * between any front end (form today, an AI assistant later) and the optimizer.
 */

export const MAX_ARRIVAL_WINDOW_DAYS = 120;
export const MAX_NIGHTS = 14;

const isoDate = z.string().refine(isIsoDate, "Expected a date in YYYY-MM-DD format");
const cents = z.number().int().min(0);
const tristate = z.enum(["yes", "no", "unknown"]);
const ticketOption = z.enum(["base", "park_hopper", "park_hopper_plus"]);

export const tripRequestSchema = z
  .object({
    party: z.object({
      adults: z.number().int().min(1).max(10),
      children: z.number().int().min(0).max(10),
      infants: z.number().int().min(0).max(4),
    }),
    dates: z.object({
      earliestArrival: isoDate,
      latestDeparture: isoDate,
      minNights: z.number().int().min(1).max(MAX_NIGHTS),
      maxNights: z.number().int().min(1).max(MAX_NIGHTS),
    }),
    preferred: z.object({
      arrival: isoDate.optional(),
      nights: z.number().int().min(1).max(MAX_NIGHTS).optional(),
      resortId: z.string().optional(),
      roomTypeId: z.string().optional(),
      ticketOption: ticketOption.optional(),
      bookingMethod: z.enum(["separate", "package", "points"]).optional(),
      dining: z.enum(["out_of_pocket", "quick_service_plan", "dining_plan"]).optional(),
    }),
    resorts: z.object({
      allowedResortIds: z.array(z.string()),
      requireOnProperty: z.boolean(),
      preferredResortIds: z.array(z.string()),
      considerPoints: z.boolean().optional(),
    }),
    tickets: z.object({
      parkDays: z.number().int().min(0).max(10),
      allowedOptions: z.array(ticketOption),
      parkOnArrivalDay: z.boolean(),
      parkOnDepartureDay: z.boolean(),
      allowThirdParty: z.boolean(),
    }),
    dining: z.object({
      policy: z.enum(["require", "prefer", "consider", "exclude"]),
      outOfPocketPerAdultPerNightCents: cents,
      outOfPocketPerChildPerNightCents: cents,
    }),
    transport: z.object({
      mode: z.enum(["no_car", "own_car", "rental_car"]),
      rentalPerDayCents: cents,
    }),
    budget: z.object({ targetCents: cents.optional(), hardLimitCents: cents.optional() }),
    otherExpenses: z.array(
      z.object({
        label: z.string().min(1).max(80),
        cents,
        per: z.enum(["trip", "night", "person", "person_night"]),
      }),
    ),
    eligibility: z.object({ florida_resident: tristate, annual_passholder: tristate, military: tristate }),
    objective: z.enum(["lowest_cost", "best_value"]),
    weights: z.object({
      price: z.number().min(0).max(100),
      resort: z.number().min(0).max(100),
      convenience: z.number().min(0).max(100),
      ticket: z.number().min(0).max(100),
      dining: z.number().min(0).max(100),
      dates: z.number().min(0).max(100),
    }),
    data: z.object({
      includeIllustrative: z.boolean(),
      staleAfterDays: z.number().int().min(1).max(365),
    }),
    bookingDate: isoDate.optional(),
  })
  .superRefine((r, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    if (r.dates.minNights > r.dates.maxNights) issue(["dates", "maxNights"], "Maximum nights must be ≥ minimum nights");
    const span = daysBetween(r.dates.earliestArrival, r.dates.latestDeparture);
    if (span < r.dates.minNights) {
      issue(["dates", "latestDeparture"], "The date window is shorter than the minimum stay");
    }
    if (span > MAX_ARRIVAL_WINDOW_DAYS + MAX_NIGHTS) {
      issue(["dates", "latestDeparture"], `Date window is limited to ${MAX_ARRIVAL_WINDOW_DAYS} days in this version`);
    }
    if (r.tickets.parkDays > 0 && r.tickets.allowedOptions.length === 0) {
      issue(["tickets", "allowedOptions"], "Select at least one ticket type");
    }
    const sum = Object.values(r.weights).reduce((a, b) => a + b, 0);
    if (sum <= 0) issue(["weights"], "At least one value weight must be positive");
  });

export function parseTripRequest(input: unknown):
  | { ok: true; request: TripRequest }
  | { ok: false; errors: string[] } {
  const res = tripRequestSchema.safeParse(input);
  if (res.success) return { ok: true, request: res.data as TripRequest };
  return { ok: false, errors: res.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`) };
}

export const DEFAULT_WEIGHTS = { price: 50, resort: 15, convenience: 10, ticket: 10, dining: 5, dates: 10 };

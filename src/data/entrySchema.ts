import { z } from "zod";
import { isIsoDate } from "@/domain/dates";
import { CATALOG } from "./catalog";
import type { UserPriceEntry } from "./store";

/**
 * Validation for prices the user enters by hand. User entries can only be
 * "manual" (copied from a real quote/booking page) or "estimated" (the user's
 * own estimate). "verified" is reserved for vetted automated sources, and
 * "illustrative" for the bundled demo dataset. History is owned by the server
 * (re-checks), so it is never accepted from the client.
 */
const isoDate = z.string().refine(isIsoDate, "Expected YYYY-MM-DD");
const cents = z.number().int().min(0).max(10_000_000);
const provenance = z.object({
  status: z.enum(["manual", "estimated"]),
  source: z.string().trim().min(1, "Say where this price came from").max(200),
  sourceUrl: z.url().max(500).optional(),
  observedAt: isoDate,
  notes: z.string().max(1000).optional(),
});
const ticketOption = z.enum(["base", "park_hopper", "park_hopper_plus"]);
const dining = z.enum(["out_of_pocket", "quick_service_plan", "dining_plan"]);
const resortId = z.string().refine((id) => CATALOG.resorts.some((r) => r.id === id), "Unknown resort");

const range = { validFrom: isoDate, validTo: isoDate };

export const ticketUsageSchema = z.object({
  useWithinDays: z.number().int().min(1).max(366).nullable(),
  expiresOn: isoDate.optional(),
  blockoutDates: z.array(isoDate).max(400).optional(),
  parkReservationRequired: z.boolean().nullable(),
  notes: z.string().max(500).optional(),
});

export const paymentTermsSchema = z
  .object({
    depositCents: cents.nullable(),
    depositDueDate: isoDate.optional(),
    installments: z.array(z.object({ dueDate: isoDate, amountCents: cents.min(1), label: z.string().max(60).optional() })).max(24),
    finalPaymentDueDate: isoDate.optional(),
    amountPaidCents: cents.optional(),
    refundability: z.enum(["refundable", "partially_refundable", "non_refundable", "unknown"]),
    freeCancellationUntil: isoDate.optional(),
    cancellationPenalties: z
      .array(
        z
          .object({ fromDate: isoDate, cents: cents.optional(), pct: z.number().gt(0).max(100).optional(), note: z.string().max(200).optional() })
          .refine((p) => (p.cents === undefined) !== (p.pct === undefined), "Give a penalty amount or a percentage, not both"),
      )
      .max(12),
    notes: z.string().max(1000).optional(),
  })
  .superRefine((t, ctx) => {
    if (t.refundability === "non_refundable" && t.freeCancellationUntil) {
      ctx.addIssue({ code: "custom", path: ["freeCancellationUntil"], message: "A non-refundable booking has no free-cancellation date" });
    }
  });

const roomRate = z.object({
  kind: z.literal("room_rate"),
  resortId,
  roomTypeId: z.string(),
  ...range,
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  nightlyCents: cents.min(1),
  taxIncluded: z.boolean(),
  provenance,
});

const ticketPrice = z.object({
  kind: z.literal("ticket_price"),
  option: ticketOption,
  days: z.number().int().min(1).max(10),
  age: z.enum(["adult", "child"]),
  ...range,
  cents: cents.min(1),
  taxIncluded: z.boolean(),
  channel: z.enum(["disney", "third_party"]),
  usage: ticketUsageSchema.optional(),
  provenance,
});

const ticketRule = z.object({
  kind: z.literal("ticket_rule"),
  option: ticketOption,
  days: z.number().int().min(1).max(10).nullable(),
  channel: z.enum(["disney", "third_party"]),
  usage: ticketUsageSchema,
  provenance,
});

const diningPlanPrice = z.object({
  kind: z.literal("dining_plan_price"),
  plan: z.enum(["quick_service_plan", "dining_plan"]),
  age: z.enum(["adult", "child"]),
  ...range,
  perNightCents: cents.min(1),
  taxIncluded: z.boolean(),
  provenance,
});

const stayQuote = z.object({
  kind: z.literal("stay_quote"),
  label: z.string().trim().min(1).max(120),
  resortId,
  roomTypeId: z.string(),
  checkIn: isoDate,
  nights: z.number().int().min(1).max(30),
  adults: z.number().int().min(1).max(10),
  children: z.number().int().min(0).max(10),
  bookingMethod: z.enum(["separate", "package", "points"]),
  ticket: z.object({ option: ticketOption, days: z.number().int().min(1).max(10), usage: ticketUsageSchema.optional() }).optional(),
  dining,
  totalCents: cents.min(1),
  taxIncluded: z.boolean(),
  taxCents: cents.optional(),
  points: z.object({ pointsRequired: z.number().int().min(1).max(10_000), centsPerPoint: cents.min(1) }).optional(),
  terms: paymentTermsSchema.optional(),
  booked: z.boolean().optional(),
  provenance,
});

const pointChart = z.object({
  kind: z.literal("point_chart"),
  resortId,
  roomTypeId: z.string(),
  ...range,
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  pointsPerNight: z.number().int().min(1).max(1_000),
  provenance,
});

const pointCost = z.object({
  kind: z.literal("point_cost"),
  label: z.string().trim().min(1).max(120),
  type: z.enum(["rental", "owned"]),
  centsPerPoint: cents.min(1).max(20_000),
  minPoints: z.number().int().min(1).max(10_000).optional(),
  feeCents: cents.optional(),
  resortIds: z.array(resortId).min(1).optional(),
  terms: paymentTermsSchema.optional(),
  provenance,
});

const promotion = z.object({
  kind: z.literal("promotion"),
  name: z.string().trim().min(1).max(160),
  discount: z.discriminatedUnion("type", [
    z.object({ type: z.literal("room_percent"), pct: z.number().gt(0).max(100) }),
    z.object({ type: z.literal("room_fixed_per_night"), cents: cents.min(1) }),
    z.object({ type: z.literal("package_fixed"), cents: cents.min(1) }),
  ]),
  travel: z.object({ from: isoDate, to: isoDate, rule: z.enum(["all_nights", "arrival_date", "per_night"]) }),
  booking: z.object({ from: isoDate, to: isoDate }).optional(),
  resortIds: z.array(resortId).min(1).optional(),
  minNights: z.number().int().min(1).max(30).optional(),
  maxNights: z.number().int().min(1).max(30).optional(),
  minTicketDays: z.number().int().min(1).max(10).optional(),
  requiresPackage: z.boolean(),
  audience: z.array(z.enum(["florida_resident", "annual_passholder", "military"])).optional(),
  terms: z.string().trim().min(1, "Record the offer's terms").max(2000),
  provenance,
});

export const priceEntrySchema = z
  .discriminatedUnion("kind", [roomRate, ticketPrice, ticketRule, diningPlanPrice, stayQuote, pointChart, pointCost, promotion])
  .superRefine((e, ctx) => {
    const issue = (message: string, path: string[] = []) => ctx.addIssue({ code: "custom", message, path });
    if ("validFrom" in e && e.validFrom > e.validTo) issue("Start date must be on or before end date", ["validTo"]);
    if (e.kind === "promotion") {
      if (e.travel.from > e.travel.to) issue("Travel window is reversed", ["travel"]);
      if (e.booking && e.booking.from > e.booking.to) issue("Booking window is reversed", ["booking"]);
    }
    const resort = "resortId" in e ? CATALOG.resorts.find((r) => r.id === e.resortId) : undefined;
    if ("roomTypeId" in e && resort && !resort.roomTypes.some((rt) => rt.id === e.roomTypeId)) issue("Unknown room type", ["roomTypeId"]);
    if (e.kind === "point_chart" && resort && !resort.dvcPoints) issue(`${resort.name} can't be reserved with DVC points`, ["resortId"]);
    if (e.kind === "point_cost" && e.resortIds?.some((id) => !CATALOG.resorts.find((r) => r.id === id)?.dvcPoints)) {
      issue("Point costs can only apply to DVC resorts", ["resortIds"]);
    }
    if (e.kind === "stay_quote") {
      if (e.bookingMethod === "package") {
        if (!e.ticket) issue("A package quote must say which tickets it includes", ["ticket"]);
        if (resort && !resort.disneyOwned) issue("Disney packages are only sold at Disney-owned resorts", ["bookingMethod"]);
      } else if (e.ticket || e.dining !== "out_of_pocket") {
        issue("A room-only or point-rental quote cannot include tickets or a dining plan", ["bookingMethod"]);
      }
      if (e.bookingMethod === "points" && resort && !resort.dvcPoints) issue(`${resort.name} can't be reserved with DVC points`, ["bookingMethod"]);
      if (e.points && e.bookingMethod !== "points") issue("Points are only recorded for point-rental quotes", ["points"]);
      if (e.taxIncluded && e.taxCents !== undefined) issue("Separate taxes only apply when the total excludes tax", ["taxCents"]);
      if (e.terms && e.terms.amountPaidCents !== undefined && e.terms.amountPaidCents > e.totalCents + (e.taxCents ?? 0)) {
        issue("Amount paid exceeds the quoted total", ["terms", "amountPaidCents"]);
      }
      if (e.booked && !e.terms) issue("Record the payment and cancellation terms of an existing reservation", ["terms"]);
    }
  });

export function parsePriceEntry(input: unknown):
  | { ok: true; entry: Omit<UserPriceEntry, "id"> }
  | { ok: false; errors: string[] } {
  const res = priceEntrySchema.safeParse(input);
  if (res.success) return { ok: true, entry: res.data as Omit<UserPriceEntry, "id"> };
  return { ok: false, errors: res.error.issues.map((i) => `${i.path.join(".") || "entry"}: ${i.message}`) };
}

/** Validate a batch; all entries must be valid (all-or-nothing). Errors are prefixed with the entry number. */
export function parsePriceEntries(input: unknown[]):
  | { ok: true; entries: Omit<UserPriceEntry, "id">[] }
  | { ok: false; errors: string[] } {
  const entries: Omit<UserPriceEntry, "id">[] = [];
  const errors: string[] = [];
  input.forEach((x, i) => {
    const r = parsePriceEntry(x);
    if (r.ok) entries.push(r.entry);
    else errors.push(...r.errors.map((e) => `#${i + 1} ${e}`));
  });
  return errors.length ? { ok: false, errors } : { ok: true, entries };
}

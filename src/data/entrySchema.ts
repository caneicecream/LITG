import { z } from "zod";
import { isIsoDate } from "@/domain/dates";
import { CATALOG } from "./catalog";
import type { UserPriceEntry } from "./store";

/**
 * Validation for prices the user enters by hand. User entries can only be
 * "manual" (copied from a real quote/booking page) or "estimated" (the user's
 * own estimate). "verified" is reserved for vetted automated sources, and
 * "illustrative" for the bundled demo dataset.
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
  bookingMethod: z.enum(["separate", "package"]),
  ticket: z.object({ option: ticketOption, days: z.number().int().min(1).max(10) }).optional(),
  dining,
  totalCents: cents.min(1),
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
  .discriminatedUnion("kind", [roomRate, ticketPrice, diningPlanPrice, stayQuote, promotion])
  .superRefine((e, ctx) => {
    const issue = (message: string, path: string[] = []) => ctx.addIssue({ code: "custom", message, path });
    if ("validFrom" in e && e.validFrom > e.validTo) issue("Start date must be on or before end date", ["validTo"]);
    if (e.kind === "promotion") {
      if (e.travel.from > e.travel.to) issue("Travel window is reversed", ["travel"]);
      if (e.booking && e.booking.from > e.booking.to) issue("Booking window is reversed", ["booking"]);
    }
    if ("roomTypeId" in e) {
      const resort = CATALOG.resorts.find((r) => r.id === e.resortId);
      if (resort && !resort.roomTypes.some((rt) => rt.id === e.roomTypeId)) issue("Unknown room type", ["roomTypeId"]);
    }
    if (e.kind === "stay_quote") {
      if (e.bookingMethod === "package" && !e.ticket) issue("A package quote must say which tickets it includes", ["ticket"]);
      if (e.bookingMethod === "separate" && (e.ticket || e.dining !== "out_of_pocket")) {
        issue("A room-only quote cannot include tickets or a dining plan", ["bookingMethod"]);
      }
    }
  });

export function parsePriceEntry(input: unknown):
  | { ok: true; entry: Omit<UserPriceEntry, "id"> }
  | { ok: false; errors: string[] } {
  const res = priceEntrySchema.safeParse(input);
  if (res.success) return { ok: true, entry: res.data as Omit<UserPriceEntry, "id"> };
  return { ok: false, errors: res.error.issues.map((i) => `${i.path.join(".") || "entry"}: ${i.message}`) };
}

import { inRange, type IsoDate } from "../dates";
import { percentOf, type Cents } from "../money";
import type { Audience, Configuration, Promotion, Resort, Tristate } from "../types";

export type Eligibility =
  | { kind: "eligible"; discountedNights: IsoDate[] }
  | { kind: "ineligible"; reasons: string[] }
  | { kind: "uncertain"; unknowns: string[]; discountedNights: IsoDate[] };

export interface PromotionContext {
  config: Configuration;
  resort: Resort;
  nights: readonly IsoDate[];
  partySize: number;
  parkDays: number;
  bookingDate: IsoDate;
  eligibility: Record<Audience, Tristate>;
}

const AUDIENCE_LABEL: Record<Audience, string> = {
  florida_resident: "Florida residency",
  annual_passholder: "Annual Passholder status",
  military: "military eligibility",
};

/**
 * Check every structured condition of a promotion. A promotion is "eligible"
 * only if all conditions are checkably met. Conditions that depend on facts we
 * don't know (e.g. residency marked "unknown") yield "uncertain", which is
 * reported to the user but never applied to a total.
 */
export function checkEligibility(promo: Promotion, ctx: PromotionContext): Eligibility {
  const reasons: string[] = [];
  const { config, resort, nights } = ctx;

  if (promo.requiresPackage && config.bookingMethod !== "package") reasons.push("requires a package booking");
  if (promo.resortIds ? !promo.resortIds.includes(resort.id) : !resort.onProperty) {
    reasons.push(`not valid at ${resort.name}`);
  }
  if (promo.roomKeys && !promo.roomKeys.includes(`${config.resortId}/${config.roomTypeId}`)) {
    reasons.push("room type not eligible");
  }
  if (promo.minNights !== undefined && config.nights < promo.minNights) reasons.push(`minimum ${promo.minNights} nights`);
  if (promo.maxNights !== undefined && config.nights > promo.maxNights) reasons.push(`maximum ${promo.maxNights} nights`);
  if (promo.minTicketDays !== undefined && (config.ticketOption === null || ctx.parkDays < promo.minTicketDays)) {
    reasons.push(`requires tickets of at least ${promo.minTicketDays} days`);
  }
  if (promo.minPartySize !== undefined && ctx.partySize < promo.minPartySize) reasons.push("party too small");
  if (promo.maxPartySize !== undefined && ctx.partySize > promo.maxPartySize) reasons.push("party too large");
  if (promo.booking && !inRange(ctx.bookingDate, promo.booking.from, promo.booking.to)) {
    reasons.push(`must be booked ${promo.booking.from} to ${promo.booking.to}`);
  }

  const blackout = new Set(promo.blackoutNights ?? []);
  const inWindow = (d: IsoDate) => inRange(d, promo.travel.from, promo.travel.to) && !blackout.has(d);
  let discountedNights: IsoDate[] = [];
  switch (promo.travel.rule) {
    case "all_nights":
      if (!nights.every(inWindow)) reasons.push("not every night falls within the valid travel dates");
      discountedNights = [...nights];
      break;
    case "arrival_date":
      if (!inRange(config.arrival, promo.travel.from, promo.travel.to)) {
        reasons.push("arrival date outside the valid travel dates");
      }
      if (nights.some((d) => blackout.has(d))) reasons.push("stay includes blackout nights");
      discountedNights = [...nights];
      break;
    case "per_night":
      discountedNights = nights.filter(inWindow);
      if (discountedNights.length === 0) reasons.push("no nights fall within the valid travel dates");
      break;
  }

  if (reasons.length > 0) return { kind: "ineligible", reasons };

  if (promo.audience && promo.audience.length > 0) {
    const answers = promo.audience.map((a) => ctx.eligibility[a]);
    if (!answers.includes("yes")) {
      if (answers.includes("unknown")) {
        return {
          kind: "uncertain",
          unknowns: promo.audience.map((a) => `requires ${AUDIENCE_LABEL[a]} (not confirmed)`),
          discountedNights,
        };
      }
      return { kind: "ineligible", reasons: promo.audience.map((a) => `requires ${AUDIENCE_LABEL[a]}`) };
    }
  }
  return { kind: "eligible", discountedNights };
}

/** Per-night room discount, for room-level promotions. Never exceeds the night's rate. */
export function roomDiscountForNight(promo: Promotion, nightCents: Cents): Cents {
  switch (promo.discount.type) {
    case "room_percent":
      return Math.min(nightCents, percentOf(nightCents, promo.discount.pct));
    case "room_fixed_per_night":
      return Math.min(nightCents, promo.discount.cents);
    case "package_fixed":
      return 0;
  }
}

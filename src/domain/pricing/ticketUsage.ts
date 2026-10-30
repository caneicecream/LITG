import { addDays, daysBetween, formatShortDate, type IsoDate } from "../dates";
import type { TicketUsability, TicketUsage } from "../types";

/**
 * Can a ticket starting on `startDate` cover `parkDays` admission days between
 * `startDate` and `lastParkDate` (the last day of the trip that may be a park day)?
 *
 * Only restrictions that are actually recorded are enforced. An unknown
 * use-within window makes the result "unknown" (reported, not assumed), unless a
 * known restriction already makes the ticket unusable.
 */
export function evaluateTicketUsage(
  usage: TicketUsage | undefined,
  source: string | null,
  startDate: IsoDate,
  parkDays: number,
  lastParkDate: IsoDate,
): TicketUsability {
  if (!usage) {
    return {
      status: "unknown",
      usableDays: null,
      reasons: [],
      unknowns: ["use-within window", "expiration", "blocked-out dates", "park reservation requirement"],
      parkReservationRequired: null,
      source: null,
    };
  }

  const reasons: string[] = [];
  const unknowns: string[] = [];
  let windowEnd = lastParkDate;
  let limitedBy = "the trip's last park day";
  if (usage.useWithinDays !== null) {
    const end = addDays(startDate, usage.useWithinDays - 1);
    if (end < windowEnd) {
      windowEnd = end;
      limitedBy = `the ${usage.useWithinDays}-day use window`;
    }
  } else {
    unknowns.push("use-within window");
  }
  if (usage.expiresOn && usage.expiresOn < windowEnd) {
    windowEnd = usage.expiresOn;
    limitedBy = `expiration on ${formatShortDate(usage.expiresOn)}`;
  }
  if (usage.parkReservationRequired === null) unknowns.push("park reservation requirement");

  let usableDays = 0;
  if (windowEnd >= startDate) {
    const blocked = new Set(usage.blockoutDates ?? []);
    const span = daysBetween(startDate, windowEnd) + 1;
    for (let i = 0; i < span; i++) if (!blocked.has(addDays(startDate, i))) usableDays++;
  }
  if (usableDays < parkDays) {
    const blockedInWindow = (usage.blockoutDates ?? []).filter((d) => d >= startDate && d <= windowEnd).length;
    reasons.push(
      `Only ${usableDays} usable day${usableDays === 1 ? "" : "s"} for ${parkDays} park days (limited by ${limitedBy}` +
        (blockedInWindow ? `, ${blockedInWindow} blocked-out date${blockedInWindow === 1 ? "" : "s"}` : "") +
        ")",
    );
  }
  const status = reasons.length > 0 ? "violated" : usage.useWithinDays === null ? "unknown" : "ok";
  return { status, usableDays, reasons, unknowns, parkReservationRequired: usage.parkReservationRequired, source };
}

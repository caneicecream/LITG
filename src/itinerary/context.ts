import { CATALOG } from "@/data/catalog";
import { addDays, type IsoDate } from "@/domain/dates";
import { baselineConfiguration } from "@/domain/optimizer/optimize";
import { resolveTicketRule } from "@/domain/pricing/resolve";
import type { Configuration, PriceData, TicketUsage, TripRequest } from "@/domain/types";
import { PARKS } from "./catalog";
import { defaultPreferences, emptyParkInfo, type InfoProvenance, type ItineraryInput, type ParkInfo, type TripContext } from "./types";

/**
 * The trip an itinerary is planned for, derived from a validated TripRequest:
 * the user's preferred plan (dates, resort, ticket) — the same configuration the
 * price optimizer uses as the baseline. Ticket usage rules come from the user's
 * price data (a quote's ticket terms, or a product rule) and stay null when
 * unknown: nothing is assumed about blocked dates or reservations.
 */
export function tripContextFromRequest(
  request: TripRequest,
  data: PriceData | null,
  source: TripContext["source"],
  today: IsoDate,
  /** A specific optimized option to plan instead of the preferred plan (e.g. "plan the park days for this option"). */
  option?: Configuration,
): { ok: true; context: TripContext } | { ok: false; errors: string[] } {
  if (option) {
    request = {
      ...request,
      preferred: { arrival: option.arrival, nights: option.nights, resortId: option.resortId, roomTypeId: option.roomTypeId, ticketOption: option.ticketOption ?? undefined, bookingMethod: option.bookingMethod, dining: option.dining },
    };
  }
  const base = baselineConfiguration(request);
  if (!("config" in base)) {
    return { ok: false, errors: [`The trip's preferred plan is incomplete (missing ${base.missing.join(", ")}). Set it on Plan & compare, then plan the itinerary.`] };
  }
  const c = base.config;
  const resort = CATALOG.resorts.find((r) => r.id === c.resortId);
  let usage: TicketUsage | null = null;
  let usageSource: string | null = null;
  if (c.ticketOption && data) {
    // A quote for exactly this stay with ticket terms wins; else a product-level rule.
    const quote = data.stayQuotes.find(
      (q) => q.resortId === c.resortId && q.roomTypeId === c.roomTypeId && q.checkIn === c.arrival && q.nights === c.nights && q.ticket?.option === c.ticketOption && q.ticket.usage,
    );
    if (quote?.ticket?.usage) {
      usage = quote.ticket.usage;
      usageSource = quote.provenance.source;
    } else {
      const rule = resolveTicketRule(data, c.ticketOption, request.tickets.parkDays, "disney", { today, staleAfterDays: request.data.staleAfterDays, includeIllustrative: request.data.includeIllustrative });
      if (rule) {
        usage = rule.item.usage;
        usageSource = `${rule.item.provenance.source} (${rule.status})`;
      }
    }
  }
  return {
    ok: true,
    context: {
      source,
      arrival: c.arrival,
      departure: addDays(c.arrival, c.nights),
      party: request.party,
      resortId: c.resortId,
      resortName: resort?.name ?? c.resortId,
      disneyResort: resort?.disneyOwned ?? false,
      ticket: c.ticketOption ? { option: c.ticketOption, days: request.tickets.parkDays, hopper: c.ticketOption !== "base", usage, usageSource } : null,
      parkOnArrivalDay: request.tickets.parkOnArrivalDay,
      parkOnDepartureDay: request.tickets.parkOnDepartureDay,
    },
  };
}

// ───────────────────────────── Demonstration scenario ─────────────────────────────

const DEMO_SOURCE = "Illustrative demo scenario (NOT real park hours or wait times)";
const demo = (observedAt: string): InfoProvenance => ({ status: "illustrative", source: DEMO_SOURCE, observedAt });

/**
 * A clearly labelled demonstration: a fictional 4-park-day trip with
 * illustrative hours and waits so the planner can be tried without entering
 * anything. Every value is marked illustrative and the result is flagged as a demo.
 */
export function demoInput(today: IsoDate = "2026-10-30"): ItineraryInput {
  const arrival: IsoDate = "2027-02-01";
  const context: TripContext = {
    source: { kind: "demo", label: "Demonstration trip (fictional)" },
    arrival,
    departure: addDays(arrival, 5),
    party: { adults: 2, children: 1, infants: 0 },
    resortId: "pop-century",
    resortName: "Disney's Pop Century Resort",
    disneyResort: true,
    ticket: {
      option: "base",
      days: 4,
      hopper: false,
      usage: { useWithinDays: 7, parkReservationRequired: false, notes: "Illustrative ticket terms" },
      usageSource: DEMO_SOURCE,
    },
    parkOnArrivalDay: false,
    parkOnDepartureDay: false,
  };
  const parkInfo: ParkInfo = emptyParkInfo();
  // Illustrative hours: a plausible-looking pattern, explicitly not real.
  const pattern: Record<string, [string, string]> = {
    "magic-kingdom": ["09:00", "22:00"],
    epcot: ["09:00", "21:00"],
    "hollywood-studios": ["08:30", "21:00"],
    "animal-kingdom": ["08:00", "19:00"],
  };
  for (let i = 1; i <= 4; i++) {
    const date = addDays(arrival, i);
    for (const p of PARKS) {
      const [open, close] = pattern[p.id]!;
      parkInfo.hours.push({ date, parkId: p.id, open, close, earlyEntryMin: null, provenance: demo(today) });
    }
  }
  // Illustrative wait estimates for the headline rides only; everything else uses the planning buffer.
  for (const [id, minutes] of [
    ["mk-seven-dwarfs", 60],
    ["mk-tron", 70],
    ["ep-cosmic-rewind", 60],
    ["hs-slinky", 60],
    ["hs-rise", 75],
    ["ak-flight-of-passage", 70],
  ] as const) {
    parkInfo.waits.push({ attractionId: id, minutes, kind: "your_estimate", date: null, provenance: demo(today) });
  }
  parkInfo.dining.push({ id: "demo-dinner", date: addDays(arrival, 2), parkId: "epcot", name: "Dinner reservation (illustrative)", time: "18:30", durationMin: 75, provenance: demo(today) });
  const prefs = defaultPreferences();
  prefs.parks = PARKS.map((p) => p.id);
  for (const id of ["mk-seven-dwarfs", "mk-peter-pan", "ep-frozen", "ep-remy", "hs-slinky", "hs-runaway-railway", "ak-flight-of-passage", "ak-safaris"]) prefs.attractions[id] = "must";
  for (const id of ["mk-haunted-mansion", "mk-pirates", "mk-jungle-cruise", "ep-soarin", "ep-test-track", "hs-toy-story-mania", "ak-navi-river"]) prefs.attractions[id] = "want";
  prefs.attractions["mk-tron"] = "avoid";
  return { context, prefs, parkInfo, demo: true };
}

/**
 * What differs between the trip an itinerary was planned for and the trip as it
 * is now. Used to warn before anything is replanned: a different ticket, park
 * entitlement or date range is never applied silently.
 */
export function contextDifferences(saved: TripContext, current: TripContext): string[] {
  const out: string[] = [];
  if (saved.arrival !== current.arrival || saved.departure !== current.departure) out.push(`Dates: ${saved.arrival} → ${saved.departure} is now ${current.arrival} → ${current.departure}`);
  if (saved.resortId !== current.resortId) out.push(`Resort: ${saved.resortName} is now ${current.resortName}`);
  const p = (c: TripContext) => `${c.party.adults} adults, ${c.party.children} children, ${c.party.infants} infants`;
  if (p(saved) !== p(current)) out.push(`Party: ${p(saved)} is now ${p(current)}`);
  const t = (c: TripContext) => (c.ticket ? `${c.ticket.days} park days, ${c.ticket.hopper ? "Park Hopper" : "one park per day"} (${c.ticket.option})` : "no tickets");
  if (t(saved) !== t(current)) out.push(`Tickets: ${t(saved)} is now ${t(current)}`);
  if (JSON.stringify(saved.ticket?.usage ?? null) !== JSON.stringify(current.ticket?.usage ?? null)) out.push("Ticket rules (use window, expiration, blocked dates or reservation requirement) have changed");
  if (saved.parkOnArrivalDay !== current.parkOnArrivalDay || saved.parkOnDepartureDay !== current.parkOnDepartureDay) out.push("Whether you visit parks on arrival or departure day has changed");
  return out;
}

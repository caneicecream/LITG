import { addDays, daysBetween, isIsoDate } from "@/domain/dates";
import { formatCents, type Cents } from "@/domain/money";
import { DINING_LABEL, TICKET_LABEL } from "@/domain/pricing/calculate";
import { parseTripRequest } from "@/domain/schema";
import type { Catalog, TicketOption, TripRequest } from "@/domain/types";
import type { RequestPatch, RequestSection } from "./types";

/**
 * Deterministic application of an AI (or rules) patch to a TripRequest.
 * Only fields the patch names change; everything else is preserved by
 * construction. Money values must appear in the user's own words. The result
 * is validated with the same schema the planner uses.
 */

export interface PatchResult {
  request: TripRequest | null;
  diff: string[];
  /** Consequential changes made to keep the request consistent (e.g. widening the window for an extra night). */
  adjustments: string[];
  errors: string[];
  /** Patch fields that were not applied, and why (e.g. a dollar amount the user never mentioned). */
  warnings: string[];
  touched: RequestSection[];
}

const TICKET_ORDER: TicketOption[] = ["park_hopper_plus", "park_hopper", "base"];
const toCents = (dollars: number): Cents => Math.round(dollars * 100);

/** Every money amount mentioned in some text, in cents ("$4,500", "4500 dollars", "4.5k", "$5k"). */
export function moneyMentions(text: string): Set<Cents> {
  const out = new Set<Cents>();
  const re = /(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(k\b|thousand\b|grand\b|dollars?\b|bucks\b|usd\b)?/gi;
  for (const m of text.matchAll(re)) {
    const whole = Number(m[2]!.replace(/,/g, ""));
    const frac = m[3] ? Number(m[3].padEnd(2, "0")) : 0;
    const suffix = m[4]?.toLowerCase();
    const thousands = suffix === "k" || suffix === "thousand" || suffix === "grand";
    // A bare small number ("6 or 7 nights") is not a money amount.
    if (!m[1] && !suffix && whole < 100) continue;
    out.add(thousands ? Math.round((whole + frac / 100) * 1000) * 100 : whole * 100 + frac);
  }
  return out;
}

export function applyPatch(
  current: TripRequest,
  patch: RequestPatch,
  catalog: Catalog,
  userTexts: string[],
): PatchResult {
  const r: TripRequest = structuredClone(current);
  const errors: string[] = [];
  const warnings: string[] = [];
  const adjustments: string[] = [];
  const touched = new Set<RequestSection>();
  const mentioned = new Set<Cents>();
  for (const t of userTexts) for (const c of moneyMentions(t)) mentioned.add(c);
  const money = (dollars: number | null, label: string): Cents | null => {
    if (dollars === null) return null;
    if (!Number.isFinite(dollars) || dollars < 0) {
      errors.push(`${label}: ${dollars} is not a valid amount`);
      return null;
    }
    const c = toCents(dollars);
    if (!mentioned.has(c)) {
      warnings.push(`${label} of ${formatCents(c)} was not applied because you didn't mention that amount.`);
      return null;
    }
    return c;
  };
  const resortById = (id: string) => catalog.resorts.find((x) => x.id === id);
  const validResortIds = (ids: string[], label: string) => {
    const bad = ids.filter((id) => !resortById(id));
    if (bad.length) errors.push(`${label}: unknown resort id(s) ${bad.join(", ")}`);
    return bad.length ? null : [...new Set(ids)];
  };
  const date = (d: string | null, label: string) => {
    if (d === null) return null;
    if (!isIsoDate(d)) {
      errors.push(`${label}: "${d}" is not a valid date`);
      return null;
    }
    return d;
  };

  // Party
  if (patch.party) {
    const p = patch.party;
    if (p.adults !== null) r.party.adults = p.adults;
    if (p.children !== null) r.party.children = p.children;
    if (p.infants !== null) r.party.infants = p.infants;
    touched.add("party");
  }

  // Date window
  if (patch.dates) {
    const d = patch.dates;
    const ea = date(d.earliestArrival, "Earliest arrival");
    const ld = date(d.latestDeparture, "Latest departure");
    if (ea) r.dates.earliestArrival = ea;
    if (ld) r.dates.latestDeparture = ld;
    if (d.minNights !== null) r.dates.minNights = d.minNights;
    if (d.maxNights !== null) r.dates.maxNights = d.maxNights;
    touched.add("dates");
  }

  // Preferred plan (the savings baseline)
  let preferredNightsChanged = false;
  if (patch.preferred) {
    const p = patch.preferred;
    const arrival = date(p.arrival, "Preferred arrival");
    if (arrival) r.preferred.arrival = arrival;
    if (p.nights !== null) {
      r.preferred.nights = p.nights;
      preferredNightsChanged = true;
    }
    if (p.resortId !== null) {
      const resort = resortById(p.resortId);
      if (!resort) errors.push(`Preferred resort: unknown resort id ${p.resortId}`);
      else {
        r.preferred.resortId = resort.id;
        const room = p.roomTypeId ?? (resort.roomTypes.some((x) => x.id === r.preferred.roomTypeId) ? r.preferred.roomTypeId : null);
        if (room && resort.roomTypes.some((x) => x.id === room)) r.preferred.roomTypeId = room;
        else {
          r.preferred.roomTypeId = resort.roomTypes[0]!.id;
          adjustments.push(`Room set to ${resort.roomTypes[0]!.name} (the first room type at ${resort.name}); change it if you had another in mind.`);
        }
        if (r.preferred.bookingMethod === "package" && !resort.disneyOwned) {
          r.preferred.bookingMethod = "separate";
          adjustments.push(`${resort.name} isn't sold as a Disney package, so the preferred booking is now room + tickets separately.`);
        }
        if (r.preferred.bookingMethod === "points" && !resort.dvcPoints) {
          r.preferred.bookingMethod = "separate";
          adjustments.push(`${resort.name} can't be booked with DVC points, so the preferred booking is now room + tickets separately.`);
        }
      }
    } else if (p.roomTypeId !== null) {
      const resort = r.preferred.resortId ? resortById(r.preferred.resortId) : undefined;
      if (!resort?.roomTypes.some((x) => x.id === p.roomTypeId)) errors.push(`Preferred room: unknown room ${p.roomTypeId}`);
      else r.preferred.roomTypeId = p.roomTypeId;
    }
    if (p.ticketOption !== null) r.preferred.ticketOption = p.ticketOption;
    if (p.bookingMethod !== null) r.preferred.bookingMethod = p.bookingMethod;
    if (p.dining !== null) r.preferred.dining = p.dining;
    touched.add("preferred");
  }

  // Relative changes, resolved here so the model never does date arithmetic.
  let windowFit = preferredNightsChanged;
  if (patch.shiftPreferredArrivalDays !== null && patch.shiftPreferredArrivalDays !== 0) {
    if (!r.preferred.arrival) errors.push("There's no preferred arrival date to move yet. What date were you planning to arrive?");
    else {
      r.preferred.arrival = addDays(r.preferred.arrival, patch.shiftPreferredArrivalDays);
      windowFit = true;
      touched.add("preferred");
    }
  }
  if (patch.adjustNights !== null && patch.adjustNights !== 0) {
    const base = r.preferred.nights ?? r.dates.minNights;
    const nights = base + patch.adjustNights;
    if (nights < 1) errors.push("The stay can't be shorter than one night.");
    else {
      r.preferred.nights = nights;
      windowFit = true;
      touched.add("preferred");
    }
  }
  if (windowFit && r.preferred.nights) {
    const nights = r.preferred.nights;
    if (nights < r.dates.minNights) {
      adjustments.push(`Minimum stay lowered from ${r.dates.minNights} to ${nights} nights to include your preferred length.`);
      r.dates.minNights = nights;
    }
    if (nights > r.dates.maxNights) {
      adjustments.push(`Maximum stay raised from ${r.dates.maxNights} to ${nights} nights to include your preferred length.`);
      r.dates.maxNights = nights;
    }
    if (r.preferred.arrival) {
      if (r.preferred.arrival < r.dates.earliestArrival) {
        adjustments.push(`Earliest arrival moved from ${r.dates.earliestArrival} to ${r.preferred.arrival} to include your preferred arrival.`);
        r.dates.earliestArrival = r.preferred.arrival;
      }
      const depart = addDays(r.preferred.arrival, nights);
      if (depart > r.dates.latestDeparture) {
        adjustments.push(`Latest departure moved from ${r.dates.latestDeparture} to ${depart} to fit the preferred stay.`);
        r.dates.latestDeparture = depart;
      }
    }
    touched.add("dates");
  }

  // Resorts
  if (patch.resorts) {
    const p = patch.resorts;
    if (p.allowedResortIds !== null && p.allowTiers !== null) {
      errors.push("Allowed resorts were given both as a list and as tiers; use one.");
    } else if (p.allowedResortIds !== null) {
      const ids = validResortIds(p.allowedResortIds, "Allowed resorts");
      if (ids) r.resorts.allowedResortIds = ids;
    } else if (p.allowTiers !== null) {
      const ids = catalog.resorts.filter((x) => p.allowTiers!.includes(x.tier)).map((x) => x.id);
      if (ids.length === 0) errors.push("No resorts are in those tiers.");
      else r.resorts.allowedResortIds = ids;
    }
    if (p.requireDisneyOwned !== null) r.resorts.requireOnProperty = p.requireDisneyOwned;
    if (p.preferredResortIds !== null) {
      const ids = validResortIds(p.preferredResortIds, "Preferred resorts");
      if (ids) r.resorts.preferredResortIds = ids;
    }
    if (p.considerPoints !== null) r.resorts.considerPoints = p.considerPoints;
    touched.add("resorts");
  }

  // Tickets
  if (patch.tickets) {
    const p = patch.tickets;
    if (p.parkDays !== null) r.tickets.parkDays = p.parkDays;
    if (p.allowedOptions !== null) {
      r.tickets.allowedOptions = TICKET_ORDER.filter((o) => p.allowedOptions!.includes(o)).reverse();
      const pref = r.preferred.ticketOption;
      if (pref && r.tickets.allowedOptions.length > 0 && !r.tickets.allowedOptions.includes(pref)) {
        const next = TICKET_ORDER.slice(TICKET_ORDER.indexOf(pref)).find((o) => r.tickets.allowedOptions.includes(o)) ?? r.tickets.allowedOptions[r.tickets.allowedOptions.length - 1]!;
        r.preferred.ticketOption = next;
        adjustments.push(`Your preferred ticket is now ${TICKET_LABEL[next]}, since ${TICKET_LABEL[pref]} is no longer accepted.`);
        touched.add("preferred");
      }
    }
    if (p.parkOnArrivalDay !== null) r.tickets.parkOnArrivalDay = p.parkOnArrivalDay;
    if (p.parkOnDepartureDay !== null) r.tickets.parkOnDepartureDay = p.parkOnDepartureDay;
    if (p.allowThirdParty !== null) r.tickets.allowThirdParty = p.allowThirdParty;
    touched.add("tickets");
  }

  // Dining
  if (patch.dining) {
    const p = patch.dining;
    if (p.policy !== null) {
      r.dining.policy = p.policy;
      if (p.policy === "exclude" && r.preferred.dining && r.preferred.dining !== "out_of_pocket") {
        r.preferred.dining = "out_of_pocket";
        adjustments.push("Your preferred plan no longer includes a dining plan.");
        touched.add("preferred");
      }
      if (p.policy === "require" && (!r.preferred.dining || r.preferred.dining === "out_of_pocket") && patch.preferred?.dining == null) {
        r.preferred.dining = "dining_plan";
        r.preferred.bookingMethod = "package";
        adjustments.push(`Your preferred plan now includes the ${DINING_LABEL.dining_plan} (as a package); choose the Quick-Service plan instead if you prefer.`);
        touched.add("preferred");
      }
    }
    const adult = money(p.foodPerAdultPerNightDollars, "Food estimate per adult per night");
    if (adult !== null) r.dining.outOfPocketPerAdultPerNightCents = adult;
    const child = money(p.foodPerChildPerNightDollars, "Food estimate per child per night");
    if (child !== null) r.dining.outOfPocketPerChildPerNightCents = child;
    touched.add("dining");
  }

  // Transport
  if (patch.transport) {
    if (patch.transport.mode !== null) r.transport.mode = patch.transport.mode;
    const rental = money(patch.transport.rentalPerDayDollars, "Rental car cost per day");
    if (rental !== null) r.transport.rentalPerDayCents = rental;
    touched.add("transport");
  }

  // Budget
  if (patch.budget) {
    const b = patch.budget;
    if (b.clearTarget) delete r.budget.targetCents;
    else {
      const t = money(b.targetDollars, "Budget target");
      if (t !== null) r.budget.targetCents = t;
    }
    if (b.clearHardLimit) delete r.budget.hardLimitCents;
    else {
      const h = money(b.hardLimitDollars, "Hard spending limit");
      if (h !== null) r.budget.hardLimitCents = h;
    }
    touched.add("budget");
  }

  // Objective & weights
  if (patch.objective) {
    if (patch.objective.objective !== null) r.objective = patch.objective.objective;
    const w = patch.objective.weights;
    if (w) {
      for (const k of ["price", "resort", "convenience", "ticket", "dining", "dates"] as const) {
        const v = w[k];
        if (v === null) continue;
        if (v < 0 || v > 100) errors.push(`Weight for ${k} must be between 0 and 100`);
        else r.weights[k] = Math.round(v);
      }
    }
    touched.add("objective");
  }

  if (patch.eligibility) {
    for (const k of ["florida_resident", "annual_passholder", "military"] as const) {
      const v = patch.eligibility[k];
      if (v !== null) r.eligibility[k] = v;
    }
    touched.add("eligibility");
  }
  if (patch.includeIllustrative !== null) {
    r.data.includeIllustrative = patch.includeIllustrative;
    touched.add("data");
  }

  if (errors.length > 0) return { request: null, diff: [], adjustments, errors, warnings, touched: [...touched] };
  const parsed = parseTripRequest(r);
  if (!parsed.ok) return { request: null, diff: [], adjustments, errors: parsed.errors, warnings, touched: [...touched] };
  return { request: parsed.request, diff: diffRequests(current, parsed.request, catalog), adjustments, errors: [], warnings, touched: [...touched] };
}

// ─────────────────────────────── Describing requests ───────────────────────────────

export interface RequestEntry {
  key: string;
  section: RequestSection;
  label: string;
  value: string;
  kind: "requirement" | "preference" | "setting";
}

const ticketList = (xs: TicketOption[]) => (xs.length ? xs.map((x) => TICKET_LABEL[x]).join(", ") : "none");

/** A flat, human-readable view of a request, tagging each item as a hard requirement or a soft preference. */
export function describeRequest(r: TripRequest, catalog: Catalog): RequestEntry[] {
  const name = (id: string) => catalog.resorts.find((x) => x.id === id)?.name.replace("Disney's ", "") ?? id;
  const tiersOf = (ids: string[]) => {
    const tiers = [...new Set(ids.map((id) => catalog.resorts.find((x) => x.id === id)?.tier))];
    const full = tiers.every((t) => catalog.resorts.filter((x) => x.tier === t).every((x) => ids.includes(x.id)));
    return full && tiers.length <= 2 ? `${tiers.join(" + ")} resorts (${ids.length})` : ids.length <= 4 ? ids.map(name).join(", ") : `${ids.length} resorts`;
  };
  const e: RequestEntry[] = [
    { key: "party", section: "party", label: "Travelers", value: `${r.party.adults} adult(s), ${r.party.children} child(ren) 3–9, ${r.party.infants} under 3`, kind: "requirement" },
    { key: "window", section: "dates", label: "Date window", value: `arrive from ${r.dates.earliestArrival}, depart by ${r.dates.latestDeparture}`, kind: "requirement" },
    { key: "nights", section: "dates", label: "Stay length", value: r.dates.minNights === r.dates.maxNights ? `${r.dates.minNights} nights` : `${r.dates.minNights}–${r.dates.maxNights} nights`, kind: "requirement" },
    { key: "parkDays", section: "tickets", label: "Park days", value: String(r.tickets.parkDays), kind: "requirement" },
    { key: "tickets", section: "tickets", label: "Accepted tickets", value: r.tickets.parkDays > 0 ? ticketList(r.tickets.allowedOptions) : "no tickets", kind: "requirement" },
    { key: "allowed", section: "resorts", label: "Allowed resorts", value: r.resorts.allowedResortIds.length ? tiersOf(r.resorts.allowedResortIds) : "any", kind: "requirement" },
    { key: "disneyOwned", section: "resorts", label: "Disney-owned resort", value: r.resorts.requireOnProperty ? "required" : "not required", kind: "requirement" },
    { key: "points", section: "resorts", label: "DVC point stays", value: r.resorts.considerPoints ? "considered" : "not considered", kind: "setting" },
    { key: "diningPolicy", section: "dining", label: "Dining plan", value: { require: "required", prefer: "preferred", consider: "only if it saves money", exclude: "excluded" }[r.dining.policy], kind: r.dining.policy === "prefer" || r.dining.policy === "consider" ? "preference" : "requirement" },
    { key: "food", section: "dining", label: "Food estimate", value: `${formatCents(r.dining.outOfPocketPerAdultPerNightCents)}/adult/night, ${formatCents(r.dining.outOfPocketPerChildPerNightCents)}/child/night`, kind: "setting" },
    { key: "transport", section: "transport", label: "Transportation", value: { no_car: "no car", own_car: "own car", rental_car: `rental car (${formatCents(r.transport.rentalPerDayCents)}/day)` }[r.transport.mode], kind: "setting" },
    { key: "hardLimit", section: "budget", label: "Hard spending limit", value: r.budget.hardLimitCents !== undefined ? formatCents(r.budget.hardLimitCents) : "none", kind: "requirement" },
    { key: "target", section: "budget", label: "Budget target", value: r.budget.targetCents !== undefined ? formatCents(r.budget.targetCents) : "none", kind: "preference" },
    { key: "prefResorts", section: "resorts", label: "Preferred resorts", value: r.resorts.preferredResortIds.length ? r.resorts.preferredResortIds.map(name).join(", ") : "none", kind: "preference" },
    { key: "prefArrival", section: "preferred", label: "Preferred arrival", value: r.preferred.arrival ?? "not set", kind: "preference" },
    { key: "prefNights", section: "preferred", label: "Preferred nights", value: r.preferred.nights ? String(r.preferred.nights) : "not set", kind: "preference" },
    { key: "prefResort", section: "preferred", label: "Preferred resort/room", value: r.preferred.resortId ? `${name(r.preferred.resortId)} – ${catalog.resorts.find((x) => x.id === r.preferred.resortId)?.roomTypes.find((x) => x.id === r.preferred.roomTypeId)?.name ?? r.preferred.roomTypeId}` : "not set", kind: "preference" },
    { key: "prefTicket", section: "preferred", label: "Preferred ticket", value: r.preferred.ticketOption ? TICKET_LABEL[r.preferred.ticketOption] : "not set", kind: "preference" },
    { key: "prefBooking", section: "preferred", label: "Preferred booking", value: r.preferred.bookingMethod ?? "separate", kind: "preference" },
    { key: "prefDining", section: "preferred", label: "Preferred dining", value: DINING_LABEL[r.preferred.dining ?? "out_of_pocket"], kind: "preference" },
    { key: "objective", section: "objective", label: "Ranking", value: r.objective === "best_value" ? "best value" : "lowest total cost", kind: "preference" },
    { key: "weights", section: "objective", label: "Value weights", value: Object.entries(r.weights).map(([k, v]) => `${k} ${v}`).join(", "), kind: "preference" },
    { key: "eligibility", section: "eligibility", label: "Offer eligibility", value: Object.entries(r.eligibility).map(([k, v]) => `${k.replace("_", " ")}: ${v}`).join(", "), kind: "setting" },
    { key: "illustrative", section: "data", label: "Illustrative demo prices", value: r.data.includeIllustrative ? "included" : "excluded", kind: "setting" },
  ];
  return e;
}

/** Readable "Label: before → after" lines for everything that differs. */
export function diffRequests(before: TripRequest, after: TripRequest, catalog: Catalog): string[] {
  const a = new Map(describeRequest(before, catalog).map((x) => [x.key, x]));
  return describeRequest(after, catalog)
    .filter((x) => a.get(x.key)?.value !== x.value)
    .map((x) => `${x.label}: ${a.get(x.key)?.value ?? "—"} → ${x.value}`);
}

/** Key sections still at their defaults (not stated by the user), most important first. */
export function unconfirmedSections(confirmed: RequestSection[]): RequestSection[] {
  const important: RequestSection[] = ["party", "dates", "tickets", "budget", "resorts", "dining"];
  return important.filter((s) => !confirmed.includes(s));
}

/** Gentle questions about defaults the user hasn't confirmed (never more than two at a time). */
export function defaultQuestions(r: TripRequest, confirmed: RequestSection[]): string[] {
  const q: Record<string, string> = {
    party: `I'm assuming ${r.party.adults} adult(s) and ${r.party.children} child(ren). Who's traveling?`,
    dates: `I'm searching arrivals from ${r.dates.earliestArrival} to departures by ${r.dates.latestDeparture}, ${r.dates.minNights === r.dates.maxNights ? `${r.dates.minNights}` : `${r.dates.minNights}–${r.dates.maxNights}`} nights. When would you like to go?`,
    tickets: `I'm assuming ${r.tickets.parkDays} park day(s). How many days do you want in the parks?`,
    budget: "Do you have a budget in mind (a target, or a limit you can't exceed)?",
  };
  return unconfirmedSections(confirmed)
    .filter((s) => q[s])
    .slice(0, 2)
    .map((s) => q[s]!);
}

/** Days between two dates helper re-exported for prompts. */
export const nightsBetween = daysBetween;

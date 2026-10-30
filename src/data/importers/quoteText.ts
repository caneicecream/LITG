import { addDays, daysBetween, todayIso } from "@/domain/dates";
import type { Cents } from "@/domain/money";
import type { Provenance } from "@/domain/provenance";
import type { BookingMethod, DiningChoice, PaymentTerms, StayQuote, TicketOption, TicketUsage } from "@/domain/types";
import { CATALOG } from "../catalog";
import { priceEntrySchema } from "../entrySchema";
import { matchByName, parseDate, parseInteger, parseMoney, parseYesNo } from "./values";

/**
 * Paste-friendly quote entry: "Key: value" lines, several quotes separated by a
 * line of dashes ("---"). Every essential field must be stated; nothing is
 * inferred. The result is a draft for the user to review, never saved
 * automatically. `formatQuoteText` writes the same format (templates, duplicates).
 */

export type QuoteDraft = Omit<StayQuote, "id" | "history">;

export interface ParsedQuote {
  /** The validated draft, present only when there are no errors. */
  entry: QuoteDraft | null;
  errors: string[];
  warnings: string[];
}

const KEYS: Record<string, string> = {
  label: "label", name: "label", title: "label",
  resort: "resort", hotel: "resort",
  room: "room", roomtype: "room", roomcategory: "room", villa: "room",
  checkin: "checkIn", arrival: "checkIn", arrive: "checkIn",
  checkout: "checkOut", departure: "checkOut", depart: "checkOut",
  nights: "nights",
  adults: "adults",
  children: "children", kids: "children",
  booking: "booking", bookingtype: "booking", type: "booking",
  tickets: "tickets", ticket: "tickets", admission: "tickets",
  dining: "dining", diningplan: "dining",
  total: "total", price: "total", totalprice: "total", quotedtotal: "total",
  taxesincluded: "taxIncluded", taxincluded: "taxIncluded", includestax: "taxIncluded", includestaxes: "taxIncluded",
  taxes: "taxes", tax: "taxes",
  source: "source",
  url: "url", link: "url", sourceurl: "url",
  observed: "observed", observedon: "observed", quotedon: "observed", date: "observed",
  status: "status",
  notes: "notes", note: "notes",
  deposit: "deposit",
  depositdue: "depositDue",
  finalpaymentdue: "finalDue", balancedue: "finalDue", finalpayment: "finalDue",
  amountpaid: "paid", paid: "paid",
  refundable: "refundability", refundability: "refundability",
  freecancellationuntil: "freeUntil", cancelby: "freeUntil",
  cancellationpenalty: "penalty", penalty: "penalty",
  booked: "booked", existingreservation: "booked",
  points: "points", pointsrequired: "points",
  priceperpoint: "perPoint", costperpoint: "perPoint",
  usewithin: "useWithin", ticketexpires: "expires", expires: "expires",
  parkreservations: "parkRes", parkreservation: "parkRes",
};
const REPEATABLE = new Set(["penalty"]);

export function parseQuoteText(text: string): ParsedQuote[] {
  return text
    .split(/^\s*-{3,}\s*$/m)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(parseOneQuote);
}

function parseOneQuote(block: string): ParsedQuote {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fields = new Map<string, string[]>();
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i < 0) {
      warnings.push(`Ignored a line without "Key: value": ${line}`);
      continue;
    }
    const key = KEYS[line.slice(0, i).toLowerCase().replace(/[^a-z]/g, "")];
    const value = line.slice(i + 1).trim();
    if (!key) {
      warnings.push(`Ignored unrecognized field: ${line.slice(0, i).trim()}`);
      continue;
    }
    if (fields.has(key) && !REPEATABLE.has(key)) errors.push(`"${line.slice(0, i).trim()}" appears more than once`);
    fields.set(key, [...(fields.get(key) ?? []), value]);
  }
  const get = (k: string) => fields.get(k)?.[0];
  const required = (k: string, label: string) => {
    const v = get(k);
    if (v === undefined || v === "") errors.push(`Missing required field: ${label}`);
    return v === "" ? undefined : v;
  };
  const bad = (label: string, value: string, expected: string) => errors.push(`${label}: "${value}" is not ${expected}`);

  // Resort and room.
  const resortText = required("resort", "Resort");
  const resortMatch = resortText ? matchByName(resortText, CATALOG.resorts) : null;
  if (resortMatch && "error" in resortMatch) errors.push(`Resort ${resortMatch.error}`);
  const resort = resortMatch && "item" in resortMatch ? resortMatch.item : undefined;
  const roomText = required("room", "Room");
  let roomTypeId: string | undefined;
  if (resort && roomText) {
    const m = matchByName(roomText, resort.roomTypes);
    if ("error" in m) errors.push(`Room ${m.error} at ${resort.name} (rooms: ${resort.roomTypes.map((r) => r.name).join(", ")})`);
    else roomTypeId = m.item.id;
  }

  // Dates.
  const checkInText = required("checkIn", "Check-in");
  const checkIn = checkInText ? parseDate(checkInText) : null;
  if (checkInText && !checkIn) bad("Check-in", checkInText, "a date (e.g. 2027-01-17 or Jan 17, 2027)");
  const checkOutText = get("checkOut");
  const nightsText = get("nights");
  let nights: number | null = null;
  if (!checkOutText && !nightsText) errors.push("Missing required field: Check-out or Nights");
  if (nightsText) {
    nights = parseInteger(nightsText, 1, 30);
    if (nights === null) bad("Nights", nightsText, "a whole number from 1 to 30");
  }
  if (checkOutText) {
    const checkOut = parseDate(checkOutText);
    if (!checkOut) bad("Check-out", checkOutText, "a date");
    else if (checkIn) {
      const n = daysBetween(checkIn, checkOut);
      if (n < 1) errors.push("Check-out must be after check-in");
      else if (nights !== null && nights !== n) errors.push(`Nights (${nights}) doesn't match check-in to check-out (${n} nights)`);
      else nights = n;
    }
  }

  // Party.
  const adultsText = required("adults", "Adults");
  const adults = adultsText ? parseInteger(adultsText, 1, 10) : null;
  if (adultsText && adults === null) bad("Adults", adultsText, "a whole number from 1 to 10");
  const childrenText = required("children", "Children (enter 0 if none)");
  const children = childrenText ? parseInteger(childrenText, 0, 10) : null;
  if (childrenText && children === null) bad("Children", childrenText, "a whole number from 0 to 10");

  // Booking type, tickets, dining.
  const bookingText = required("booking", "Booking (package, room only, or points)");
  const bookingMethod = bookingText ? parseBooking(bookingText) : null;
  if (bookingText && !bookingMethod) bad("Booking", bookingText, "package, room only, or points");
  const ticketsText = get("tickets");
  let ticket: StayQuote["ticket"];
  if (bookingMethod === "package") {
    if (!ticketsText) errors.push("Missing required field: Tickets (a package includes tickets, e.g. \"Park Hopper, 5 days\")");
    else {
      const t = parseTickets(ticketsText);
      if (!t) bad("Tickets", ticketsText, 'a ticket like "Park Hopper Plus, 5 days" or "4-day Base ticket"');
      else ticket = t;
    }
  } else if (ticketsText && !/^(none|no|n\/a)$/i.test(ticketsText)) {
    errors.push("A room-only or point-rental quote can't include tickets (use Booking: package)");
  }
  const diningText = get("dining");
  let dining: DiningChoice = "out_of_pocket";
  if (bookingMethod === "package") {
    if (!diningText) errors.push('Missing required field: Dining (e.g. "none" or "Disney Dining Plan")');
    else {
      const d = parseDining(diningText);
      if (!d) bad("Dining", diningText, "none, Quick-Service Dining Plan, or Disney Dining Plan");
      else dining = d;
    }
  } else if (diningText && parseDining(diningText) !== "out_of_pocket") {
    errors.push("Dining plans are only sold with packages");
  }
  if (ticket) {
    const usage = parseUsage(get("useWithin"), get("expires"), get("parkRes"), errors);
    if (usage) ticket = { ...ticket, usage };
  } else if (get("useWithin") || get("expires") || get("parkRes")) {
    warnings.push("Ticket usage details were ignored because the quote has no tickets");
  }

  // Money and taxes.
  const totalText = required("total", "Total");
  const totalCents = totalText ? parseMoney(totalText) : null;
  if (totalText && (totalCents === null || totalCents <= 0)) bad("Total", totalText, "an amount like $2,450.00");
  const taxIncludedText = required("taxIncluded", "Taxes included (yes/no)");
  const taxIncluded = taxIncludedText ? parseYesNo(taxIncludedText) : null;
  if (taxIncludedText && taxIncluded === null) bad("Taxes included", taxIncludedText, "yes or no");
  const taxesText = get("taxes");
  let taxCents: Cents | undefined;
  if (taxesText) {
    const t = parseMoney(taxesText);
    if (t === null) bad("Taxes", taxesText, "an amount");
    else if (taxIncluded) errors.push("Taxes were given separately, but the total is marked as including taxes");
    else taxCents = t;
  }

  // DVC points.
  let points: StayQuote["points"];
  const pointsText = get("points");
  const perPointText = get("perPoint");
  if (pointsText || perPointText) {
    if (bookingMethod !== "points") errors.push("Points are only recorded for point-rental quotes (Booking: points)");
    const p = pointsText ? parseInteger(pointsText, 1, 10_000) : null;
    const c = perPointText ? parseMoney(perPointText) : null;
    if (p === null || c === null || c <= 0) errors.push("Give both Points (a whole number) and Price per point (an amount)");
    else points = { pointsRequired: p, centsPerPoint: c };
  }

  // Provenance.
  const source = required("source", "Source (where the quote came from)");
  const observedText = required("observed", "Observed (the date you saw the quote)");
  const observedAt = observedText ? parseDate(observedText) : null;
  if (observedText && !observedAt) bad("Observed", observedText, "a date");
  if (observedAt && observedAt > todayIso()) errors.push("Observed date is in the future");
  const statusText = get("status")?.toLowerCase();
  let status: Provenance["status"] = "manual";
  if (statusText) {
    if (statusText.startsWith("manual") || statusText.startsWith("real") || statusText.startsWith("quote")) status = "manual";
    else if (statusText.startsWith("estimate")) status = "estimated";
    else bad("Status", statusText, '"manual" (copied from a real quote) or "estimated"');
  }
  const url = get("url");
  if (url && !/^https?:\/\/\S+$/i.test(url)) bad("URL", url, "a web address starting with http(s)://");

  // Payment and cancellation terms (optional, but complete when given).
  const terms = parseTerms(fields, errors);
  const bookedText = get("booked");
  const booked = bookedText ? parseYesNo(bookedText) : null;
  if (bookedText && booked === null) bad("Booked", bookedText, "yes or no");

  if (errors.length > 0) return { entry: null, errors, warnings };

  const draft: QuoteDraft = {
    kind: "stay_quote",
    label: get("label") || `${resort!.name.replace("Disney's ", "")} ${bookingMethod === "package" ? "package" : bookingMethod === "points" ? "point rental" : "room"} ${checkIn}`,
    resortId: resort!.id,
    roomTypeId: roomTypeId!,
    checkIn: checkIn!,
    nights: nights!,
    adults: adults!,
    children: children!,
    bookingMethod: bookingMethod!,
    ...(ticket ? { ticket } : {}),
    dining,
    totalCents: totalCents!,
    taxIncluded: taxIncluded!,
    ...(taxCents !== undefined ? { taxCents } : {}),
    ...(points ? { points } : {}),
    ...(terms ? { terms } : {}),
    ...(booked ? { booked: true } : {}),
    provenance: {
      status,
      source: source!,
      observedAt: observedAt!,
      ...(url ? { sourceUrl: url } : {}),
      ...(get("notes") ? { notes: get("notes")! } : {}),
    },
  };
  // Final check with the same schema the server uses.
  const checked = priceEntrySchema.safeParse(draft);
  if (!checked.success) {
    return { entry: null, errors: checked.error.issues.map((i) => `${i.path.join(".") || "quote"}: ${i.message}`), warnings };
  }
  return { entry: draft, errors: [], warnings };
}

function parseBooking(t: string): BookingMethod | null {
  const v = t.toLowerCase();
  if (/package/.test(v)) return "package";
  if (/point|dvc|rental/.test(v)) return "points";
  if (/room/.test(v)) return "separate";
  return null;
}

function parseTickets(t: string): { option: TicketOption; days: number } | null {
  const v = t.toLowerCase();
  const daysMatch = v.match(/(\d+)\s*-?\s*days?/);
  const days = daysMatch ? Number(daysMatch[1]) : NaN;
  if (!(days >= 1 && days <= 10)) return null;
  const option: TicketOption | null = /plus/.test(v) ? "park_hopper_plus" : /hopper/.test(v) ? "park_hopper" : /base|1 park per day|one park/.test(v) ? "base" : null;
  return option ? { option, days } : null;
}

function parseDining(t: string): DiningChoice | null {
  const v = t.toLowerCase();
  if (/^(none|no|n\/a|no dining plan|pay as you go)$/.test(v)) return "out_of_pocket";
  if (/quick/.test(v)) return "quick_service_plan";
  if (/dining plan|ddp/.test(v)) return "dining_plan";
  return null;
}

function parseUsage(useWithin: string | undefined, expires: string | undefined, parkRes: string | undefined, errors: string[]): TicketUsage | undefined {
  if (!useWithin && !expires && !parkRes) return undefined;
  let useWithinDays: number | null = null;
  if (useWithin) {
    const m = useWithin.match(/^(\d+)\s*(days?)?$/i);
    if (!m) errors.push(`Use within: "${useWithin}" is not a number of days`);
    else useWithinDays = Number(m[1]);
  }
  const expiresOn = expires ? parseDate(expires) : undefined;
  if (expires && !expiresOn) errors.push(`Ticket expires: "${expires}" is not a date`);
  let parkReservationRequired: boolean | null = null;
  if (parkRes) {
    const v = parkRes.toLowerCase();
    parkReservationRequired = /not|no\b/.test(v) ? false : /required|yes/.test(v) ? true : null;
    if (parkReservationRequired === null && !/unknown/.test(v)) errors.push(`Park reservations: "${parkRes}" should be "required", "not required" or "unknown"`);
  }
  return { useWithinDays, ...(expiresOn ? { expiresOn } : {}), parkReservationRequired };
}

function parseTerms(fields: Map<string, string[]>, errors: string[]): PaymentTerms | undefined {
  const keys = ["deposit", "depositDue", "finalDue", "paid", "refundability", "freeUntil", "penalty"];
  if (!keys.some((k) => fields.has(k))) return undefined;
  const get = (k: string) => fields.get(k)?.[0];
  const money = (k: string, label: string) => {
    const v = get(k);
    if (!v) return undefined;
    const c = parseMoney(v);
    if (c === null) errors.push(`${label}: "${v}" is not an amount`);
    return c ?? undefined;
  };
  const date = (k: string, label: string) => {
    const v = get(k);
    if (!v) return undefined;
    const d = parseDate(v);
    if (!d) errors.push(`${label}: "${v}" is not a date`);
    return d ?? undefined;
  };
  const refText = get("refundability");
  let refundability: PaymentTerms["refundability"] = "unknown";
  if (refText) {
    const v = refText.toLowerCase();
    if (/^(non|no\b|not)/.test(v)) refundability = "non_refundable";
    else if (/partial/.test(v)) refundability = "partially_refundable";
    else if (/^(yes|refundable|fully)/.test(v)) refundability = "refundable";
    else if (!/unknown/.test(v)) errors.push(`Refundable: "${refText}" should be yes, no, partial or unknown`);
  }
  const penalties: PaymentTerms["cancellationPenalties"] = [];
  for (const p of fields.get("penalty") ?? []) {
    // "$200 from 2027-01-01" or "100% from Jan 1, 2027"
    const m = p.match(/^(.+?)\s+(?:from|after|starting)\s+(.+)$/i);
    const fromDate = m ? parseDate(m[2]!) : null;
    const amount = m?.[1]!.trim() ?? "";
    const pct = amount.match(/^(\d+(?:\.\d+)?)\s*%$/);
    const cents = pct ? null : parseMoney(amount);
    if (!m || !fromDate || (!pct && cents === null)) {
      errors.push(`Cancellation penalty: "${p}" should look like "$200 from 2027-01-01" or "100% from 2027-02-01"`);
      continue;
    }
    penalties.push(pct ? { fromDate, pct: Number(pct[1]) } : { fromDate, cents: cents! });
  }
  const depositCents = money("deposit", "Deposit");
  const amountPaidCents = money("paid", "Amount paid");
  const depositDueDate = date("depositDue", "Deposit due");
  const finalPaymentDueDate = date("finalDue", "Final payment due");
  const freeCancellationUntil = date("freeUntil", "Free cancellation until");
  return {
    depositCents: depositCents ?? null,
    ...(depositDueDate ? { depositDueDate } : {}),
    installments: [],
    ...(finalPaymentDueDate ? { finalPaymentDueDate } : {}),
    ...(amountPaidCents !== undefined ? { amountPaidCents } : {}),
    refundability,
    ...(freeCancellationUntil ? { freeCancellationUntil } : {}),
    cancellationPenalties: penalties,
  };
}

const money = (c: Cents) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TICKET_TEXT: Record<TicketOption, string> = { base: "Base ticket", park_hopper: "Park Hopper", park_hopper_plus: "Park Hopper Plus" };
const DINING_TEXT: Record<DiningChoice, string> = { out_of_pocket: "none", quick_service_plan: "Quick-Service Dining Plan", dining_plan: "Disney Dining Plan" };

/** Write a quote in the paste format. Omitted fields are left out, not filled in. */
export function formatQuoteText(q: Partial<QuoteDraft>): string {
  const resort = CATALOG.resorts.find((r) => r.id === q.resortId);
  const room = resort?.roomTypes.find((r) => r.id === q.roomTypeId);
  const lines: string[] = [];
  const add = (k: string, v: string | number | undefined | null) => v !== undefined && v !== null && v !== "" && lines.push(`${k}: ${v}`);
  add("Label", q.label);
  add("Resort", resort?.name);
  add("Room", room?.name);
  add("Check-in", q.checkIn);
  add("Check-out", q.checkIn && q.nights ? addDays(q.checkIn, q.nights) : undefined);
  add("Adults", q.adults);
  add("Children", q.children);
  add("Booking", q.bookingMethod === "package" ? "package" : q.bookingMethod === "points" ? "points" : q.bookingMethod ? "room only" : undefined);
  if (q.ticket) {
    add("Tickets", `${TICKET_TEXT[q.ticket.option]}, ${q.ticket.days} days`);
    if (q.ticket.usage?.useWithinDays) add("Use within", `${q.ticket.usage.useWithinDays} days`);
    add("Ticket expires", q.ticket.usage?.expiresOn);
    if (q.ticket.usage && q.ticket.usage.parkReservationRequired !== null) add("Park reservations", q.ticket.usage.parkReservationRequired ? "required" : "not required");
  }
  if (q.bookingMethod === "package") add("Dining", q.dining ? DINING_TEXT[q.dining] : undefined);
  add("Total", q.totalCents ? money(q.totalCents) : undefined);
  add("Taxes included", q.taxIncluded === undefined ? undefined : q.taxIncluded ? "yes" : "no");
  add("Taxes", q.taxCents !== undefined ? money(q.taxCents) : undefined);
  if (q.points) {
    add("Points", q.points.pointsRequired);
    add("Price per point", money(q.points.centsPerPoint));
  }
  const t = q.terms;
  if (t) {
    add("Deposit", t.depositCents !== null ? money(t.depositCents) : undefined);
    add("Deposit due", t.depositDueDate);
    add("Final payment due", t.finalPaymentDueDate);
    add("Amount paid", t.amountPaidCents !== undefined ? money(t.amountPaidCents) : undefined);
    add("Refundable", { refundable: "yes", partially_refundable: "partial", non_refundable: "no", unknown: "unknown" }[t.refundability]);
    add("Free cancellation until", t.freeCancellationUntil);
    for (const p of t.cancellationPenalties) add("Cancellation penalty", `${p.pct !== undefined ? `${p.pct}%` : money(p.cents ?? 0)} from ${p.fromDate}`);
  }
  if (q.booked) add("Booked", "yes");
  add("Source", q.provenance?.source);
  add("URL", q.provenance?.sourceUrl);
  add("Observed", q.provenance?.observedAt);
  add("Status", q.provenance?.status);
  add("Notes", q.provenance?.notes);
  return lines.join("\n");
}

export const QUOTE_TEMPLATE = `Resort: Pop Century
Room: Standard Room
Check-in: 2027-01-17
Check-out: 2027-01-23
Adults: 2
Children: 0
Booking: package
Tickets: Park Hopper, 5 days
Dining: none
Total: $0.00
Taxes included: yes
Deposit: $200
Final payment due: 2026-12-18
Refundable: yes
Free cancellation until: 2026-12-18
Source: disneyworld.com quote
URL:
Observed: ${todayIso()}
Notes:`;

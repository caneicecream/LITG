import { addDays, formatShortDate, stayNights, type IsoDate } from "../dates";
import { formatCents, percentOf, sumCents, type Cents } from "../money";
import { effectiveStatus, STATUS_RANK, weakestStatus, type PriceStatus } from "../provenance";
import type {
  AgeCategory,
  Catalog,
  Configuration,
  CostLine,
  DiningPlan,
  PaymentSummary,
  PotentialPromotion,
  PriceData,
  Promotion,
  PromotionApplication,
  TicketPrice,
  TicketUsability,
  TripRequest,
} from "../types";
import { summarizePayments } from "./payments";
import { checkEligibility, roomDiscountForNight } from "./promotions";
import {
  matchStayQuote,
  resolveDiningNights,
  resolvePointCost,
  resolvePointNights,
  resolveRoomNights,
  resolveTaxRate,
  resolveTicket,
  resolveTicketRule,
  resolveTransport,
  type ResolveOptions,
  type ResolvedNight,
} from "./resolve";
import { evaluateTicketUsage } from "./ticketUsage";

export interface PricingContext {
  catalog: Catalog;
  data: PriceData;
  request: TripRequest;
  opts: ResolveOptions;
  bookingDate: IsoDate;
}

export interface PricedTrip {
  lines: CostLine[];
  totalCents: Cents;
  complete: boolean;
  missing: string[];
  dataStatus: PriceStatus;
  containsIllustrative: boolean;
  statusTotals: Partial<Record<PriceStatus, Cents>>;
  appliedPromotion: PromotionApplication | null;
  potentialPromotions: PotentialPromotion[];
  assumptions: string[];
  /** Hard problems discovered while pricing (e.g. no ticket usable for the park days). */
  violations: string[];
  ticketUsability: TicketUsability | null;
  payment: PaymentSummary | null;
  quoteId: string | null;
}

export const TICKET_LABEL = { base: "Base ticket", park_hopper: "Park Hopper", park_hopper_plus: "Park Hopper Plus" } as const;
export const DINING_LABEL = {
  out_of_pocket: "Pay as you go",
  quick_service_plan: "Quick-Service Dining Plan",
  dining_plan: "Disney Dining Plan",
} as const;

const uniq = (xs: string[]) => [...new Set(xs)];

function nightsSummary(nights: ResolvedNight[]): string {
  const total = sumCents(nights.map((n) => n.cents));
  const min = Math.min(...nights.map((n) => n.cents));
  const max = Math.max(...nights.map((n) => n.cents));
  const avg = Math.round(total / nights.length);
  const range = min === max ? "" : ` (nightly ${formatCents(min)}–${formatCents(max)})`;
  return `${nights.length} night${nights.length === 1 ? "" : "s"} × avg ${formatCents(avg)}${range}`;
}

/**
 * Deterministically price one configuration. Every line records its amount,
 * provenance status, source and calculation. Unknown components are recorded
 * as unavailable lines (amount null) rather than silently omitted, and
 * components covered by a package quote are shown at $0 so nothing is
 * double-counted.
 */
export function priceConfiguration(config: Configuration, ctx: PricingContext): PricedTrip {
  const { data, request: req, opts } = ctx;
  const resort = ctx.catalog.resorts.find((r) => r.id === config.resortId);
  const room = resort?.roomTypes.find((r) => r.id === config.roomTypeId);
  if (!resort || !room) throw new Error(`Unknown resort/room ${config.resortId}/${config.roomTypeId}`);

  const lines: CostLine[] = [];
  const assumptions: string[] = [];
  const party = req.party;
  const persons = party.adults + party.children + party.infants;
  const nights = stayNights(config.arrival, config.nights);
  const parkDays = config.ticketOption ? req.tickets.parkDays : 0;
  const ticketStart = addDays(config.arrival, req.tickets.parkOnArrivalDay ? 0 : 1);
  const lastParkDate = addDays(config.arrival, config.nights - (req.tickets.parkOnDepartureDay ? 0 : 1));
  const violations: string[] = [];
  let ticketUsability: TicketUsability | null = null;
  let payment: PaymentSummary | null = null;
  const lodgingJurisdiction = resort.taxJurisdictionId;
  const jurisdictionName = ctx.catalog.taxJurisdictions.find((j) => j.id === lodgingJurisdiction)?.name ?? lodgingJurisdiction;

  // ── Package / room-only quote ──────────────────────────────────────────────
  const quote = matchStayQuote(data, config, party, parkDays, opts);
  let roomFromQuote = false;
  let ticketsFromQuote = false;
  let diningFromQuote = false;
  if (quote) {
    const q = quote.item;
    const taxNote = q.taxIncluded ? "including taxes" : q.taxCents !== undefined ? "before taxes (taxes quoted separately)" : "before taxes";
    if (q.terms) payment = summarizePayments(q.terms, q.totalCents + (q.taxIncluded ? 0 : (q.taxCents ?? 0)), ctx.bookingDate);
    if (q.bookingMethod === "package") {
      roomFromQuote = ticketsFromQuote = true;
      diningFromQuote = config.dining !== "out_of_pocket";
      const parts = [`${room.name}`, `${q.ticket!.days}-day ${TICKET_LABEL[q.ticket!.option]}`];
      if (diningFromQuote) parts.push(DINING_LABEL[config.dining]);
      lines.push({
        key: "package",
        category: "package",
        label: `Package quote: ${q.label}`,
        amountCents: q.totalCents,
        status: quote.status,
        source: q.provenance.source,
        calculation: `Quoted total ${taxNote} for ${config.nights} nights: ${parts.join(" + ")} (observed ${q.provenance.observedAt})`,
      });
      ticketUsability = evaluateTicketUsage(q.ticket!.usage, q.ticket!.usage ? q.provenance.source : null, ticketStart, parkDays, lastParkDate);
      if (ticketUsability.status === "violated") violations.push(`Quoted tickets can't cover the park days: ${ticketUsability.reasons.join("; ")}`);
      const included = (key: string, category: CostLine["category"], label: string) =>
        lines.push({
          key,
          category,
          label,
          amountCents: 0,
          status: quote.status,
          source: q.provenance.source,
          calculation: "Included in the package quote above",
          includedInQuote: true,
        });
      included("room", "room", `Room: ${room.name}`);
      included("tickets", "tickets", `Tickets: ${q.ticket!.days}-day ${TICKET_LABEL[q.ticket!.option]}`);
      if (diningFromQuote) included("dining", "dining", DINING_LABEL[config.dining]);
    } else {
      roomFromQuote = true;
      const pts = q.points ? ` (${q.points.pointsRequired} points × ${formatCents(q.points.centsPerPoint)})` : "";
      lines.push({
        key: "room",
        category: "room",
        label: `${q.bookingMethod === "points" ? "Point-rental quote" : "Room quote"}: ${q.label}`,
        amountCents: q.totalCents,
        status: quote.status,
        source: q.provenance.source,
        calculation: `Quoted ${q.bookingMethod === "points" ? "point-rental" : "room-only"} total ${taxNote} for ${config.nights} nights${pts} (observed ${q.provenance.observedAt})`,
      });
    }
    // Taxes on a quote: included, quoted separately, estimated (room-only), or unknown (package).
    if (!q.taxIncluded) {
      if (q.taxCents !== undefined) {
        lines.push({ key: "quote_tax", category: "room_tax", label: "Quoted taxes", amountCents: q.taxCents, status: quote.status, source: q.provenance.source, calculation: "Taxes as shown on the quote" });
      } else if (q.bookingMethod === "points") {
        assumptions.push("DVC point reservations are assumed to carry no per-stay lodging tax (it is covered by member dues). Confirm with the rental provider.");
      } else if (q.bookingMethod === "separate") {
        const rate = resolveTaxRate(data, "lodging", lodgingJurisdiction, opts);
        if (!rate) lines.push(unavailable("quote_tax", "room_tax", "Room taxes", `No lodging tax rate for ${jurisdictionName}`));
        else
          lines.push({
            key: "quote_tax",
            category: "room_tax",
            label: "Room taxes (estimated on quote)",
            amountCents: percentOf(q.totalCents, rate.item.ratePct),
            status: weakestStatus([rate.status, quote.status]),
            source: rate.item.provenance.source,
            calculation: `${rate.item.ratePct}% ${jurisdictionName} lodging tax on the pre-tax quote of ${formatCents(q.totalCents)}${resort.taxJurisdictionNote ? ` (${resort.taxJurisdictionNote})` : ""}`,
          });
      } else {
        lines.push(
          unavailable("quote_tax", "room_tax", "Package taxes", "The package quote excludes tax and no tax amount was entered; taxes can't be split between room and tickets"),
        );
      }
    }
    assumptions.push(
      "Quoted totals are used exactly as entered (including any discount already applied at quote time); no further promotions are stacked on a quote.",
    );
  }

  // ── Room from nightly rates ────────────────────────────────────────────────
  let roomNights: ResolvedNight[] = [];
  let roomStatus: PriceStatus = "unavailable";
  if (!roomFromQuote && config.bookingMethod === "points") {
    roomFromQuote = true; // priced from points below; no cash rates, taxes or cash promotions apply
    const pn = resolvePointNights(data, resort.id, room.id, nights, opts);
    if (pn.missing.length > 0) {
      lines.push(unavailable("room", "room", `Villa (DVC points): ${room.name}`, `No point chart for ${pn.missing.length} of ${nights.length} nights (first: ${formatShortDate(pn.missing[0]!)})`));
    } else {
      const points = pn.nights.reduce((a, n) => a + n.points, 0);
      const cost = resolvePointCost(data, resort.id, points, opts);
      const chartStatus = weakestStatus(pn.nights.map((n) => n.status));
      if (!cost) {
        lines.push(unavailable("room", "room", `Villa (DVC points): ${room.name}`, `${points} points needed, but no price per point is recorded for ${resort.name}`));
      } else {
        const c = cost.item;
        lines.push({
          key: "room",
          category: "room",
          label: `Villa (DVC points): ${room.name}`,
          amountCents: points * c.centsPerPoint,
          status: weakestStatus([chartStatus, cost.status]),
          source: uniq([...pn.nights.map((n) => n.source), c.provenance.source]).join("; "),
          calculation: `${points} points (${nights.length} nights) × ${formatCents(c.centsPerPoint)}/point — ${c.label} (${c.type === "rental" ? "rental" : "your own points"})`,
        });
        if (c.feeCents) {
          lines.push({ key: "points_fee", category: "fees", label: "Reservation fee", amountCents: c.feeCents, status: cost.status, source: c.provenance.source, calculation: `${c.label} fee per reservation` });
        }
        if (c.terms) payment = summarizePayments(c.terms, points * c.centsPerPoint + (c.feeCents ?? 0), ctx.bookingDate);
        else assumptions.push("Payment and cancellation terms for this point rental are not recorded. Point rentals are often non-refundable; check before booking.");
      }
    }
    assumptions.push("DVC point reservations are assumed to carry no per-stay lodging tax (it is covered by member dues). Confirm with the rental provider.");
  }
  if (!roomFromQuote) {
    const r = resolveRoomNights(data, resort.id, room.id, nights, opts);
    if (r.missing.length > 0) {
      lines.push(unavailable("room", "room", `Room: ${room.name}`, `No rate for ${r.missing.length} of ${nights.length} nights (first: ${formatShortDate(r.missing[0]!)})`));
    } else {
      roomNights = r.nights;
      roomStatus = weakestStatus(roomNights.map((n) => n.status));
      lines.push({
        key: "room",
        category: "room",
        label: `Room: ${room.name}`,
        amountCents: sumCents(roomNights.map((n) => n.cents)),
        status: roomStatus,
        source: uniq(roomNights.map((n) => n.source)).join("; "),
        calculation: nightsSummary(roomNights) + (roomNights.some((n) => n.taxIncluded) ? " (some rates include tax)" : ""),
      });
    }
    if (config.bookingMethod === "package") {
      assumptions.push(
        "Without a package quote, the package is priced as the sum of its components (room + tickets), which is how Disney generally prices packages. Package-only offers are applied as discounts.",
      );
    }
  }

  // ── Promotions (only on component-priced rooms with every night priced) ───────
  let appliedPromotion: PromotionApplication | null = null;
  const potentialPromotions: PotentialPromotion[] = [];
  const nightDiscount = new Map<IsoDate, Cents>();
  if (!roomFromQuote && roomNights.length === nights.length) {
    const rateByNight = new Map(roomNights.map((n) => [n.date, n.cents]));
    const roomSubtotal = sumCents(roomNights.map((n) => n.cents));
    let best: { promo: Promotion; savings: Cents; status: PriceStatus; discountedNights: IsoDate[] } | null = null;
    for (const promo of data.promotions) {
      if (!opts.includeIllustrative && promo.provenance.status === "illustrative") continue;
      const e = checkEligibility(promo, {
        config,
        resort,
        nights,
        partySize: persons,
        parkDays,
        bookingDate: ctx.bookingDate,
        eligibility: req.eligibility,
      });
      if (e.kind === "ineligible") continue;
      const savings =
        promo.discount.type === "package_fixed"
          ? Math.min(promo.discount.cents, roomSubtotal)
          : sumCents(e.discountedNights.map((d) => roomDiscountForNight(promo, rateByNight.get(d) ?? 0)));
      if (savings <= 0) continue;
      const status = effectiveStatus(promo.provenance, opts.today, opts.staleAfterDays);
      if (e.kind === "uncertain") {
        potentialPromotions.push({ promotionId: promo.id, name: promo.name, potentialSavingsCents: savings, unknowns: e.unknowns });
        continue;
      }
      // Promotions are assumed non-combinable: keep the single best eligible offer.
      const better =
        !best ||
        savings > best.savings ||
        (savings === best.savings &&
          (STATUS_RANK[status] < STATUS_RANK[best.status] ||
            (STATUS_RANK[status] === STATUS_RANK[best.status] && promo.id < best.promo.id)));
      if (better) best = { promo, savings, status, discountedNights: e.discountedNights };
    }
    // Only surface uncertain offers that would beat what is already applied.
    const applied = best?.savings ?? 0;
    for (let i = potentialPromotions.length - 1; i >= 0; i--) {
      if ((potentialPromotions[i]!.potentialSavingsCents ?? 0) <= applied) potentialPromotions.splice(i, 1);
    }
    if (best) {
      const { promo, savings } = best;
      const lineStatus = weakestStatus([best.status, roomStatus]);
      if (promo.discount.type !== "package_fixed") {
        for (const d of best.discountedNights) nightDiscount.set(d, roomDiscountForNight(promo, rateByNight.get(d) ?? 0));
      }
      const how =
        promo.discount.type === "room_percent"
          ? `${promo.discount.pct}% off the room rate on ${best.discountedNights.length} of ${nights.length} nights`
          : promo.discount.type === "room_fixed_per_night"
            ? `${formatCents(promo.discount.cents)} off per night on ${best.discountedNights.length} of ${nights.length} nights`
            : `${formatCents(promo.discount.cents)} off the package`;
      lines.push({
        key: "discount",
        category: "discount",
        label: `Promotion: ${promo.name}`,
        amountCents: -savings,
        status: lineStatus,
        source: promo.provenance.source,
        calculation: how,
      });
      appliedPromotion = { promotionId: promo.id, name: promo.name, savingsCents: savings, status: lineStatus, terms: promo.terms };
      if (data.promotions.length > 1) assumptions.push("Promotions are assumed not to combine; the single largest eligible offer is applied.");
    }
  }

  // ── Lodging tax ───────────────────────────────────────────────────────────
  if (roomNights.length > 0) {
    const taxableNights = roomNights.filter((n) => !n.taxIncluded);
    if (taxableNights.length > 0) {
      const taxable = sumCents(taxableNights.map((n) => n.cents - (nightDiscount.get(n.date) ?? 0)));
      const rate = resolveTaxRate(data, "lodging", lodgingJurisdiction, opts);
      if (!rate) lines.push(unavailable("room_tax", "room_tax", "Room taxes", `No lodging tax rate for ${jurisdictionName}`));
      else
        lines.push({
          key: "room_tax",
          category: "room_tax",
          label: "Room taxes",
          amountCents: percentOf(taxable, rate.item.ratePct),
          status: weakestStatus([rate.status, roomStatus]),
          source: rate.item.provenance.source,
          calculation: `${rate.item.ratePct}% ${jurisdictionName} lodging tax on ${formatCents(taxable)} taxable room charges${nightDiscount.size ? " (after discount)" : ""}${resort.taxJurisdictionNote ? ` (${resort.taxJurisdictionNote})` : ""}`,
        });
    }
  }

  // ── Tickets ───────────────────────────────────────────────────────────────
  if (config.ticketOption && !ticketsFromQuote) {
    const opt = config.ticketOption;
    const name = `${parkDays}-day ${TICKET_LABEL[opt]}`;
    const groups: { age: AgeCategory; count: number }[] = [
      { age: "adult", count: party.adults },
      { age: "child", count: party.children },
    ];
    const usable = (t: TicketPrice): TicketUsability => {
      if (t.usage) return evaluateTicketUsage(t.usage, t.provenance.source, ticketStart, parkDays, lastParkDate);
      const rule = resolveTicketRule(data, t.option, t.days, t.channel, opts);
      return evaluateTicketUsage(rule?.item.usage, rule ? rule.item.provenance.source : null, ticketStart, parkDays, lastParkDate);
    };
    const rejected: TicketUsability[] = [];
    const resolved = groups
      .filter((g) => g.count > 0)
      .map((g) => ({
        ...g,
        price: resolveTicket(data, opt, parkDays, g.age, ticketStart, config.bookingMethod, req.tickets.allowThirdParty, opts, usable, rejected),
      }));
    const missingAges = resolved.filter((r) => !r.price).map((r) => r.age);
    if (missingAges.length > 0 && rejected.length > 0) {
      // Prices exist, but none of them can be used for these park days.
      violations.push(`No ${name} can cover ${parkDays} park days from ${formatShortDate(ticketStart)}: ${uniq(rejected.flatMap((u) => u.reasons)).join("; ")}`);
      lines.push(unavailable("tickets", "tickets", `Tickets: ${name}`, `No usable ${name} for these dates`));
    } else if (missingAges.length > 0) {
      lines.push(
        unavailable("tickets", "tickets", `Tickets: ${name}`, `No ${missingAges.join("/")} price for a ${name} starting ${formatShortDate(ticketStart)}`),
      );
    } else {
      const priced = resolved.map((r) => ({ ...r, price: r.price! }));
      // Report the most restrictive usability among the tickets bought.
      const order = { violated: 0, unknown: 1, ok: 2 } as const;
      ticketUsability = priced.map((p) => p.price.usability!).sort((a, b) => order[a.status] - order[b.status])[0] ?? null;
      const status = weakestStatus(priced.map((p) => p.price.status));
      const thirdParty = priced.some((p) => p.price.item.channel === "third_party");
      lines.push({
        key: "tickets",
        category: "tickets",
        label: `Tickets: ${name}${thirdParty ? " (third-party seller)" : ""}`,
        amountCents: sumCents(priced.map((p) => p.count * p.price.item.cents)),
        status,
        source: uniq(priced.map((p) => p.price.item.provenance.source)).join("; "),
        calculation:
          priced.map((p) => `${p.count} ${p.age}${p.count > 1 ? "s" : ""} × ${formatCents(p.price.item.cents)}`).join(" + ") +
          `, starting ${formatShortDate(ticketStart)}`,
      });
      const taxable = sumCents(priced.filter((p) => !p.price.item.taxIncluded).map((p) => p.count * p.price.item.cents));
      if (taxable > 0) {
        const rate = resolveTaxRate(data, "sales", ctx.catalog.ticketTaxJurisdictionId, opts);
        if (!rate) lines.push(unavailable("ticket_tax", "ticket_tax", "Ticket sales tax", "No sales tax rate available for ticket purchases"));
        else
          lines.push({
            key: "ticket_tax",
            category: "ticket_tax",
            label: "Ticket sales tax",
            amountCents: percentOf(taxable, rate.item.ratePct),
            status: weakestStatus([rate.status, status]),
            source: rate.item.provenance.source,
            calculation: `${rate.item.ratePct}% of ${formatCents(taxable)}`,
          });
      }
    }
    if (party.infants > 0) assumptions.push("Children under 3 do not need park tickets.");
  }

  // ── Dining ────────────────────────────────────────────────────────────────
  if (config.dining === "out_of_pocket") {
    const perNight =
      party.adults * req.dining.outOfPocketPerAdultPerNightCents + party.children * req.dining.outOfPocketPerChildPerNightCents;
    lines.push({
      key: "dining",
      category: "dining",
      label: "Food (pay as you go)",
      amountCents: perNight * config.nights,
      status: "estimated",
      source: "Your estimate",
      calculation:
        perNight === 0
          ? "Food not included in totals (your per-person estimate is $0)"
          : `${config.nights} nights × ${formatCents(perNight)} (${party.adults} adult${party.adults > 1 ? "s" : ""} × ${formatCents(req.dining.outOfPocketPerAdultPerNightCents)}${party.children ? ` + ${party.children} child × ${formatCents(req.dining.outOfPocketPerChildPerNightCents)}` : ""})`,
    });
  } else if (!diningFromQuote) {
    const plan: DiningPlan = config.dining;
    const groups = [
      { age: "adult" as const, count: party.adults },
      { age: "child" as const, count: party.children },
    ].filter((g) => g.count > 0);
    const resolved = groups.map((g) => ({ ...g, r: resolveDiningNights(data, plan, g.age, nights, opts) }));
    if (resolved.some((g) => g.r.missing.length > 0)) {
      lines.push(unavailable("dining", "dining", DINING_LABEL[plan], `No ${DINING_LABEL[plan]} price for these dates`));
    } else {
      const all = resolved.flatMap((g) => g.r.nights.map((n) => ({ ...n, count: g.count })));
      const status = weakestStatus(all.map((n) => n.status));
      lines.push({
        key: "dining",
        category: "dining",
        label: DINING_LABEL[plan],
        amountCents: sumCents(all.map((n) => n.count * n.cents)),
        status,
        source: uniq(all.map((n) => n.source)).join("; "),
        calculation: resolved
          .map((g) => `${g.count} ${g.age}${g.count > 1 ? "s" : ""} × ${config.nights} nights × ${formatCents(g.r.nights[0]!.cents)}`)
          .join(" + "),
      });
      const taxable = sumCents(all.filter((n) => !n.taxIncluded).map((n) => n.count * n.cents));
      if (taxable > 0) {
        const rate = resolveTaxRate(data, "sales", lodgingJurisdiction, opts);
        if (!rate) lines.push(unavailable("dining_tax", "dining_tax", "Dining plan tax", `No sales tax rate for ${jurisdictionName}`));
        else
          lines.push({
            key: "dining_tax",
            category: "dining_tax",
            label: "Dining plan tax",
            amountCents: percentOf(taxable, rate.item.ratePct),
            status: weakestStatus([rate.status, status]),
            source: rate.item.provenance.source,
            calculation: `${rate.item.ratePct}% of ${formatCents(taxable)}`,
          });
      }
    }
  }
  if (config.dining !== "out_of_pocket") {
    assumptions.push("A dining plan is assumed to replace your pay-as-you-go food spending entirely.");
  }

  // ── Transportation ────────────────────────────────────────────────────────
  const transport = resolveTransport(data, resort.id, opts);
  const tripParkDays = req.tickets.parkDays;
  if (!transport) {
    lines.push(unavailable("transport", "transport", "Transportation", `No transportation cost data for ${resort.name}`));
  } else {
    const t = transport.item;
    if (req.transport.mode === "no_car") {
      const amount = t.noCarPerParkDayCents * tripParkDays;
      lines.push({
        key: "transport",
        category: "transport",
        label: "Transportation to parks",
        amountCents: amount,
        status: transport.status,
        source: t.provenance.source,
        calculation:
          t.noCarPerParkDayCents === 0
            ? resort.transportNote
            : `${tripParkDays} park days × ${formatCents(t.noCarPerParkDayCents)} round trip (rideshare)`,
      });
    } else {
      const overnight = t.overnightParkingPerNightCents * config.nights;
      const park = t.parkParkingPerParkDayCents * tripParkDays;
      lines.push({
        key: "transport",
        category: "transport",
        label: "Parking",
        amountCents: overnight + park,
        status: transport.status,
        source: t.provenance.source,
        calculation: `Hotel: ${config.nights} nights × ${formatCents(t.overnightParkingPerNightCents)}; parks: ${tripParkDays} days × ${formatCents(t.parkParkingPerParkDayCents)}`,
      });
    }
  }
  if (req.transport.mode === "rental_car") {
    lines.push({
      key: "rental_car",
      category: "rental_car",
      label: "Rental car",
      amountCents: req.transport.rentalPerDayCents * config.nights,
      status: "estimated",
      source: "Your estimate",
      calculation: `${config.nights} days × ${formatCents(req.transport.rentalPerDayCents)}`,
    });
  }

  // ── Other user expenses ───────────────────────────────────────────────────
  req.otherExpenses.forEach((x, i) => {
    const mult = { trip: 1, night: config.nights, person: persons, person_night: persons * config.nights }[x.per];
    const unit = { trip: "trip", night: "night", person: "person", person_night: "person per night" }[x.per];
    lines.push({
      key: `other_${i}`,
      category: "other",
      label: x.label,
      amountCents: x.cents * mult,
      status: "estimated",
      source: "Your estimate",
      calculation: mult === 1 ? `${formatCents(x.cents)} per ${unit}` : `${mult} × ${formatCents(x.cents)} per ${unit}`,
    });
  });

  return { ...summarize(lines, appliedPromotion, potentialPromotions, assumptions), violations, ticketUsability, payment, quoteId: quote?.item.id ?? null };
}

function unavailable(key: string, category: CostLine["category"], label: string, why: string): CostLine {
  return { key, category, label, amountCents: null, status: "unavailable", source: "—", calculation: why };
}

function summarize(
  lines: CostLine[],
  appliedPromotion: PromotionApplication | null,
  potentialPromotions: PotentialPromotion[],
  assumptions: string[],
): Omit<PricedTrip, "violations" | "ticketUsability" | "payment" | "quoteId"> {
  const totalCents = sumCents(lines.map((l) => l.amountCents ?? 0));
  const missing = lines.filter((l) => l.amountCents === null).map((l) => `${l.label}: ${l.calculation}`);
  const material = lines.filter((l) => !l.includedInQuote && l.amountCents !== 0);
  const statusTotals: Partial<Record<PriceStatus, Cents>> = {};
  for (const l of material) {
    if (l.amountCents !== null) statusTotals[l.status] = (statusTotals[l.status] ?? 0) + Math.abs(l.amountCents);
  }
  return {
    lines,
    totalCents,
    complete: missing.length === 0,
    missing,
    dataStatus: material.length ? weakestStatus(material.map((l) => l.status)) : "unavailable",
    containsIllustrative: material.some((l) => l.status === "illustrative"),
    statusTotals,
    appliedPromotion,
    potentialPromotions,
    assumptions: uniq(assumptions),
  };
}

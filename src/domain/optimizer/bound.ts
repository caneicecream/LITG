import { addDays, inRange, stayNights } from "../dates";
import type { Cents } from "../money";
import type { PriceStatus } from "../provenance";
import { pickBest, resolveDiningNights, resolvePointNights, resolveRoomNights, resolveTaxRate, resolveTransport } from "../pricing/resolve";
import type { PricingContext } from "../pricing/calculate";
import type { AgeCategory, Configuration, DiningPlan, Resort, TicketPrice } from "../types";

/**
 * A cheap lower bound on a configuration's total, used to skip pricing
 * configurations that provably cannot appear in any result.
 *
 * Contract (checked by the pruning-equivalence tests):
 *   - `lb` ≤ the exact total (or partial total, if incomplete) that
 *     `priceConfiguration` would produce for any outcome without violations;
 *   - the `may*` flags over-approximate: if the priced result can be complete /
 *     incomplete / contain illustrative data / contain none, the flag is true.
 * Configurations a stay quote might price are never bounded (`quoted`).
 */
export interface Bound {
  lb: Cents;
  quoted: boolean;
  mayBeComplete: boolean;
  mayBeIncomplete: boolean;
  mayBeIllustrative: boolean;
  mayBeReal: boolean;
}

interface Part {
  cents: number;
  /** true = definitely unpriced; "maybe" = depends on which source is chosen. */
  missing: boolean | "maybe";
  /** The chosen source may be illustrative / may be non-illustrative. */
  illus: boolean;
  real: boolean;
}

/** Flags when every listed status is part of the result (e.g. each night of a stay). */
const flagsOf = (statuses: PriceStatus[]) => ({
  illus: statuses.includes("illustrative"),
  real: statuses.every((s) => s !== "illustrative"),
});
/** Flags when exactly one of the listed candidates will be chosen. */
const anyOf = (statuses: PriceStatus[]) => ({
  illus: statuses.includes("illustrative"),
  real: statuses.some((s) => s !== "illustrative"),
});

export function createBounder(ctx: PricingContext) {
  const { data, request: req, opts, catalog } = ctx;
  const party = req.party;
  const quoteKeys = new Set(data.stayQuotes.map((q) => `${q.resortId}/${q.roomTypeId}/${q.checkIn}/${q.nights}`));
  const promos = data.promotions.filter((p) => opts.includeIllustrative || p.provenance.status !== "illustrative");
  const illusPromo = promos.some((p) => p.provenance.status === "illustrative");
  const taxCache = new Map<string, { pct: number; illus: boolean } | null>();
  const tax = (category: "lodging" | "sales", jurisdiction: string) => {
    const k = `${category}/${jurisdiction}`;
    if (!taxCache.has(k)) {
      const r = resolveTaxRate(data, category, jurisdiction, opts);
      taxCache.set(k, r ? { pct: r.item.ratePct, illus: r.status === "illustrative" } : null);
    }
    return taxCache.get(k)!;
  };
  const memo = <T>(cache: Map<string, T>, key: string, fn: () => T): T => {
    let v = cache.get(key);
    if (v === undefined) {
      v = fn();
      cache.set(key, v);
    }
    return v;
  };
  const roomCache = new Map<string, { subtotal: number; taxable: number; missing: boolean; illus: boolean; real: boolean }>();
  const pointCache = new Map<string, Part>();
  const ticketCache = new Map<string, { min: number; illus: boolean; real: boolean; taxMayMiss: boolean } | null>();
  const diningCache = new Map<string, Part>();
  const transportCache = new Map<string, ReturnType<typeof resolveTransport>>();

  const ticketChannelKey = (method: Configuration["bookingMethod"]) =>
    method === "package" || !req.tickets.allowThirdParty ? "d" : "dt";

  function ticketFor(option: string, age: AgeCategory, start: string, channels: string): { min: number; illus: boolean; real: boolean; taxMayMiss: boolean } | null {
    return memo(ticketCache, `${option}/${age}/${start}/${channels}`, () => {
      const rate = tax("sales", catalog.ticketTaxJurisdictionId);
      let min = Infinity;
      let taxMayMiss = false;
      const statuses: PriceStatus[] = [];
      for (const t of data.ticketPrices) {
        if (t.option !== option || t.days !== req.tickets.parkDays || t.age !== age || !inRange(start, t.validFrom, t.validTo)) continue;
        if (t.channel === "third_party" && channels === "d") continue;
        const best = pickBest<TicketPrice>([t], opts);
        if (!best) continue;
        statuses.push(best.status);
        if (!t.taxIncluded && !rate) taxMayMiss = true;
        min = Math.min(min, t.cents + (t.taxIncluded || !rate ? 0 : (t.cents * rate.pct) / 100));
      }
      if (statuses.length === 0) return null;
      return { min, taxMayMiss, ...anyOf(statuses) };
    });
  }

  return function bound(config: Configuration, resort: Resort): Bound {
    if (quoteKeys.has(`${config.resortId}/${config.roomTypeId}/${config.arrival}/${config.nights}`)) {
      return { lb: -Infinity, quoted: true, mayBeComplete: true, mayBeIncomplete: true, mayBeIllustrative: true, mayBeReal: true };
    }
    const parts: Part[] = [];
    const nightsKey = `${config.resortId}/${config.roomTypeId}/${config.arrival}/${config.nights}`;
    let promoIllus = false;

    // Accommodation (+ lodging tax, net of the largest possible discount).
    if (config.bookingMethod === "points") {
      parts.push(
        memo(pointCache, nightsKey, () => {
          const pn = resolvePointNights(data, resort.id, config.roomTypeId, stayNights(config.arrival, config.nights), opts);
          if (pn.missing.length > 0) return { cents: 0, missing: true, illus: pn.nights.some((n) => n.status === "illustrative"), real: true };
          const points = pn.nights.reduce((a, n) => a + n.points, 0);
          const costs = data.pointCosts.filter(
            (c) =>
              (opts.includeIllustrative || c.provenance.status !== "illustrative") &&
              (!c.resortIds || c.resortIds.includes(resort.id)) &&
              (c.minPoints === undefined || points >= c.minPoints),
          );
          const charts = flagsOf(pn.nights.map((n) => n.status));
          const cost = anyOf(costs.map((c) => c.provenance.status as PriceStatus));
          if (costs.length === 0) return { cents: 0, missing: true, illus: charts.illus, real: true };
          return { cents: points * Math.min(...costs.map((c) => c.centsPerPoint)), missing: false, illus: charts.illus || cost.illus, real: charts.real && cost.real };
        }),
      );
    } else {
      const room = memo(roomCache, nightsKey, () => {
        const r = resolveRoomNights(data, resort.id, config.roomTypeId, stayNights(config.arrival, config.nights), opts);
        const f = flagsOf(r.nights.map((n) => n.status));
        if (r.missing.length > 0) return { subtotal: 0, taxable: 0, missing: true, ...f, real: true };
        return {
          subtotal: r.nights.reduce((a, n) => a + n.cents, 0),
          taxable: r.nights.filter((n) => !n.taxIncluded).reduce((a, n) => a + n.cents, 0),
          missing: false,
          ...f,
        };
      });
      if (room.missing) {
        parts.push({ cents: 0, missing: true, illus: room.illus, real: true });
      } else {
        // Promotions don't combine, so the largest single possible discount bounds the actual one.
        let maxDiscount = 0;
        for (const p of promos) {
          const d = p.discount;
          const v =
            d.type === "room_percent"
              ? Math.ceil((room.subtotal * d.pct) / 100) + config.nights
              : d.type === "room_fixed_per_night"
                ? d.cents * config.nights
                : config.bookingMethod === "package"
                  ? d.cents
                  : 0;
          maxDiscount = Math.max(maxDiscount, Math.min(v, room.subtotal));
        }
        promoIllus = illusPromo;
        let taxLb = 0;
        let taxMissing = false;
        let taxIllus = false;
        if (room.taxable > 0) {
          const rate = tax("lodging", resort.taxJurisdictionId);
          if (!rate) taxMissing = true;
          else {
            taxLb = Math.max(0, Math.floor((rate.pct * Math.max(0, room.taxable - maxDiscount)) / 100) - 1);
            taxIllus = rate.illus;
          }
        }
        parts.push({ cents: room.subtotal - maxDiscount + taxLb, missing: taxMissing, illus: room.illus || taxIllus, real: room.real && !taxIllus });
      }
    }

    // Tickets: the cheapest candidate (any status, ignoring usability) bounds the chosen one.
    if (config.ticketOption) {
      const start = addDays(config.arrival, req.tickets.parkOnArrivalDay ? 0 : 1);
      const channels = ticketChannelKey(config.bookingMethod);
      let cents = 0;
      let missing = false;
      let taxMayMiss = false;
      let illus = false;
      let real = true;
      for (const [age, count] of [
        ["adult", party.adults],
        ["child", party.children],
      ] as const) {
        if (count === 0) continue;
        const t = ticketFor(config.ticketOption, age, start, channels);
        if (!t) {
          missing = true;
          continue;
        }
        cents += count * t.min;
        taxMayMiss ||= t.taxMayMiss;
        illus ||= t.illus;
        real &&= t.real;
      }
      // An unpriced age group makes the whole ticket line unavailable (contributing 0).
      parts.push({ cents: missing ? 0 : Math.max(0, Math.floor(cents) - 1), missing: missing || (taxMayMiss ? "maybe" : false), illus, real });
    }

    // Dining.
    if (config.dining === "out_of_pocket") {
      parts.push({
        cents: config.nights * (party.adults * req.dining.outOfPocketPerAdultPerNightCents + party.children * req.dining.outOfPocketPerChildPerNightCents),
        missing: false,
        illus: false,
        real: true,
      });
    } else {
      const plan: DiningPlan = config.dining;
      parts.push(
        memo(diningCache, `${plan}/${resort.taxJurisdictionId}/${config.arrival}/${config.nights}`, () => {
          const nights = stayNights(config.arrival, config.nights);
          let cents = 0;
          let taxable = 0;
          const statuses: PriceStatus[] = [];
          for (const [age, count] of [
            ["adult", party.adults],
            ["child", party.children],
          ] as const) {
            if (count === 0) continue;
            const r = resolveDiningNights(data, plan, age, nights, opts);
            statuses.push(...r.nights.map((n) => n.status));
            if (r.missing.length > 0) return { cents: 0, missing: true, ...flagsOf(statuses), real: true };
            cents += count * r.nights.reduce((a, n) => a + n.cents, 0);
            taxable += count * r.nights.filter((n) => !n.taxIncluded).reduce((a, n) => a + n.cents, 0);
          }
          const rate = taxable > 0 ? tax("sales", resort.taxJurisdictionId) : null;
          if (taxable > 0 && !rate) return { cents, missing: true, ...flagsOf(statuses) };
          const t = rate ? Math.max(0, Math.floor((rate.pct * taxable) / 100) - 1) : 0;
          return { cents: cents + t, missing: false, illus: flagsOf(statuses).illus || !!rate?.illus, real: flagsOf(statuses).real && !rate?.illus };
        }),
      );
    }

    // Transportation, rental car and other expenses are exact.
    const transport = memo(transportCache, resort.id, () => resolveTransport(data, resort.id, opts));
    if (!transport) parts.push({ cents: 0, missing: true, illus: false, real: true });
    else {
      const t = transport.item;
      const cents =
        req.transport.mode === "no_car"
          ? t.noCarPerParkDayCents * req.tickets.parkDays
          : t.overnightParkingPerNightCents * config.nights + t.parkParkingPerParkDayCents * req.tickets.parkDays;
      parts.push({ cents, missing: false, illus: transport.status === "illustrative" && cents !== 0, real: !(transport.status === "illustrative" && cents !== 0) });
    }
    let fixed = 0;
    if (req.transport.mode === "rental_car") fixed += req.transport.rentalPerDayCents * config.nights;
    const persons = party.adults + party.children + party.infants;
    for (const x of req.otherExpenses) {
      fixed += x.cents * { trip: 1, night: config.nights, person: persons, person_night: persons * config.nights }[x.per];
    }

    return {
      lb: parts.reduce((a, p) => a + p.cents, fixed),
      quoted: false,
      mayBeComplete: !parts.some((p) => p.missing === true),
      mayBeIncomplete: parts.some((p) => p.missing !== false),
      mayBeIllustrative: parts.some((p) => p.illus) || promoIllus,
      mayBeReal: parts.every((p) => p.real),
    };
  };
}

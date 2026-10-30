import { dayOfWeek, inRange, type IsoDate } from "../dates";
import type { Cents } from "../money";
import { effectiveStatus, STATUS_RANK, type PriceStatus, type Provenance } from "../provenance";
import type {
  AgeCategory,
  BookingMethod,
  Configuration,
  DiningPlan,
  PriceData,
  StayQuote,
  TaxCategory,
  TaxRate,
  TicketOption,
  TicketPrice,
  TransportProfile,
} from "../types";

/**
 * Price resolution: given competing sources for the same price, pick the one
 * we trust most. Rules (deterministic):
 *   1. Illustrative data is ignored entirely when the user excludes it.
 *   2. Better effective status wins (verified > manual > stale > estimated > illustrative).
 *   3. Among equally trusted sources, the most recent observation wins
 *      (a newer quote supersedes an older one for the same item).
 *   4. Final tie-break on id for reproducibility.
 */
export interface ResolveOptions {
  today: IsoDate;
  staleAfterDays: number;
  includeIllustrative: boolean;
}

export interface Resolved<T> {
  item: T;
  status: PriceStatus;
}

export function pickBest<T extends { id: string; provenance: Provenance }>(
  items: readonly T[],
  opts: ResolveOptions,
): Resolved<T> | null {
  let best: Resolved<T> | null = null;
  for (const item of items) {
    if (!opts.includeIllustrative && item.provenance.status === "illustrative") continue;
    const status = effectiveStatus(item.provenance, opts.today, opts.staleAfterDays);
    if (!best || compareCandidates({ item, status }, best) < 0) best = { item, status };
  }
  return best;
}

function compareCandidates<T extends { id: string; provenance: Provenance }>(a: Resolved<T>, b: Resolved<T>): number {
  const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (byStatus !== 0) return byStatus;
  if (a.item.provenance.observedAt !== b.item.provenance.observedAt) {
    return a.item.provenance.observedAt > b.item.provenance.observedAt ? -1 : 1;
  }
  return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
}

/** Lookup indexes, built once per PriceData object (the optimizer prices thousands of configurations). */
interface Index {
  rooms: Map<string, PriceData["roomRates"]>;
  tickets: Map<string, TicketPrice[]>;
}
const indexes = new WeakMap<PriceData, Index>();
function indexFor(data: PriceData): Index {
  let idx = indexes.get(data);
  if (!idx) {
    idx = { rooms: groupBy(data.roomRates, (r) => `${r.resortId}/${r.roomTypeId}`), tickets: groupBy(data.ticketPrices, (t) => `${t.option}/${t.days}/${t.age}/${t.channel}`) };
    indexes.set(data, idx);
  }
  return idx;
}
function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const g = m.get(k);
    if (g) g.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export interface ResolvedNight {
  date: IsoDate;
  cents: Cents;
  taxIncluded: boolean;
  status: PriceStatus;
  source: string;
}

/** Resolve a nightly room rate for each night. Returns missing night dates when any night has no rate. */
export function resolveRoomNights(
  data: PriceData,
  resortId: string,
  roomTypeId: string,
  nights: readonly IsoDate[],
  opts: ResolveOptions,
): { nights: ResolvedNight[]; missing: IsoDate[] } {
  const rates = indexFor(data).rooms.get(`${resortId}/${roomTypeId}`) ?? [];
  const out: ResolvedNight[] = [];
  const missing: IsoDate[] = [];
  for (const date of nights) {
    const dow = dayOfWeek(date);
    const covering = rates.filter(
      (r) => inRange(date, r.validFrom, r.validTo) && (!r.daysOfWeek || r.daysOfWeek.includes(dow)),
    );
    const best = pickBest(covering, opts);
    if (!best) missing.push(date);
    else
      out.push({
        date,
        cents: best.item.nightlyCents,
        taxIncluded: best.item.taxIncluded,
        status: best.status,
        source: best.item.provenance.source,
      });
  }
  return { nights: out, missing };
}

/**
 * Resolve the ticket price for one person. Different sales channels are genuinely
 * different purchase options, so the best source is chosen per channel and then
 * the channels compete on trust first and price second. Packages can only use
 * Disney-channel tickets.
 */
export function resolveTicket(
  data: PriceData,
  option: TicketOption,
  days: number,
  age: AgeCategory,
  startDate: IsoDate,
  bookingMethod: BookingMethod,
  allowThirdParty: boolean,
  opts: ResolveOptions,
): Resolved<TicketPrice> | null {
  const channels: TicketPrice["channel"][] =
    bookingMethod === "package" || !allowThirdParty ? ["disney"] : ["disney", "third_party"];
  const perChannel: Resolved<TicketPrice>[] = [];
  for (const channel of channels) {
    const best = pickBest(
      (indexFor(data).tickets.get(`${option}/${days}/${age}/${channel}`) ?? []).filter((t) =>
        inRange(startDate, t.validFrom, t.validTo),
      ),
      opts,
    );
    if (best) perChannel.push(best);
  }
  perChannel.sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      a.item.cents - b.item.cents ||
      (a.item.channel < b.item.channel ? -1 : 1),
  );
  return perChannel[0] ?? null;
}

export function resolveDiningNights(
  data: PriceData,
  plan: DiningPlan,
  age: AgeCategory,
  nights: readonly IsoDate[],
  opts: ResolveOptions,
): { nights: ResolvedNight[]; missing: IsoDate[] } {
  const prices = data.diningPlanPrices.filter((p) => p.plan === plan && p.age === age);
  const out: ResolvedNight[] = [];
  const missing: IsoDate[] = [];
  for (const date of nights) {
    const best = pickBest(
      prices.filter((p) => inRange(date, p.validFrom, p.validTo)),
      opts,
    );
    if (!best) missing.push(date);
    else
      out.push({
        date,
        cents: best.item.perNightCents,
        taxIncluded: best.item.taxIncluded,
        status: best.status,
        source: best.item.provenance.source,
      });
  }
  return { nights: out, missing };
}

/** Find a stay quote that matches this exact configuration and party. */
export function matchStayQuote(
  data: PriceData,
  config: Configuration,
  party: { adults: number; children: number },
  parkDays: number,
  opts: ResolveOptions,
): Resolved<StayQuote> | null {
  const matches = data.stayQuotes.filter((q) => {
    if (
      q.resortId !== config.resortId ||
      q.roomTypeId !== config.roomTypeId ||
      q.checkIn !== config.arrival ||
      q.nights !== config.nights ||
      q.adults !== party.adults ||
      q.children !== party.children ||
      q.bookingMethod !== config.bookingMethod
    ) {
      return false;
    }
    if (config.bookingMethod === "package") {
      // A package quote must include exactly the tickets and dining being evaluated.
      if (!q.ticket || q.ticket.option !== config.ticketOption || q.ticket.days !== parkDays) return false;
      if (q.dining !== config.dining) return false;
    } else if (q.ticket || q.dining !== "out_of_pocket") {
      // A room-only quote covers the room only.
      return false;
    }
    return true;
  });
  return pickBest(matches, opts);
}

export function resolveTransport(
  data: PriceData,
  resortId: string,
  opts: ResolveOptions,
): Resolved<TransportProfile> | null {
  return pickBest(
    data.transport.filter((t) => t.resortId === resortId),
    opts,
  );
}

export function resolveTaxRate(data: PriceData, category: TaxCategory, opts: ResolveOptions): Resolved<TaxRate> | null {
  return pickBest(
    data.taxRates.filter((t) => t.category === category),
    opts,
  );
}

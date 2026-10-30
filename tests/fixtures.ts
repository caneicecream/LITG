import type { Provenance, StoredPriceStatus } from "@/domain/provenance";
import type { Catalog, PriceData, Promotion, RoomRate, StayQuote, TicketPrice, TripRequest } from "@/domain/types";

/**
 * Hand-built fixture with round numbers so expected totals can be verified by hand.
 *   Resort A (value, on property): $100/night, sleeps 4.
 *   Resort B (moderate, on property): $200/night, sleeps 5.
 *   Off-site hotel: $50/night, park parking $20/day, rideshare $30/day.
 *   Lodging tax 10%, sales tax 5% (both "estimated").
 *   Tickets: base $300 / hopper $400 per adult for 3 days, child $250 / $350.
 */
export const TODAY = "2027-01-01";
export const NOW = new Date(`${TODAY}T12:00:00Z`);

export const prov = (status: StoredPriceStatus = "manual", observedAt = TODAY, source = `test-${status}`): Provenance => ({
  status,
  source,
  observedAt,
});

export const catalog: Catalog = {
  taxJurisdictions: [{ id: "test-county", name: "Test County" }],
  ticketTaxJurisdictionId: "test-county",
  resorts: [
    { id: "a", name: "Resort A", tier: "value", disneyOwned: true, accommodation: "hotel", dvcPoints: false, taxJurisdictionId: "test-county", convenience: 3, transportNote: "Bus", roomTypes: [{ id: "std", name: "Std A", maxOccupancy: 4 }] },
    { id: "b", name: "Resort B", tier: "moderate", disneyOwned: true, accommodation: "hotel", dvcPoints: false, taxJurisdictionId: "test-county", convenience: 5, transportNote: "Boat", roomTypes: [{ id: "std", name: "Std B", maxOccupancy: 5 }] },
    { id: "off", name: "Offsite", tier: "off_property", disneyOwned: false, accommodation: "hotel", dvcPoints: false, taxJurisdictionId: "test-county", convenience: 1, transportNote: "Car", roomTypes: [{ id: "std", name: "Std Off", maxOccupancy: 4 }] },
  ],
};

export function rate(resortId: string, cents: number, over: Partial<RoomRate> = {}): RoomRate {
  return {
    id: `rate-${resortId}-${cents}-${over.validFrom ?? "x"}-${over.provenance?.status ?? "m"}`,
    kind: "room_rate",
    resortId,
    roomTypeId: "std",
    validFrom: "2027-01-01",
    validTo: "2027-12-31",
    nightlyCents: cents,
    taxIncluded: false,
    provenance: prov(),
    ...over,
  };
}

export function ticket(option: TicketPrice["option"], age: TicketPrice["age"], cents: number, over: Partial<TicketPrice> = {}): TicketPrice {
  return {
    id: `t-${option}-${age}-${cents}-${over.channel ?? "disney"}-${over.provenance?.status ?? "m"}`,
    kind: "ticket_price",
    option,
    days: 3,
    age,
    validFrom: "2027-01-01",
    validTo: "2027-12-31",
    cents,
    taxIncluded: false,
    channel: "disney",
    provenance: prov(),
    ...over,
  };
}

export function quote(over: Partial<StayQuote>): StayQuote {
  return {
    id: `q-${Math.random().toString(36).slice(2)}`,
    kind: "stay_quote",
    label: "Test quote",
    resortId: "a",
    roomTypeId: "std",
    checkIn: "2027-02-01",
    nights: 4,
    adults: 2,
    children: 0,
    bookingMethod: "package",
    ticket: { option: "base", days: 3 },
    dining: "out_of_pocket",
    totalCents: 100_000,
    taxIncluded: true,
    provenance: prov(),
    ...over,
  };
}

export function promo(over: Partial<Promotion>): Promotion {
  return {
    id: "promo",
    name: "Test promo",
    discount: { type: "room_percent", pct: 20 },
    travel: { from: "2027-01-01", to: "2027-12-31", rule: "all_nights" },
    requiresPackage: false,
    terms: "test",
    provenance: prov(),
    ...over,
  };
}

export function baseData(over: Partial<PriceData> = {}): PriceData {
  return {
    roomRates: [rate("a", 10_000), rate("b", 20_000), rate("off", 5_000)],
    ticketPrices: [
      ticket("base", "adult", 30_000),
      ticket("base", "child", 25_000),
      ticket("park_hopper", "adult", 40_000),
      ticket("park_hopper", "child", 35_000),
    ],
    diningPlanPrices: [
      { id: "dp-a", kind: "dining_plan_price", plan: "dining_plan", age: "adult", validFrom: "2027-01-01", validTo: "2027-12-31", perNightCents: 9_000, taxIncluded: true, provenance: prov() },
      { id: "dp-c", kind: "dining_plan_price", plan: "dining_plan", age: "child", validFrom: "2027-01-01", validTo: "2027-12-31", perNightCents: 3_000, taxIncluded: true, provenance: prov() },
    ],
    stayQuotes: [],
    transport: [
      { id: "tr-a", resortId: "a", overnightParkingPerNightCents: 1_500, parkParkingPerParkDayCents: 0, noCarPerParkDayCents: 0, provenance: prov("estimated") },
      { id: "tr-b", resortId: "b", overnightParkingPerNightCents: 2_000, parkParkingPerParkDayCents: 0, noCarPerParkDayCents: 0, provenance: prov("estimated") },
      { id: "tr-off", resortId: "off", overnightParkingPerNightCents: 1_000, parkParkingPerParkDayCents: 2_000, noCarPerParkDayCents: 3_000, provenance: prov("estimated") },
    ],
    taxRates: [
      { id: "tax-l", jurisdictionId: "test-county", category: "lodging", ratePct: 10, provenance: prov("estimated") },
      { id: "tax-s", jurisdictionId: "test-county", category: "sales", ratePct: 5, provenance: prov("estimated") },
    ],
    promotions: [],
    ticketRules: [],
    pointCharts: [],
    pointCosts: [],
    ...over,
  };
}

/** 2 adults, fixed 4-night stay arriving Feb 1 2027, 3 park days, base tickets, no food costs. */
export function baseRequest(over: Partial<TripRequest> = {}): TripRequest {
  return {
    party: { adults: 2, children: 0, infants: 0 },
    dates: { earliestArrival: "2027-02-01", latestDeparture: "2027-02-05", minNights: 4, maxNights: 4 },
    preferred: {},
    resorts: { allowedResortIds: [], requireOnProperty: false, preferredResortIds: [] },
    tickets: { parkDays: 3, allowedOptions: ["base"], parkOnArrivalDay: false, parkOnDepartureDay: false, allowThirdParty: true },
    dining: { policy: "exclude", outOfPocketPerAdultPerNightCents: 0, outOfPocketPerChildPerNightCents: 0 },
    transport: { mode: "no_car", rentalPerDayCents: 0 },
    budget: {},
    otherExpenses: [],
    eligibility: { florida_resident: "unknown", annual_passholder: "unknown", military: "unknown" },
    objective: "lowest_cost",
    weights: { price: 50, resort: 15, convenience: 10, ticket: 10, dining: 5, dates: 10 },
    data: { includeIllustrative: true, staleAfterDays: 14 },
    bookingDate: TODAY,
    ...over,
  };
}

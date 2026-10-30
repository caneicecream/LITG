import type { Cents } from "./money";
import type { IsoDate } from "./dates";
import type { PriceStatus, Provenance } from "./provenance";

// ───────────────────────────── Catalog (structure, not prices) ─────────────────────────────

export type ResortTier = "value" | "moderate" | "deluxe" | "off_property";

export interface RoomType {
  id: string;
  name: string;
  /** Maximum guests including children under 3 (conservative; verify per resort). */
  maxOccupancy: number;
}

export interface Resort {
  id: string;
  name: string;
  tier: ResortTier;
  onProperty: boolean;
  roomTypes: RoomType[];
  /** Subjective 1–5 convenience rating (transportation, proximity). An editorial assumption, not data. */
  convenience: number;
  transportNote: string;
}

export type TicketOption = "base" | "park_hopper" | "park_hopper_plus";
export type AgeCategory = "adult" | "child";
export type DiningPlan = "quick_service_plan" | "dining_plan";
/** How food is paid for: a Disney dining plan, or out of pocket (user-estimated). */
export type DiningChoice = "out_of_pocket" | DiningPlan;
/** "separate" = room-only reservation + tickets bought on their own; "package" = Disney room + ticket package. */
export type BookingMethod = "separate" | "package";
export type TicketChannel = "disney" | "third_party";
export type TaxCategory = "lodging" | "sales";
export type Audience = "florida_resident" | "annual_passholder" | "military";

// ───────────────────────────── Price data (every item carries provenance) ─────────────────────────────

export interface RoomRate {
  id: string;
  kind: "room_rate";
  resortId: string;
  roomTypeId: string;
  /** Inclusive range of *night* dates this rate covers. */
  validFrom: IsoDate;
  validTo: IsoDate;
  /** If set, the rate applies only to nights falling on these weekdays (0 = Sunday). */
  daysOfWeek?: number[];
  nightlyCents: Cents;
  taxIncluded: boolean;
  provenance: Provenance;
}

export interface TicketPrice {
  id: string;
  kind: "ticket_price";
  option: TicketOption;
  days: number;
  age: AgeCategory;
  /** Inclusive range of ticket *start* dates this price covers (Disney tickets are date-based). */
  validFrom: IsoDate;
  validTo: IsoDate;
  /** Price per person for the whole multi-day ticket. */
  cents: Cents;
  taxIncluded: boolean;
  channel: TicketChannel;
  provenance: Provenance;
}

export interface DiningPlanPrice {
  id: string;
  kind: "dining_plan_price";
  plan: DiningPlan;
  age: AgeCategory;
  validFrom: IsoDate;
  validTo: IsoDate;
  perNightCents: Cents;
  taxIncluded: boolean;
  provenance: Provenance;
}

/**
 * A real quote for a complete stay, as shown on a booking page. Totals are
 * always tax-inclusive (that is how Disney presents quote totals), so the
 * optimizer never estimates taxes on top of a quote.
 */
export interface StayQuote {
  id: string;
  kind: "stay_quote";
  label: string;
  resortId: string;
  roomTypeId: string;
  checkIn: IsoDate;
  nights: number;
  adults: number;
  children: number;
  bookingMethod: BookingMethod;
  /** Tickets included in a package quote (required for packages). */
  ticket?: { option: TicketOption; days: number };
  /** Dining plan included in a package quote; "out_of_pocket" = no plan. */
  dining: DiningChoice;
  totalCents: Cents;
  provenance: Provenance;
}

export interface TransportProfile {
  id: string;
  resortId: string;
  /** Overnight hotel parking if the party has a car. */
  overnightParkingPerNightCents: Cents;
  /** Theme park parking per park day if the party has a car. */
  parkParkingPerParkDayCents: Cents;
  /** Round-trip cost per park day without a car (0 when resort transportation is included). */
  noCarPerParkDayCents: Cents;
  provenance: Provenance;
}

export interface TaxRate {
  id: string;
  category: TaxCategory;
  ratePct: number;
  provenance: Provenance;
}

export type PromotionDiscount =
  | { type: "room_percent"; pct: number }
  | { type: "room_fixed_per_night"; cents: Cents }
  | { type: "package_fixed"; cents: Cents };

/**
 * A promotion is a structured rule. It is only applied when every condition is
 * checkably satisfied; conditions that depend on unknown facts (e.g. residency)
 * make it "uncertain" and it is reported, not applied.
 */
export interface Promotion {
  id: string;
  name: string;
  discount: PromotionDiscount;
  travel: {
    from: IsoDate;
    to: IsoDate;
    /**
     * all_nights: every night must fall in the window.
     * arrival_date: only the arrival date must fall in the window.
     * per_night: the discount applies only to nights inside the window.
     */
    rule: "all_nights" | "arrival_date" | "per_night";
  };
  /** Window in which the booking must be made. */
  booking?: { from: IsoDate; to: IsoDate };
  /** Eligible resorts (empty/undefined = all on-property resorts). */
  resortIds?: string[];
  /** Eligible room types as "resortId/roomTypeId" keys (undefined = all rooms at eligible resorts). */
  roomKeys?: string[];
  minNights?: number;
  maxNights?: number;
  minTicketDays?: number;
  requiresPackage: boolean;
  minPartySize?: number;
  maxPartySize?: number;
  audience?: Audience[];
  /** Night dates on which the offer is not valid. */
  blackoutNights?: IsoDate[];
  terms: string;
  provenance: Provenance;
}

export interface PriceData {
  roomRates: RoomRate[];
  ticketPrices: TicketPrice[];
  diningPlanPrices: DiningPlanPrice[];
  stayQuotes: StayQuote[];
  transport: TransportProfile[];
  taxRates: TaxRate[];
  promotions: Promotion[];
}

export interface Catalog {
  resorts: Resort[];
}

// ───────────────────────────── Configurations & evaluation results ─────────────────────────────

/** One concrete way to take the vacation. */
export interface Configuration {
  arrival: IsoDate;
  nights: number;
  resortId: string;
  roomTypeId: string;
  /** null when the trip has no park days. */
  ticketOption: TicketOption | null;
  bookingMethod: BookingMethod;
  dining: DiningChoice;
}

export type CostCategory =
  | "package"
  | "room"
  | "room_tax"
  | "tickets"
  | "ticket_tax"
  | "dining"
  | "dining_tax"
  | "transport"
  | "rental_car"
  | "discount"
  | "other";

export interface CostLine {
  key: string;
  category: CostCategory;
  label: string;
  /** null = could not be priced (status "unavailable"). Negative for discounts. */
  amountCents: Cents | null;
  status: PriceStatus;
  source: string;
  /** Human-readable explanation of how the amount was calculated. */
  calculation: string;
  /** True when the component is covered by a package quote and therefore contributes $0 here. */
  includedInQuote?: boolean;
}

export interface PromotionApplication {
  promotionId: string;
  name: string;
  savingsCents: Cents;
  status: PriceStatus;
  terms: string;
}

export interface PotentialPromotion {
  promotionId: string;
  name: string;
  /** Savings if eligibility were confirmed; null when it cannot be computed. */
  potentialSavingsCents: Cents | null;
  unknowns: string[];
}

export interface ValueScore {
  total: number;
  parts: { key: keyof ValueWeights; label: string; score: number; weightPct: number }[];
}

export interface Savings {
  baselineTotalCents: Cents;
  /** Positive = cheaper than the baseline. */
  savingsCents: Cents;
  /** Same nights, park days, ticket option and dining choice as the baseline. */
  likeForLike: boolean;
  basis: string;
  perNightDeltaCents: Cents;
}

export interface Evaluation {
  id: string;
  config: Configuration;
  departure: IsoDate;
  resortName: string;
  roomName: string;
  lines: CostLine[];
  /** Sum of all priced lines. A lower bound when `complete` is false. */
  totalCents: Cents;
  complete: boolean;
  missing: string[];
  /** Weakest status among lines that carry money (or are unavailable). */
  dataStatus: PriceStatus;
  containsIllustrative: boolean;
  /** Dollars by provenance status (absolute values), so users see how much of the total is real. */
  statusTotals: Partial<Record<PriceStatus, Cents>>;
  appliedPromotion: PromotionApplication | null;
  potentialPromotions: PotentialPromotion[];
  assumptions: string[];
  /** Hard-constraint violations. Non-empty = infeasible. */
  violations: string[];
  budget: { overTargetCents: Cents | null; withinHardLimit: boolean | "unknown" };
  perNightCents: Cents;
  perParkDayCents: Cents | null;
  valueScore: ValueScore | null;
  differences: string[];
  savings: Savings | null;
  /** The other booking method for the same trip, if it was evaluated and collapsed into this result. */
  otherBookingMethod: { method: BookingMethod; totalCents: Cents; complete: boolean } | null;
}

// ───────────────────────────── Trip request ─────────────────────────────

export interface ValueWeights {
  price: number;
  resort: number;
  convenience: number;
  ticket: number;
  dining: number;
  dates: number;
}

export type Tristate = "yes" | "no" | "unknown";

export interface OtherExpense {
  label: string;
  cents: Cents;
  per: "trip" | "night" | "person" | "person_night";
}

export interface TripRequest {
  party: { adults: number; children: number; infants: number };
  dates: { earliestArrival: IsoDate; latestDeparture: IsoDate; minNights: number; maxNights: number };
  /** The user's preferred plan; used as the savings baseline and for preference scoring. */
  preferred: {
    arrival?: IsoDate;
    nights?: number;
    resortId?: string;
    roomTypeId?: string;
    ticketOption?: TicketOption;
    bookingMethod?: BookingMethod;
    dining?: DiningChoice;
  };
  resorts: { allowedResortIds: string[]; requireOnProperty: boolean; preferredResortIds: string[] };
  tickets: {
    parkDays: number;
    allowedOptions: TicketOption[];
    parkOnArrivalDay: boolean;
    parkOnDepartureDay: boolean;
    allowThirdParty: boolean;
  };
  dining: {
    policy: "require" | "prefer" | "consider" | "exclude";
    outOfPocketPerAdultPerNightCents: Cents;
    outOfPocketPerChildPerNightCents: Cents;
  };
  transport: { mode: "no_car" | "own_car" | "rental_car"; rentalPerDayCents: Cents };
  budget: { targetCents?: Cents; hardLimitCents?: Cents };
  otherExpenses: OtherExpense[];
  eligibility: Record<Audience, Tristate>;
  objective: "lowest_cost" | "best_value";
  weights: ValueWeights;
  data: { includeIllustrative: boolean; staleAfterDays: number };
  /** Date the booking would be made (for promotion booking windows). Defaults to today. */
  bookingDate?: IsoDate;
}

// ───────────────────────────── Optimization result ─────────────────────────────

export interface Award {
  kind: "cheapest" | "best_value" | "best_alternative";
  evaluationId: string;
  explanation: string[];
}

export interface OptimizationResult {
  runAt: string;
  today: IsoDate;
  /** True when awards are based on illustrative (demo) prices. */
  demoMode: boolean;
  awards: Award[];
  ranked: Evaluation[];
  baseline: Evaluation | null;
  baselineNote: string | null;
  excluded: {
    illustrative: Evaluation[];
    incomplete: Evaluation[];
    overHardLimit: Evaluation[];
  };
  /** Cheapest comparable total for each (arrival, nights) pair. */
  dateMatrix: { arrival: IsoDate; nights: number; totalCents: Cents; evaluationId: string }[];
  stats: {
    candidates: number;
    infeasible: number;
    infeasibleReasons: { reason: string; count: number }[];
    priced: number;
    complete: number;
    comparable: number;
  };
  notices: string[];
}

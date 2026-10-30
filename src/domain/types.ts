import type { Cents } from "./money";
import type { IsoDate } from "./dates";
import type { PriceStatus, Provenance } from "./provenance";

// ───────────────────────────── Catalog (structure, not prices) ─────────────────────────────

export type ResortTier = "value" | "moderate" | "deluxe" | "deluxe_villa" | "partner" | "off_property";

/**
 * "hotel": conventional room bookable for cash (room-only or Disney package).
 * "dvc_villa": Disney Vacation Club villa. Bookable for cash like a hotel room, and
 * additionally with DVC points (owned or rented), which is priced very differently.
 */
export type AccommodationType = "hotel" | "dvc_villa";

export interface RoomType {
  id: string;
  name: string;
  /** Maximum guests including children under 3 (conservative; verify per resort). */
  maxOccupancy: number;
  /** View or location qualifier shown to the user (e.g. "Lagoon view"). */
  view?: string;
}

export interface TaxJurisdiction {
  id: string;
  name: string;
}

export interface Resort {
  id: string;
  name: string;
  tier: ResortTier;
  /** Owned and operated by Disney: eligible for Disney packages, dining plans and Disney resort transport. */
  disneyOwned: boolean;
  accommodation: AccommodationType;
  /** True when villas can be reserved with DVC points (owned or rented). */
  dvcPoints: boolean;
  roomTypes: RoomType[];
  /** Subjective 1–5 convenience rating (transportation, proximity). An editorial assumption, not data. */
  convenience: number;
  transportNote: string;
  /** Tax jurisdiction for lodging (and resort-sold dining). Catalog data, not engine logic. */
  taxJurisdictionId: string;
  /** Set when the jurisdiction assignment is not confirmed by a reliable source. */
  taxJurisdictionNote?: string;
}

export type TicketOption = "base" | "park_hopper" | "park_hopper_plus";
export type AgeCategory = "adult" | "child";
export type DiningPlan = "quick_service_plan" | "dining_plan";
/** How food is paid for: a Disney dining plan, or out of pocket (user-estimated). */
export type DiningChoice = "out_of_pocket" | DiningPlan;
/**
 * "separate" = room-only cash reservation + tickets bought on their own;
 * "package" = Disney room + ticket package;
 * "points" = DVC villa reserved with points (owned or rented) + tickets bought separately.
 */
export type BookingMethod = "separate" | "package" | "points";
export type TicketChannel = "disney" | "third_party";
export type TaxCategory = "lodging" | "sales";
export type Audience = "florida_resident" | "annual_passholder" | "military";

// ───────────────────────────── Price data (every item carries provenance) ─────────────────────────────

/**
 * A previous observation of a price, kept when the user re-checks an entry so
 * history is never silently overwritten. `value` is the entry's main price
 * field at that time (cents, or points for point charts).
 */
export interface PriceObservation {
  observedAt: IsoDate;
  /** When this observation was superseded (ISO timestamp). */
  supersededAt: string;
  status: Provenance["status"];
  source: string;
  sourceUrl?: string;
  notes?: string;
  value: number | null;
}

/**
 * How a ticket may be used. Kept separate from its price. `null` means
 * unknown, and unknown restrictions are reported rather than assumed.
 */
export interface TicketUsage {
  /** All admission days must be used within this many calendar days of first use (null = unknown). */
  useWithinDays: number | null;
  /** Last date the ticket can be used, if it has a known expiration. */
  expiresOn?: IsoDate;
  /** Known dates on which the ticket cannot be used. */
  blockoutDates?: IsoDate[];
  /** Whether theme park reservations are required (null = unknown). Availability is never checked. */
  parkReservationRequired: boolean | null;
  notes?: string;
}

/**
 * Payment and cancellation terms of a quote or reservation. Kept separate
 * from the quoted total: what is due now, and what cancelling would cost, are
 * different numbers from the price of the trip.
 */
export interface PaymentTerms {
  /** Deposit required to book (null = unknown). */
  depositCents: Cents | null;
  depositDueDate?: IsoDate;
  /** Scheduled payments after the deposit. */
  installments: { dueDate: IsoDate; amountCents: Cents; label?: string }[];
  /** When any remaining balance is due. */
  finalPaymentDueDate?: IsoDate;
  /** Amount already paid (for an existing reservation). */
  amountPaidCents?: Cents;
  refundability: "refundable" | "partially_refundable" | "non_refundable" | "unknown";
  /** Cancelling on or before this date costs nothing (when refundable). */
  freeCancellationUntil?: IsoDate;
  /** From `fromDate` on, cancelling costs `cents` or `pct`% of the total. Latest applicable tier wins. */
  cancellationPenalties: { fromDate: IsoDate; cents?: Cents; pct?: number; note?: string }[];
  notes?: string;
}

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
  history?: PriceObservation[];
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
  /** Usage restrictions stated for this specific ticket (overrides product-level rules). */
  usage?: TicketUsage;
  provenance: Provenance;
  history?: PriceObservation[];
}

/** Usage rules for a ticket product (e.g. "Disney 4-day Park Hopper"), applied to its prices. */
export interface TicketRule {
  id: string;
  kind: "ticket_rule";
  option: TicketOption;
  /** null = applies to every duration of this ticket type. */
  days: number | null;
  channel: TicketChannel;
  usage: TicketUsage;
  provenance: Provenance;
  history?: PriceObservation[];
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
  history?: PriceObservation[];
}

/**
 * A real quote for a complete stay, as shown on a booking page or by a rental
 * provider. Tax handling is explicit: tax-inclusive totals are used as-is; a
 * separately quoted tax amount is added; otherwise taxes are estimated where
 * that is possible (room-only) and reported unavailable where it is not.
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
  ticket?: { option: TicketOption; days: number; usage?: TicketUsage };
  /** Dining plan included in a package quote; "out_of_pocket" = no plan. */
  dining: DiningChoice;
  totalCents: Cents;
  /** Whether `totalCents` already includes taxes. */
  taxIncluded: boolean;
  /** Taxes quoted separately (only when `taxIncluded` is false). */
  taxCents?: Cents;
  /** Points behind a DVC point-rental quote (informational; the total is what is paid). */
  points?: { pointsRequired: number; centsPerPoint: Cents };
  terms?: PaymentTerms;
  /** This quote is an existing reservation the user holds (cancellation terms then matter for switching). */
  booked?: boolean;
  provenance: Provenance;
  history?: PriceObservation[];
}

/** Points needed per night for a DVC villa (from a published point chart). */
export interface PointChartEntry {
  id: string;
  kind: "point_chart";
  resortId: string;
  roomTypeId: string;
  validFrom: IsoDate;
  validTo: IsoDate;
  daysOfWeek?: number[];
  pointsPerNight: number;
  provenance: Provenance;
  history?: PriceObservation[];
}

/**
 * The cash cost of one DVC point: a rental provider's price per point, or the
 * user's own valuation of points they own.
 */
export interface PointCost {
  id: string;
  kind: "point_cost";
  label: string;
  type: "rental" | "owned";
  centsPerPoint: Cents;
  /** Minimum points per reservation, if the provider has one. */
  minPoints?: number;
  /** Flat fee per reservation, if any. */
  feeCents?: Cents;
  /** Resorts this cost applies to (undefined = all DVC resorts). */
  resortIds?: string[];
  terms?: PaymentTerms;
  provenance: Provenance;
  history?: PriceObservation[];
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
  jurisdictionId: string;
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
  history?: PriceObservation[];
}

export interface PriceData {
  roomRates: RoomRate[];
  ticketPrices: TicketPrice[];
  diningPlanPrices: DiningPlanPrice[];
  stayQuotes: StayQuote[];
  transport: TransportProfile[];
  taxRates: TaxRate[];
  promotions: Promotion[];
  ticketRules: TicketRule[];
  pointCharts: PointChartEntry[];
  pointCosts: PointCost[];
}

export interface Catalog {
  resorts: Resort[];
  taxJurisdictions: TaxJurisdiction[];
  /** Jurisdiction whose sales tax applies to separately bought park tickets (an explicit, documented assumption). */
  ticketTaxJurisdictionId: string;
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
  | "fees"
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
  /**
   * Present when the baseline is an existing reservation: what cancelling it
   * would cost today, and the savings after that cost (null = unknown).
   */
  switching: { penaltyCents: Cents | null; netSavingsCents: Cents | null; note: string } | null;
}

export interface TicketUsability {
  status: "ok" | "violated" | "unknown";
  /** Calendar days on which the ticket could be used during the trip (null when not computable). */
  usableDays: number | null;
  reasons: string[];
  unknowns: string[];
  parkReservationRequired: boolean | null;
  /** Where the usage rule came from. */
  source: string | null;
}

export interface PaymentSummary {
  totalCents: Cents;
  paidCents: Cents;
  balanceCents: Cents;
  /** Amount needed to book now (deposit), null when unknown. Distinct from the trip total. */
  dueToBookCents: Cents | null;
  schedule: { dueDate: IsoDate | null; label: string; amountCents: Cents; state: "paid" | "overdue" | "upcoming" }[];
  cancellation: {
    asOf: IsoDate;
    refundability: PaymentTerms["refundability"];
    /** What cancelling on `asOf` would cost (null = unknown). */
    penaltyCents: Cents | null;
    freeCancellationUntil?: IsoDate;
    note: string;
  };
  warnings: string[];
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
  /** Usability of the priced tickets for the planned park days (null when no tickets). */
  ticketUsability: TicketUsability | null;
  /** Payment schedule and cancellation exposure, when terms are known (from a quote or point-rental terms). */
  payment: PaymentSummary | null;
  /** Id of the stay quote this result is priced from, if any. */
  quoteId: string | null;
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
  /** `requireOnProperty` means "require a Disney-owned resort" (the field name is kept for saved trips). */
  resorts: { allowedResortIds: string[]; requireOnProperty: boolean; preferredResortIds: string[]; considerPoints?: boolean };
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
  /** Evaluations explicitly requested via `include` (e.g. a date picked from the calendar). */
  included: Evaluation[];
  /** Cheapest comparable total for each (arrival, nights) pair. */
  dateMatrix: { arrival: IsoDate; nights: number; totalCents: Cents; evaluationId: string }[];
  stats: {
    candidates: number;
    infeasible: number;
    infeasibleReasons: { reason: string; count: number }[];
    /** Configurations fully priced. */
    priced: number;
    /** Configurations skipped because a lower bound proves they cannot change any result. */
    pruned: number;
    complete: number;
    comparable: number;
  };
  notices: string[];
}

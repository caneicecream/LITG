import type { IsoDate } from "@/domain/dates";
import type { Provenance } from "@/domain/provenance";
import type { DiningPlanPrice, Promotion, RoomRate, TicketOption, TicketPrice } from "@/domain/types";

/**
 * ILLUSTRATIVE DEMO DATA. NOT REAL PRICES.
 *
 * Generated deterministically from simple formulas so the optimizer and UI can
 * be exercised without live data. Magnitudes are plausible on purpose (so the
 * demo is meaningful), but none of these numbers is a quote, a published rate,
 * or a bookable offer. Every item is tagged `illustrative`, and the optimizer
 * never ranks these alongside real (manual/verified) prices.
 */
export const ILLUSTRATIVE_SOURCE = "Illustrative demo dataset (not real prices)";
const prov: Provenance = { status: "illustrative", source: ILLUSTRATIVE_SOURCE, observedAt: "2026-10-30" };

/** Demo "seasons" with a price multiplier, covering Nov 2026 – Dec 2027. */
export const DEMO_SEASONS: { from: IsoDate; to: IsoDate; factor: number; name: string }[] = [
  { from: "2026-11-01", to: "2026-11-20", factor: 1.0, name: "Fall" },
  { from: "2026-11-21", to: "2026-11-29", factor: 1.3, name: "Thanksgiving" },
  { from: "2026-11-30", to: "2026-12-18", factor: 1.05, name: "Early December" },
  { from: "2026-12-19", to: "2027-01-02", factor: 1.55, name: "Holidays" },
  { from: "2027-01-03", to: "2027-02-11", factor: 0.85, name: "Winter value" },
  { from: "2027-02-12", to: "2027-02-21", factor: 1.25, name: "Presidents' week" },
  { from: "2027-02-22", to: "2027-03-05", factor: 1.0, name: "Late winter" },
  { from: "2027-03-06", to: "2027-04-10", factor: 1.35, name: "Spring break" },
  { from: "2027-04-11", to: "2027-05-27", factor: 1.05, name: "Spring" },
  { from: "2027-05-28", to: "2027-08-08", factor: 1.2, name: "Summer" },
  { from: "2027-08-09", to: "2027-09-30", factor: 0.85, name: "Late summer" },
  { from: "2027-10-01", to: "2027-11-20", factor: 1.05, name: "Fall" },
  { from: "2027-11-21", to: "2027-11-28", factor: 1.3, name: "Thanksgiving" },
  { from: "2027-11-29", to: "2027-12-17", factor: 1.05, name: "Early December" },
  { from: "2027-12-18", to: "2027-12-31", factor: 1.55, name: "Holidays" },
];

/** Demo base nightly rates (Sun–Thu, factor 1.0), in dollars. */
const BASE_RATES: { resortId: string; roomTypeId: string; dollars: number }[] = [
  { resortId: "pop-century", roomTypeId: "standard", dollars: 190 },
  { resortId: "all-star-movies", roomTypeId: "standard", dollars: 165 },
  { resortId: "art-of-animation", roomTypeId: "standard", dollars: 185 },
  { resortId: "art-of-animation", roomTypeId: "family-suite", dollars: 440 },
  { resortId: "caribbean-beach", roomTypeId: "standard", dollars: 290 },
  { resortId: "coronado-springs", roomTypeId: "standard", dollars: 275 },
  { resortId: "yacht-club", roomTypeId: "standard", dollars: 560 },
  { resortId: "contemporary", roomTypeId: "standard", dollars: 590 },
  { resortId: "off-property", roomTypeId: "standard", dollars: 140 },
];

const WEEKEND_UPLIFT = 1.12;
const SUN_THU = [0, 1, 2, 3, 4];
const FRI_SAT = [5, 6];
const toCents = (dollars: number) => Math.round(dollars) * 100;

function roomRates(): RoomRate[] {
  const out: RoomRate[] = [];
  for (const base of BASE_RATES) {
    DEMO_SEASONS.forEach((s, i) => {
      for (const [days, mult, tag] of [
        [SUN_THU, 1, "wk"],
        [FRI_SAT, WEEKEND_UPLIFT, "we"],
      ] as const) {
        out.push({
          id: `demo-room-${base.resortId}-${base.roomTypeId}-${i}-${tag}`,
          kind: "room_rate",
          resortId: base.resortId,
          roomTypeId: base.roomTypeId,
          validFrom: s.from,
          validTo: s.to,
          daysOfWeek: [...days],
          nightlyCents: toCents(base.dollars * s.factor * mult),
          taxIncluded: false,
          provenance: prov,
        });
      }
    });
  }
  return out;
}

/** Cumulative multiplier of the 1-day price for an N-day ticket (longer tickets cost less per day). */
const DAY_CURVE = [0, 1, 1.9, 2.75, 3.5, 3.9, 4.25, 4.55, 4.8, 5.05, 5.3];

function ticketPrices(): TicketPrice[] {
  const out: TicketPrice[] = [];
  DEMO_SEASONS.forEach((s, i) => {
    // Ticket prices vary less by season than rooms.
    const oneDay = 150 * (1 + (s.factor - 1) * 0.5);
    for (let days = 1; days <= 10; days++) {
      const base = oneDay * DAY_CURVE[days]!;
      const hopper = base + 75 + 6 * days;
      const byOption: Record<TicketOption, number> = {
        base,
        park_hopper: hopper,
        park_hopper_plus: hopper + 25 + 2 * days,
      };
      for (const option of Object.keys(byOption) as TicketOption[]) {
        for (const age of ["adult", "child"] as const) {
          out.push({
            id: `demo-ticket-${option}-${days}-${age}-${i}`,
            kind: "ticket_price",
            option,
            days,
            age,
            validFrom: s.from,
            validTo: s.to,
            cents: toCents(byOption[option] * (age === "child" ? 0.95 : 1)),
            taxIncluded: false,
            channel: "disney",
            provenance: prov,
          });
        }
      }
    }
  });
  return out;
}

function diningPlanPrices(): DiningPlanPrice[] {
  const plans = [
    { plan: "quick_service_plan" as const, adult: 60, child: 27 },
    { plan: "dining_plan" as const, adult: 100, child: 36 },
  ];
  return plans.flatMap((p) =>
    (["adult", "child"] as const).map((age) => ({
      id: `demo-dining-${p.plan}-${age}`,
      kind: "dining_plan_price" as const,
      plan: p.plan,
      age,
      validFrom: "2026-11-01",
      validTo: "2027-12-31",
      perNightCents: toCents(age === "adult" ? p.adult : p.child),
      taxIncluded: true,
      provenance: { ...prov, notes: "Illustrative; assumed tax-inclusive." },
    })),
  );
}

export const ILLUSTRATIVE_PROMOTIONS: Promotion[] = [
  {
    id: "demo-promo-room-20",
    name: "Illustrative: 20% off rooms at select resorts",
    discount: { type: "room_percent", pct: 20 },
    travel: { from: "2027-01-03", to: "2027-03-31", rule: "all_nights" },
    booking: { from: "2026-10-01", to: "2027-01-31" },
    resortIds: ["pop-century", "all-star-movies", "caribbean-beach", "coronado-springs"],
    minNights: 3,
    requiresPackage: false,
    terms: "Demo offer. Every night of the stay must fall between Jan 3 and Mar 31, 2027; minimum 3 nights; book by Jan 31, 2027.",
    provenance: prov,
  },
  {
    id: "demo-promo-package-250",
    name: "Illustrative: $250 off 5+ night packages",
    discount: { type: "package_fixed", cents: 25000 },
    travel: { from: "2026-11-30", to: "2026-12-18", rule: "arrival_date" },
    booking: { from: "2026-09-15", to: "2026-11-30" },
    minNights: 5,
    minTicketDays: 4,
    requiresPackage: true,
    terms: "Demo offer. Package with tickets of 4+ days; arrive Nov 30 – Dec 18, 2026; minimum 5 nights; book by Nov 30, 2026.",
    provenance: prov,
  },
  {
    id: "demo-promo-fl-25",
    name: "Illustrative: Florida resident 25% off rooms",
    discount: { type: "room_percent", pct: 25 },
    travel: { from: "2027-01-03", to: "2027-04-30", rule: "per_night" },
    booking: { from: "2026-10-15", to: "2027-02-28" },
    audience: ["florida_resident"],
    requiresPackage: false,
    terms: "Demo offer. Florida residents only; discount applies to nights Jan 3 – Apr 30, 2027.",
    provenance: prov,
  },
];

export const ILLUSTRATIVE_DATA = {
  roomRates: roomRates(),
  ticketPrices: ticketPrices(),
  diningPlanPrices: diningPlanPrices(),
  promotions: ILLUSTRATIVE_PROMOTIONS,
};

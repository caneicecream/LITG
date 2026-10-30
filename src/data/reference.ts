import type { Provenance } from "@/domain/provenance";
import type { Resort, TaxRate, TransportProfile } from "@/domain/types";
import { CATALOG } from "./catalog";

/**
 * Reference data that is not a price quote but is needed for a total: tax rates
 * and transportation/parking costs. Everything here is an explicit ESTIMATE
 * with a documented basis. A tax-inclusive quote always supersedes these.
 */
const ESTIMATED_AS_OF = "2026-10-30";

const est = (source: string, notes: string): Provenance => ({ status: "estimated", source, observedAt: ESTIMATED_AS_OF, notes });

/**
 * Tax rates by jurisdiction (catalog data; the engine only looks them up).
 * Lodging = sales tax + 6% tourist development tax. Basis: published rates as
 * commonly reported for Walt Disney World resorts (12.5% Orange, 13.5% at the
 * Osceola County All-Star resorts). Rates change; check the booking cart.
 */
export const TAX_RATES: TaxRate[] = [
  {
    id: "tax-orange-lodging",
    jurisdictionId: "orange-fl",
    category: "lodging",
    ratePct: 12.5,
    provenance: est("Estimate: Orange County, FL lodging tax", "6.5% sales tax + 6% tourist development tax."),
  },
  {
    id: "tax-orange-sales",
    jurisdictionId: "orange-fl",
    category: "sales",
    ratePct: 6.5,
    provenance: est("Estimate: Orange County, FL sales tax", "Applied to tickets and dining plans when prices exclude tax."),
  },
  {
    id: "tax-osceola-lodging",
    jurisdictionId: "osceola-fl",
    category: "lodging",
    ratePct: 13.5,
    provenance: est("Estimate: Osceola County, FL lodging tax", "7.5% sales tax + 6% tourist development tax; matches the 13.5% reported at the All-Star resorts."),
  },
  {
    id: "tax-osceola-sales",
    jurisdictionId: "osceola-fl",
    category: "sales",
    ratePct: 7.5,
    provenance: est("Estimate: Osceola County, FL sales tax", "6% state + 1.5% county surtax."),
  },
];

const DISNEY_PARKING: Partial<Record<Resort["tier"], number>> = { value: 1500, moderate: 2000, deluxe: 2500, deluxe_villa: 2500 };

function profile(r: Resort): TransportProfile {
  if (r.disneyOwned) {
    return {
      id: `transport-${r.id}`,
      resortId: r.id,
      overnightParkingPerNightCents: DISNEY_PARKING[r.tier] ?? 2500,
      parkParkingPerParkDayCents: 0,
      noCarPerParkDayCents: 0,
      provenance: est(
        "Estimate: Disney resort parking & transportation",
        "Disney resort transportation is included. Overnight parking by tier ($15/$20/$25) and free theme park parking for resort guests reflect fees published in 2023; verify current fees.",
      ),
    };
  }
  if (r.tier === "partner") {
    return {
      id: `transport-${r.id}`,
      resortId: r.id,
      overnightParkingPerNightCents: 3500,
      parkParkingPerParkDayCents: 3000,
      noCarPerParkDayCents: 0,
      provenance: est(
        "Estimate: on-site partner hotel assumptions",
        "Assumes Disney bus service at no charge, about $35/night hotel parking, and standard theme park parking. Not verified; enter your own figures as other expenses if they differ.",
      ),
    };
  }
  return {
    id: `transport-${r.id}`,
    resortId: r.id,
    overnightParkingPerNightCents: 2000,
    parkParkingPerParkDayCents: 3000,
    noCarPerParkDayCents: 4500,
    provenance: est(
      "Estimate: off-property transportation assumptions",
      "Assumes $20/night hotel parking, $30/day standard theme park parking, or $45/day round-trip rideshare without a car. Adjust by entering your own costs as other expenses.",
    ),
  };
}

export const TRANSPORT: TransportProfile[] = CATALOG.resorts.map(profile);

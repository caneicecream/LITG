import type { Provenance } from "@/domain/provenance";
import type { TaxRate, TransportProfile } from "@/domain/types";
import { CATALOG } from "./catalog";

/**
 * Reference data that is not a price quote but is needed for a total: tax rates
 * and transportation/parking costs. Everything here is an explicit ESTIMATE
 * with a documented basis. A real quote always supersedes these (quotes are
 * tax-inclusive, so no tax is estimated on top of them).
 */
const ESTIMATED_AS_OF = "2026-10-30";

const est = (source: string, notes: string): Provenance => ({
  status: "estimated",
  source,
  observedAt: ESTIMATED_AS_OF,
  notes,
});

export const TAX_RATES: TaxRate[] = [
  {
    id: "tax-lodging",
    category: "lodging",
    ratePct: 12.5,
    provenance: est(
      "Estimate: Orange County, FL lodging tax",
      "6.5% sales tax + 6% tourist development tax. Some Walt Disney World resorts are in Osceola County, where the combined rate may differ. Enter a tax-inclusive quote for an exact figure.",
    ),
  },
  {
    id: "tax-sales",
    category: "sales",
    ratePct: 6.5,
    provenance: est("Estimate: Orange County, FL sales tax", "Applied to tickets and dining plans when prices exclude tax."),
  },
];

const PARKING_BY_TIER = { value: 1500, moderate: 2000, deluxe: 2500, off_property: 2000 } as const;

export const TRANSPORT: TransportProfile[] = CATALOG.resorts.map((r) =>
  r.onProperty
    ? {
        id: `transport-${r.id}`,
        resortId: r.id,
        overnightParkingPerNightCents: PARKING_BY_TIER[r.tier],
        parkParkingPerParkDayCents: 0,
        noCarPerParkDayCents: 0,
        provenance: est(
          "Estimate: Disney resort parking & transportation",
          "Disney resort transportation is included. Overnight parking by tier ($15/$20/$25) and free theme park parking for resort guests reflect fees published in 2023; verify current fees.",
        ),
      }
    : {
        id: `transport-${r.id}`,
        resortId: r.id,
        overnightParkingPerNightCents: PARKING_BY_TIER.off_property,
        parkParkingPerParkDayCents: 3000,
        noCarPerParkDayCents: 4500,
        provenance: est(
          "Estimate: off-property transportation assumptions",
          "Assumes $20/night hotel parking, $30/day standard theme park parking, or $45/day round-trip rideshare without a car. Adjust by entering your own costs as other expenses.",
        ),
      },
);

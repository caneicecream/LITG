import { DEFAULT_WEIGHTS } from "@/domain/schema";
import type { TripRequest } from "@/domain/types";

/**
 * Starting point for the planner form: two adults, 5 park days, Pop Century
 * preferred, flexible dates in Jan–Feb 2027. Food estimates are the user's
 * own assumptions and are labelled "estimated" in every breakdown.
 */
export function defaultTripRequest(): TripRequest {
  return {
    party: { adults: 2, children: 0, infants: 0 },
    dates: { earliestArrival: "2027-01-04", latestDeparture: "2027-02-20", minNights: 5, maxNights: 7 },
    preferred: {
      arrival: "2027-01-17",
      nights: 6,
      resortId: "pop-century",
      roomTypeId: "standard",
      ticketOption: "park_hopper_plus",
      bookingMethod: "separate",
      dining: "out_of_pocket",
    },
    resorts: { allowedResortIds: [], requireOnProperty: true, preferredResortIds: ["pop-century"] },
    tickets: {
      parkDays: 5,
      allowedOptions: ["park_hopper", "park_hopper_plus"],
      parkOnArrivalDay: false,
      parkOnDepartureDay: false,
      allowThirdParty: true,
    },
    dining: { policy: "consider", outOfPocketPerAdultPerNightCents: 8500, outOfPocketPerChildPerNightCents: 4000 },
    transport: { mode: "no_car", rentalPerDayCents: 6000 },
    budget: { targetCents: 400000 },
    otherExpenses: [],
    eligibility: { florida_resident: "unknown", annual_passholder: "unknown", military: "unknown" },
    objective: "lowest_cost",
    weights: { ...DEFAULT_WEIGHTS },
    data: { includeIllustrative: true, staleAfterDays: 14 },
  };
}

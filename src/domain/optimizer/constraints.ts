import { addDays } from "../dates";
import type { Configuration, Resort, TripRequest } from "../types";
import { TICKET_LABEL } from "../pricing/calculate";

/** Number of calendar days of the trip that can be park days. */
export function availableParkDays(nights: number, parkOnArrivalDay: boolean, parkOnDepartureDay: boolean): number {
  return nights + 1 - (parkOnArrivalDay ? 0 : 1) - (parkOnDepartureDay ? 0 : 1);
}

/**
 * Hard constraints: any violation makes a configuration infeasible. These are
 * the user's requirements plus booking rules (e.g. dining plans are sold only
 * with packages). Soft preferences are handled by scoring, never here.
 */
export function checkHardConstraints(config: Configuration, resort: Resort, req: TripRequest): string[] {
  const v: string[] = [];
  const room = resort.roomTypes.find((r) => r.id === config.roomTypeId);
  const partySize = req.party.adults + req.party.children + req.party.infants;
  const departure = addDays(config.arrival, config.nights);

  if (config.arrival < req.dates.earliestArrival) v.push("Arrives before your earliest arrival date");
  if (departure > req.dates.latestDeparture) v.push("Departs after your latest departure date");
  if (config.nights < req.dates.minNights || config.nights > req.dates.maxNights) {
    v.push(`Stay length outside ${req.dates.minNights}–${req.dates.maxNights} nights`);
  }
  if (req.resorts.allowedResortIds.length > 0 && !req.resorts.allowedResortIds.includes(resort.id)) {
    // One generic reason (not one per resort), so the ruled-out summary stays readable.
    v.push("Resort is not in your allowed resorts");
  }
  if (req.resorts.requireOnProperty && !resort.disneyOwned) v.push("You require a Disney-owned resort");
  if (!room) v.push("Unknown room type");
  else if (partySize > room.maxOccupancy) v.push(`${room.name} sleeps ${room.maxOccupancy}; your party is ${partySize}`);

  if (req.tickets.parkDays > 0) {
    if (!config.ticketOption) v.push("Park tickets are required");
    else if (!req.tickets.allowedOptions.includes(config.ticketOption)) {
      v.push(`${TICKET_LABEL[config.ticketOption]} is not one of your accepted ticket types`);
    }
    const avail = availableParkDays(config.nights, req.tickets.parkOnArrivalDay, req.tickets.parkOnDepartureDay);
    if (avail < req.tickets.parkDays) v.push(`Only ${avail} possible park days for ${req.tickets.parkDays} required`);
  } else if (config.ticketOption) {
    v.push("Tickets selected for a trip with no park days");
  }

  if (req.dining.policy === "require" && config.dining === "out_of_pocket") v.push("You require a dining plan");
  if (req.dining.policy === "exclude" && config.dining !== "out_of_pocket") v.push("You excluded dining plans");

  if (config.bookingMethod === "package") {
    if (!resort.disneyOwned) v.push("Disney packages are only available at Disney-owned resorts");
    if (!config.ticketOption) v.push("Disney packages include park tickets");
  }
  if (config.bookingMethod === "points") {
    if (!resort.dvcPoints) v.push(`${resort.name} can't be reserved with DVC points`);
    if (!req.resorts.considerPoints) v.push("DVC point stays are not enabled for this search");
  }
  if (config.dining !== "out_of_pocket" && config.bookingMethod !== "package") {
    v.push("Disney dining plans can only be purchased as part of a package");
  }
  return v;
}

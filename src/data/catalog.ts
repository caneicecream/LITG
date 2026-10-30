import type { Catalog, Resort, RoomType } from "@/domain/types";

/**
 * Catalog: *structure*, never prices. Names, tiers, room categories, occupancy,
 * accommodation type and tax jurisdiction. Prices live in price sources
 * (your entries, or the separately labelled illustrative dataset).
 *
 * Caveats (also shown in the UI where relevant):
 * - Occupancy figures are from general knowledge and deliberately conservative
 *   (several rooms sleep one more than listed). Verify on the booking site.
 * - Convenience ratings are subjective editorial assumptions used only by the
 *   adjustable best-value score.
 * - Tax jurisdiction: the All-Star resorts are documented as being in Osceola
 *   County; most of the property is in Orange County. Animal Kingdom Lodge and
 *   Kidani Village are not confirmed either way (see their notes).
 */

const ORANGE = "orange-fl";
const OSCEOLA = "osceola-fl";
const AK_NOTE = "County not confirmed; the higher Osceola County rate is used so costs are not understated";

const room = (id: string, name: string, maxOccupancy: number, view?: string): RoomType => ({ id, name, maxOccupancy, ...(view ? { view } : {}) });
const studio = room("studio", "Deluxe Studio", 4);
const oneBr = room("one-bedroom", "One-Bedroom Villa", 4);
const twoBr = room("two-bedroom", "Two-Bedroom Villa", 8);

type Hotel = Omit<Resort, "accommodation" | "dvcPoints" | "disneyOwned"> & Partial<Pick<Resort, "disneyOwned">>;
const hotel = (r: Hotel): Resort => ({ accommodation: "hotel", dvcPoints: false, disneyOwned: true, ...r });
const villas = (r: Omit<Resort, "accommodation" | "dvcPoints" | "disneyOwned" | "tier">): Resort => ({
  ...r,
  tier: "deluxe_villa",
  accommodation: "dvc_villa",
  dvcPoints: true,
  disneyOwned: true,
});

export const CATALOG: Catalog = {
  taxJurisdictions: [
    { id: ORANGE, name: "Orange County, FL" },
    { id: OSCEOLA, name: "Osceola County, FL" },
  ],
  // Separately bought park tickets: Disney's theme parks are in Orange County (documented assumption).
  ticketTaxJurisdictionId: ORANGE,
  resorts: [
    // ── Value ──
    hotel({ id: "pop-century", name: "Disney's Pop Century Resort", tier: "value", roomTypes: [room("standard", "Standard Room", 4)], convenience: 3, transportNote: "Disney Skyliner and buses (included)", taxJurisdictionId: ORANGE }),
    hotel({ id: "art-of-animation", name: "Disney's Art of Animation Resort", tier: "value", roomTypes: [room("standard", "Little Mermaid Standard Room", 4), room("family-suite", "Family Suite", 6)], convenience: 3, transportNote: "Disney Skyliner and buses (included)", taxJurisdictionId: ORANGE }),
    hotel({ id: "all-star-movies", name: "Disney's All-Star Movies Resort", tier: "value", roomTypes: [room("standard", "Standard Room", 4), room("preferred", "Preferred Room", 4, "Closer to main building")], convenience: 2, transportNote: "Disney buses (included)", taxJurisdictionId: OSCEOLA }),
    hotel({ id: "all-star-music", name: "Disney's All-Star Music Resort", tier: "value", roomTypes: [room("standard", "Standard Room", 4), room("family-suite", "Family Suite", 6)], convenience: 2, transportNote: "Disney buses (included)", taxJurisdictionId: OSCEOLA }),
    hotel({ id: "all-star-sports", name: "Disney's All-Star Sports Resort", tier: "value", roomTypes: [room("standard", "Standard Room", 4)], convenience: 2, transportNote: "Disney buses (included)", taxJurisdictionId: OSCEOLA }),
    // ── Moderate ──
    hotel({ id: "caribbean-beach", name: "Disney's Caribbean Beach Resort", tier: "moderate", roomTypes: [room("standard", "Standard Room", 4)], convenience: 4, transportNote: "Disney Skyliner hub and buses (included)", taxJurisdictionId: ORANGE }),
    hotel({ id: "coronado-springs", name: "Disney's Coronado Springs Resort", tier: "moderate", roomTypes: [room("standard", "Standard Room", 4), room("gran-destino", "Gran Destino Tower Room", 4, "Tower")], convenience: 3, transportNote: "Disney buses (included)", taxJurisdictionId: ORANGE }),
    hotel({ id: "port-orleans-fq", name: "Disney's Port Orleans Resort – French Quarter", tier: "moderate", roomTypes: [room("standard", "Standard Room", 4)], convenience: 3, transportNote: "Boat to Disney Springs; buses (included)", taxJurisdictionId: ORANGE }),
    hotel({ id: "port-orleans-riverside", name: "Disney's Port Orleans Resort – Riverside", tier: "moderate", roomTypes: [room("standard", "Standard Room", 4)], convenience: 3, transportNote: "Boat to Disney Springs; buses (included)", taxJurisdictionId: ORANGE }),
    // ── Deluxe ──
    hotel({ id: "animal-kingdom-lodge", name: "Disney's Animal Kingdom Lodge", tier: "deluxe", roomTypes: [room("standard", "Standard View Room", 4), room("savanna", "Savanna View Room", 4, "Savanna view")], convenience: 2, transportNote: "Disney buses (included)", taxJurisdictionId: OSCEOLA, taxJurisdictionNote: AK_NOTE }),
    hotel({ id: "beach-club", name: "Disney's Beach Club Resort", tier: "deluxe", roomTypes: [room("standard", "Standard View Room", 5)], convenience: 5, transportNote: "Walk to EPCOT; boat/walk to Hollywood Studios (included)", taxJurisdictionId: ORANGE }),
    hotel({ id: "boardwalk-inn", name: "Disney's BoardWalk Inn", tier: "deluxe", roomTypes: [room("standard", "Standard View Room", 4)], convenience: 5, transportNote: "Walk to EPCOT; boat/walk to Hollywood Studios (included)", taxJurisdictionId: ORANGE }),
    hotel({ id: "contemporary", name: "Disney's Contemporary Resort", tier: "deluxe", roomTypes: [room("standard", "Standard View Room", 5, "Garden Wing"), room("theme-park-view", "Theme Park View Room", 5, "Theme park view")], convenience: 5, transportNote: "Walk/monorail to Magic Kingdom; buses (included)", taxJurisdictionId: ORANGE }),
    hotel({ id: "grand-floridian", name: "Disney's Grand Floridian Resort & Spa", tier: "deluxe", roomTypes: [room("standard", "Resort View Room", 5), room("lagoon-view", "Lagoon View Room", 5, "Lagoon view")], convenience: 5, transportNote: "Monorail/boat to Magic Kingdom (included)", taxJurisdictionId: ORANGE }),
    hotel({ id: "polynesian", name: "Disney's Polynesian Village Resort", tier: "deluxe", roomTypes: [room("standard", "Standard View Room", 5), room("theme-park-view", "Theme Park View Room", 5, "Theme park view")], convenience: 5, transportNote: "Monorail/boat to Magic Kingdom (included)", taxJurisdictionId: ORANGE }),
    hotel({ id: "wilderness-lodge", name: "Disney's Wilderness Lodge", tier: "deluxe", roomTypes: [room("standard", "Standard Room", 4)], convenience: 4, transportNote: "Boat to Magic Kingdom; buses (included)", taxJurisdictionId: ORANGE }),
    hotel({ id: "yacht-club", name: "Disney's Yacht Club Resort", tier: "deluxe", roomTypes: [room("standard", "Standard View Room", 5)], convenience: 5, transportNote: "Walk to EPCOT; boat/walk to Hollywood Studios (included)", taxJurisdictionId: ORANGE }),
    // ── Disney Vacation Club villas (cash or points) ──
    villas({ id: "bay-lake-tower", name: "Bay Lake Tower at Disney's Contemporary Resort", roomTypes: [studio, oneBr, twoBr], convenience: 5, transportNote: "Walk/monorail to Magic Kingdom; buses (included)", taxJurisdictionId: ORANGE }),
    villas({ id: "riviera", name: "Disney's Riviera Resort", roomTypes: [studio, oneBr], convenience: 4, transportNote: "Disney Skyliner and buses (included)", taxJurisdictionId: ORANGE }),
    villas({ id: "saratoga-springs", name: "Disney's Saratoga Springs Resort & Spa", roomTypes: [studio, oneBr, twoBr], convenience: 3, transportNote: "Walk/boat to Disney Springs; buses (included)", taxJurisdictionId: ORANGE }),
    villas({ id: "old-key-west", name: "Disney's Old Key West Resort", roomTypes: [studio, oneBr], convenience: 2, transportNote: "Boat to Disney Springs; buses (included)", taxJurisdictionId: ORANGE }),
    villas({ id: "kidani-village", name: "Disney's Animal Kingdom Villas – Kidani Village", roomTypes: [studio, oneBr, twoBr], convenience: 2, transportNote: "Disney buses (included)", taxJurisdictionId: OSCEOLA, taxJurisdictionNote: AK_NOTE }),
    villas({ id: "beach-club-villas", name: "Disney's Beach Club Villas", roomTypes: [studio, oneBr], convenience: 5, transportNote: "Walk to EPCOT; boat/walk to Hollywood Studios (included)", taxJurisdictionId: ORANGE }),
    villas({ id: "polynesian-villas", name: "Disney's Polynesian Villas & Bungalows", roomTypes: [studio, oneBr], convenience: 5, transportNote: "Monorail/boat to Magic Kingdom (included)", taxJurisdictionId: ORANGE }),
    // ── On Disney property, not Disney-owned (no Disney packages or dining plans) ──
    hotel({ id: "swan", name: "Walt Disney World Swan", tier: "partner", disneyOwned: false, roomTypes: [room("standard", "Standard Room", 4)], convenience: 4, transportNote: "Walk/boat to EPCOT and Hollywood Studios; Disney buses", taxJurisdictionId: ORANGE }),
    hotel({ id: "dolphin", name: "Walt Disney World Dolphin", tier: "partner", disneyOwned: false, roomTypes: [room("standard", "Standard Room", 4)], convenience: 4, transportNote: "Walk/boat to EPCOT and Hollywood Studios; Disney buses", taxJurisdictionId: ORANGE }),
    // ── Off property: generic slots for hotels/rentals you price yourself ──
    hotel({ id: "off-property", name: "Off-property hotel (your choice)", tier: "off_property", disneyOwned: false, roomTypes: [room("standard", "Standard Room", 4)], convenience: 1, transportNote: "Drive or rideshare to the parks", taxJurisdictionId: ORANGE }),
    hotel({ id: "off-property-suite", name: "Off-property suite or vacation rental (your choice)", tier: "off_property", disneyOwned: false, roomTypes: [room("suite", "Suite / condo", 6)], convenience: 1, transportNote: "Drive or rideshare to the parks", taxJurisdictionId: OSCEOLA, taxJurisdictionNote: "Assumes Osceola County, where many vacation rentals near Disney are; a tax-inclusive quote overrides this" }),
    hotel({ id: "disney-springs-area", name: "Disney Springs area hotel (your choice)", tier: "off_property", disneyOwned: false, roomTypes: [room("standard", "Standard Room", 4)], convenience: 2, transportNote: "Hotel shuttle, drive or rideshare to the parks", taxJurisdictionId: ORANGE }),
  ],
};

export const TIER_LABEL: Record<Resort["tier"], string> = {
  value: "Value",
  moderate: "Moderate",
  deluxe: "Deluxe",
  deluxe_villa: "DVC villas",
  partner: "On-site partner",
  off_property: "Off-site",
};

export function findResort(id: string) {
  return CATALOG.resorts.find((r) => r.id === id);
}

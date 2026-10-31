import type { InfoProvenance } from "./types";

/**
 * Park structure for itinerary planning: parks, their areas (lands) on a
 * schematic map, and a starter list of long-running attractions.
 *
 * This is NOT live park information. It contains no operating hours, closures,
 * wait times or crowd levels. Experience durations are approximate ride/show
 * lengths (excluding any wait), and area positions are a rough schematic for
 * estimating walking time. Attractions open, close and get re-themed, so the
 * list may be out of date: users can mark closures and add their own activities.
 */

export const CATALOG_AS_OF = "2026-10-30";

export const CATALOG_PROVENANCE: InfoProvenance = {
  status: "estimated",
  source: "Project park catalog (approximate; may be out of date — verify before your trip)",
  observedAt: CATALOG_AS_OF,
};

export type AttractionCategory = "thrill" | "family" | "dark_ride" | "water" | "show" | "walkthrough";

export interface Area {
  id: string;
  name: string;
  /** Schematic position in "walking minutes" from the park entrance (0,0). Estimated. */
  x: number;
  y: number;
}

export interface Park {
  id: string;
  name: string;
  short: string;
  areas: Area[];
}

export interface Attraction {
  id: string;
  parkId: string;
  areaId: string;
  name: string;
  category: AttractionCategory;
  /** 1 = gentle, 2 = moderate, 3 = intense. Used for pacing ("demanding day"), not safety advice. */
  intensity: 1 | 2 | 3;
  /** Approximate experience length in minutes, excluding any wait. */
  durationMin: number;
}

export const PARKS: Park[] = [
  {
    id: "magic-kingdom",
    name: "Magic Kingdom",
    short: "MK",
    areas: [
      { id: "mk-main-street", name: "Main Street, U.S.A.", x: 0, y: 3 },
      { id: "mk-adventureland", name: "Adventureland", x: -6, y: 9 },
      { id: "mk-frontierland", name: "Frontierland", x: -10, y: 13 },
      { id: "mk-liberty-square", name: "Liberty Square", x: -4, y: 13 },
      { id: "mk-fantasyland", name: "Fantasyland", x: 1, y: 17 },
      { id: "mk-tomorrowland", name: "Tomorrowland", x: 7, y: 10 },
    ],
  },
  {
    id: "epcot",
    name: "EPCOT",
    short: "EP",
    areas: [
      { id: "ep-celebration", name: "World Celebration", x: 0, y: 4 },
      { id: "ep-discovery", name: "World Discovery", x: 8, y: 8 },
      { id: "ep-nature", name: "World Nature", x: -8, y: 8 },
      { id: "ep-showcase-west", name: "World Showcase (Mexico–Norway side)", x: -7, y: 18 },
      { id: "ep-showcase-east", name: "World Showcase (France–UK side)", x: 7, y: 20 },
    ],
  },
  {
    id: "hollywood-studios",
    name: "Hollywood Studios",
    short: "HS",
    areas: [
      { id: "hs-hollywood-blvd", name: "Hollywood Boulevard", x: 0, y: 4 },
      { id: "hs-echo-lake", name: "Echo Lake", x: -5, y: 7 },
      { id: "hs-sunset-blvd", name: "Sunset Boulevard", x: 5, y: 7 },
      { id: "hs-toy-story-land", name: "Toy Story Land", x: 4, y: 15 },
      { id: "hs-galaxys-edge", name: "Star Wars: Galaxy's Edge", x: -6, y: 16 },
    ],
  },
  {
    id: "animal-kingdom",
    name: "Animal Kingdom",
    short: "AK",
    areas: [
      { id: "ak-discovery-island", name: "Discovery Island", x: 0, y: 7 },
      { id: "ak-pandora", name: "Pandora – The World of Avatar", x: -8, y: 11 },
      { id: "ak-africa", name: "Africa", x: -3, y: 15 },
      { id: "ak-asia", name: "Asia", x: 6, y: 13 },
    ],
  },
];

const a = (parkId: string, areaId: string, id: string, name: string, category: AttractionCategory, intensity: 1 | 2 | 3, durationMin: number): Attraction => ({
  id,
  parkId,
  areaId,
  name,
  category,
  intensity,
  durationMin,
});

export const ATTRACTIONS: Attraction[] = [
  // Magic Kingdom
  a("magic-kingdom", "mk-fantasyland", "mk-seven-dwarfs", "Seven Dwarfs Mine Train", "thrill", 2, 3),
  a("magic-kingdom", "mk-fantasyland", "mk-peter-pan", "Peter Pan's Flight", "dark_ride", 1, 3),
  a("magic-kingdom", "mk-fantasyland", "mk-small-world", "\"it's a small world\"", "dark_ride", 1, 11),
  a("magic-kingdom", "mk-fantasyland", "mk-pooh", "The Many Adventures of Winnie the Pooh", "dark_ride", 1, 4),
  a("magic-kingdom", "mk-fantasyland", "mk-philharmagic", "Mickey's PhilharMagic", "show", 1, 12),
  a("magic-kingdom", "mk-liberty-square", "mk-haunted-mansion", "Haunted Mansion", "dark_ride", 1, 9),
  a("magic-kingdom", "mk-adventureland", "mk-pirates", "Pirates of the Caribbean", "dark_ride", 1, 9),
  a("magic-kingdom", "mk-adventureland", "mk-jungle-cruise", "Jungle Cruise", "family", 1, 10),
  a("magic-kingdom", "mk-frontierland", "mk-tianas", "Tiana's Bayou Adventure", "water", 2, 10),
  a("magic-kingdom", "mk-frontierland", "mk-big-thunder", "Big Thunder Mountain Railroad", "thrill", 2, 4),
  a("magic-kingdom", "mk-tomorrowland", "mk-space-mountain", "Space Mountain", "thrill", 3, 3),
  a("magic-kingdom", "mk-tomorrowland", "mk-tron", "TRON Lightcycle / Run", "thrill", 3, 2),
  a("magic-kingdom", "mk-tomorrowland", "mk-buzz", "Buzz Lightyear's Space Ranger Spin", "dark_ride", 1, 5),
  // EPCOT
  a("epcot", "ep-celebration", "ep-spaceship-earth", "Spaceship Earth", "dark_ride", 1, 16),
  a("epcot", "ep-discovery", "ep-cosmic-rewind", "Guardians of the Galaxy: Cosmic Rewind", "thrill", 3, 4),
  a("epcot", "ep-discovery", "ep-test-track", "Test Track", "thrill", 2, 5),
  a("epcot", "ep-discovery", "ep-mission-space", "Mission: SPACE", "thrill", 2, 6),
  a("epcot", "ep-nature", "ep-soarin", "Soarin'", "family", 2, 6),
  a("epcot", "ep-nature", "ep-living-land", "Living with the Land", "family", 1, 14),
  a("epcot", "ep-nature", "ep-seas", "The Seas with Nemo & Friends", "dark_ride", 1, 5),
  a("epcot", "ep-nature", "ep-journey-water", "Journey of Water", "walkthrough", 1, 15),
  a("epcot", "ep-showcase-west", "ep-frozen", "Frozen Ever After", "family", 1, 5),
  a("epcot", "ep-showcase-west", "ep-gran-fiesta", "Gran Fiesta Tour", "dark_ride", 1, 8),
  a("epcot", "ep-showcase-east", "ep-remy", "Remy's Ratatouille Adventure", "dark_ride", 1, 5),
  // Hollywood Studios
  a("hollywood-studios", "hs-galaxys-edge", "hs-rise", "Star Wars: Rise of the Resistance", "dark_ride", 2, 18),
  a("hollywood-studios", "hs-galaxys-edge", "hs-smugglers", "Millennium Falcon: Smugglers Run", "family", 2, 5),
  a("hollywood-studios", "hs-toy-story-land", "hs-slinky", "Slinky Dog Dash", "thrill", 2, 3),
  a("hollywood-studios", "hs-toy-story-land", "hs-toy-story-mania", "Toy Story Mania!", "dark_ride", 1, 7),
  a("hollywood-studios", "hs-toy-story-land", "hs-alien-saucers", "Alien Swirling Saucers", "family", 1, 2),
  a("hollywood-studios", "hs-hollywood-blvd", "hs-runaway-railway", "Mickey & Minnie's Runaway Railway", "dark_ride", 1, 5),
  a("hollywood-studios", "hs-sunset-blvd", "hs-tower", "The Twilight Zone Tower of Terror", "thrill", 3, 4),
  a("hollywood-studios", "hs-sunset-blvd", "hs-beauty-beast", "Beauty and the Beast – Live on Stage", "show", 1, 25),
  a("hollywood-studios", "hs-echo-lake", "hs-star-tours", "Star Tours – The Adventures Continue", "family", 2, 7),
  // Animal Kingdom
  a("animal-kingdom", "ak-pandora", "ak-flight-of-passage", "Avatar Flight of Passage", "thrill", 2, 6),
  a("animal-kingdom", "ak-pandora", "ak-navi-river", "Na'vi River Journey", "family", 1, 5),
  a("animal-kingdom", "ak-africa", "ak-safaris", "Kilimanjaro Safaris", "family", 1, 20),
  a("animal-kingdom", "ak-africa", "ak-gorilla-falls", "Gorilla Falls Exploration Trail", "walkthrough", 1, 30),
  a("animal-kingdom", "ak-africa", "ak-lion-king", "Festival of the Lion King", "show", 1, 30),
  a("animal-kingdom", "ak-asia", "ak-everest", "Expedition Everest", "thrill", 3, 4),
  a("animal-kingdom", "ak-asia", "ak-kali", "Kali River Rapids", "water", 2, 5),
  a("animal-kingdom", "ak-asia", "ak-maharajah", "Maharajah Jungle Trek", "walkthrough", 1, 25),
  a("animal-kingdom", "ak-asia", "ak-feathered-friends", "Feathered Friends in Flight!", "show", 1, 25),
];

export const parkById = new Map(PARKS.map((p) => [p.id, p]));
export const attractionById = new Map(ATTRACTIONS.map((x) => [x.id, x]));

export function areaOf(parkId: string, areaId: string): Area | undefined {
  return parkById.get(parkId)?.areas.find((x) => x.id === areaId);
}

export const CATEGORY_LABEL: Record<AttractionCategory, string> = {
  thrill: "Thrill ride",
  family: "Family ride",
  dark_ride: "Dark ride",
  water: "Water ride",
  show: "Show",
  walkthrough: "Walk-through / trail",
};

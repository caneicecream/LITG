import type { InfoProvenance } from "./types";

/**
 * Park structure for itinerary planning: parks, their areas (lands) on a
 * schematic map, and a curated list of long-running attractions and shows.
 *
 * This is NOT live park information: no operating hours, show times, closures,
 * wait times or crowd levels. What each field is based on:
 *
 *   - Existence, park and land: the project's catalog, spot-checked on
 *     2026-10-31 against third-party guides found by web search (secondary
 *     sources; Disney's own pages were not fetched). Attractions reported as
 *     closing or being replaced in 2026 are left out; reported changes for the
 *     ones kept are listed as dated advisories, never as confirmed closures.
 *   - Experience durations: ESTIMATES (approximate ride/show length, excluding
 *     any wait). Not sourced.
 *   - Area positions: a rough schematic for walking estimates. Not a map.
 *   - Minimum heights: only where several third-party guides agreed (status
 *     "reported", verify with Disney). Unknown otherwise; never assumed none.
 *   - Schedule type: "continuous" (operates through the day), "showtimes"
 *     (scheduled performances: times must come from you), "spectacular"
 *     (evening shows and parades: only planned when you enter a time).
 *
 * Anything here can be corrected through manual entry: closures, show and
 * attraction times, and your own activities.
 */

export const CATALOG_AS_OF = "2026-10-31";

export const CATALOG_PROVENANCE: InfoProvenance = {
  status: "estimated",
  source: "Project park catalog (curated; secondary sources checked 2026-10-31; durations and walking distances are estimates)",
  observedAt: CATALOG_AS_OF,
};

/** Third-party guides found by web search on the check date (secondary; verify). */
export const SECONDARY_SOURCE = "Third-party Disney guides via web search";

export type AttractionCategory = "thrill" | "family" | "dark_ride" | "water" | "show" | "walkthrough" | "spectacular" | "transport";
export type AttractionKind = "ride" | "show" | "walkthrough" | "experience";
export type ScheduleType = "continuous" | "showtimes" | "spectacular";

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

/** A dated, sourced report about an attraction (refurbishment, re-theme). Advisory only: never applied as a closure. */
export interface Advisory {
  text: string;
  /** Reported affected period, if any (YYYY-MM-DD). */
  from?: string;
  to?: string;
  source: string;
  checkedAt: string;
  /** "single" = one source; "conflicting" = sources disagree. */
  confidence: "single" | "several" | "conflicting";
}

export interface Attraction {
  id: string;
  parkId: string;
  areaId: string;
  name: string;
  kind: AttractionKind;
  category: AttractionCategory;
  /** 1 = gentle, 2 = moderate, 3 = intense. Used for pacing ("demanding day"), not safety advice. */
  intensity: 1 | 2 | 3;
  /** Approximate experience length in minutes, excluding any wait. ESTIMATE. */
  durationMin: number;
  schedule: ScheduleType;
  /** Reported minimum height in inches (secondary sources; verify). Undefined = unknown, not "none". */
  minHeightIn?: number;
  advisories?: Advisory[];
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
      { id: "ep-showcase-west", name: "World Showcase (Mexico–China–Norway side)", x: -7, y: 18 },
      { id: "ep-showcase-center", name: "World Showcase (Germany–American Adventure–Japan)", x: 0, y: 25 },
      { id: "ep-showcase-east", name: "World Showcase (Morocco–France–UK–Canada side)", x: 7, y: 20 },
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

const CHECKED = "2026-10-31";

type Extra = Partial<Pick<Attraction, "minHeightIn" | "advisories" | "schedule">>;
function a(parkId: string, areaId: string, id: string, name: string, kind: AttractionKind, category: AttractionCategory, intensity: 1 | 2 | 3, durationMin: number, extra: Extra = {}): Attraction {
  const schedule: ScheduleType = extra.schedule ?? (category === "spectacular" ? "spectacular" : kind === "show" ? "showtimes" : "continuous");
  return { id, parkId, areaId, name, kind, category, intensity, durationMin, schedule, ...(extra.minHeightIn ? { minHeightIn: extra.minHeightIn } : {}), ...(extra.advisories ? { advisories: extra.advisories } : {}) };
}
const h = (inches: number): Extra => ({ minHeightIn: inches });

export const ATTRACTIONS: Attraction[] = [
  // ── Magic Kingdom ──
  a("magic-kingdom", "mk-main-street", "mk-railroad", "Walt Disney World Railroad", "ride", "transport", 1, 20),
  a("magic-kingdom", "mk-fantasyland", "mk-seven-dwarfs", "Seven Dwarfs Mine Train", "ride", "thrill", 2, 3, h(38)),
  a("magic-kingdom", "mk-fantasyland", "mk-peter-pan", "Peter Pan's Flight", "ride", "dark_ride", 1, 3),
  a("magic-kingdom", "mk-fantasyland", "mk-small-world", "\"it's a small world\"", "ride", "dark_ride", 1, 11),
  a("magic-kingdom", "mk-fantasyland", "mk-pooh", "The Many Adventures of Winnie the Pooh", "ride", "dark_ride", 1, 4),
  a("magic-kingdom", "mk-fantasyland", "mk-little-mermaid", "Under the Sea – Journey of The Little Mermaid", "ride", "dark_ride", 1, 6),
  a("magic-kingdom", "mk-fantasyland", "mk-dumbo", "Dumbo the Flying Elephant", "ride", "family", 1, 2),
  a("magic-kingdom", "mk-fantasyland", "mk-barnstormer", "The Barnstormer", "ride", "thrill", 2, 1, h(35)),
  a("magic-kingdom", "mk-fantasyland", "mk-carrousel", "Prince Charming Regal Carrousel", "ride", "family", 1, 2),
  a("magic-kingdom", "mk-fantasyland", "mk-tea-party", "Mad Tea Party", "ride", "family", 1, 2),
  a("magic-kingdom", "mk-fantasyland", "mk-philharmagic", "Mickey's PhilharMagic", "show", "show", 1, 12, { schedule: "continuous" }),
  a("magic-kingdom", "mk-liberty-square", "mk-haunted-mansion", "Haunted Mansion", "ride", "dark_ride", 1, 9),
  a("magic-kingdom", "mk-liberty-square", "mk-hall-presidents", "The Hall of Presidents", "show", "show", 1, 25, { schedule: "continuous" }),
  a("magic-kingdom", "mk-adventureland", "mk-pirates", "Pirates of the Caribbean", "ride", "dark_ride", 1, 9),
  a("magic-kingdom", "mk-adventureland", "mk-jungle-cruise", "Jungle Cruise", "ride", "family", 1, 10),
  a("magic-kingdom", "mk-adventureland", "mk-aladdin", "The Magic Carpets of Aladdin", "ride", "family", 1, 2),
  a("magic-kingdom", "mk-adventureland", "mk-swiss-family", "Swiss Family Treehouse", "walkthrough", "walkthrough", 1, 15),
  a("magic-kingdom", "mk-adventureland", "mk-tiki-room", "Walt Disney's Enchanted Tiki Room", "show", "show", 1, 12, { schedule: "continuous" }),
  a("magic-kingdom", "mk-frontierland", "mk-tianas", "Tiana's Bayou Adventure", "ride", "water", 2, 10, {
    ...h(40),
    advisories: [{ text: "Reported refurbishment closure starting Nov 2, 2026 (end date not reported)", from: "2026-11-02", source: SECONDARY_SOURCE, checkedAt: CHECKED, confidence: "single" }],
  }),
  a("magic-kingdom", "mk-frontierland", "mk-big-thunder", "Big Thunder Mountain Railroad", "ride", "thrill", 2, 4),
  a("magic-kingdom", "mk-frontierland", "mk-country-bears", "Country Bear Musical Jamboree", "show", "show", 1, 16, { schedule: "continuous" }),
  a("magic-kingdom", "mk-tomorrowland", "mk-space-mountain", "Space Mountain", "ride", "thrill", 3, 3, h(44)),
  a("magic-kingdom", "mk-tomorrowland", "mk-tron", "TRON Lightcycle / Run", "ride", "thrill", 3, 2, h(48)),
  a("magic-kingdom", "mk-tomorrowland", "mk-buzz", "Buzz Lightyear's Space Ranger Spin", "ride", "dark_ride", 1, 5),
  a("magic-kingdom", "mk-tomorrowland", "mk-peoplemover", "Tomorrowland Transit Authority PeopleMover", "ride", "family", 1, 10),
  a("magic-kingdom", "mk-tomorrowland", "mk-astro-orbiter", "Astro Orbiter", "ride", "family", 1, 2),
  a("magic-kingdom", "mk-tomorrowland", "mk-speedway", "Tomorrowland Speedway", "ride", "family", 1, 5, h(32)),
  a("magic-kingdom", "mk-tomorrowland", "mk-laugh-floor", "Monsters, Inc. Laugh Floor", "show", "show", 1, 15, { schedule: "continuous" }),
  a("magic-kingdom", "mk-main-street", "mk-fireworks", "Evening fireworks spectacular", "show", "spectacular", 1, 20),
  a("magic-kingdom", "mk-frontierland", "mk-parade", "Afternoon parade", "show", "spectacular", 1, 15),
  // ── EPCOT ──
  a("epcot", "ep-celebration", "ep-spaceship-earth", "Spaceship Earth", "ride", "dark_ride", 1, 16),
  a("epcot", "ep-discovery", "ep-cosmic-rewind", "Guardians of the Galaxy: Cosmic Rewind", "ride", "thrill", 3, 4, h(42)),
  a("epcot", "ep-discovery", "ep-test-track", "Test Track", "ride", "thrill", 2, 5),
  a("epcot", "ep-discovery", "ep-mission-space", "Mission: SPACE", "ride", "thrill", 2, 6),
  a("epcot", "ep-nature", "ep-soarin", "Soarin'", "ride", "family", 2, 6, h(40)),
  a("epcot", "ep-nature", "ep-living-land", "Living with the Land", "ride", "family", 1, 14),
  a("epcot", "ep-nature", "ep-seas", "The Seas with Nemo & Friends", "ride", "dark_ride", 1, 5),
  a("epcot", "ep-nature", "ep-journey-water", "Journey of Water", "walkthrough", "walkthrough", 1, 15),
  a("epcot", "ep-nature", "ep-figment", "Journey Into Imagination with Figment", "ride", "dark_ride", 1, 6),
  a("epcot", "ep-showcase-west", "ep-frozen", "Frozen Ever After", "ride", "family", 1, 5),
  a("epcot", "ep-showcase-west", "ep-gran-fiesta", "Gran Fiesta Tour", "ride", "dark_ride", 1, 8),
  a("epcot", "ep-showcase-west", "ep-china-film", "Reflections of China", "show", "show", 1, 14, { schedule: "continuous" }),
  a("epcot", "ep-showcase-center", "ep-american-adventure", "The American Adventure", "show", "show", 1, 30),
  a("epcot", "ep-showcase-east", "ep-remy", "Remy's Ratatouille Adventure", "ride", "dark_ride", 1, 5),
  a("epcot", "ep-showcase-east", "ep-canada-film", "Canada Far and Wide", "show", "show", 1, 14, { schedule: "continuous" }),
  a("epcot", "ep-showcase-center", "ep-nighttime", "Evening spectacular on World Showcase Lagoon", "show", "spectacular", 1, 20),
  // ── Hollywood Studios ──
  a("hollywood-studios", "hs-galaxys-edge", "hs-rise", "Star Wars: Rise of the Resistance", "ride", "dark_ride", 2, 18, h(40)),
  a("hollywood-studios", "hs-galaxys-edge", "hs-smugglers", "Millennium Falcon: Smugglers Run", "ride", "family", 2, 5, h(38)),
  a("hollywood-studios", "hs-toy-story-land", "hs-slinky", "Slinky Dog Dash", "ride", "thrill", 2, 3, h(38)),
  a("hollywood-studios", "hs-toy-story-land", "hs-toy-story-mania", "Toy Story Mania!", "ride", "dark_ride", 1, 7),
  a("hollywood-studios", "hs-toy-story-land", "hs-alien-saucers", "Alien Swirling Saucers", "ride", "family", 1, 2, h(32)),
  a("hollywood-studios", "hs-hollywood-blvd", "hs-runaway-railway", "Mickey & Minnie's Runaway Railway", "ride", "dark_ride", 1, 5),
  a("hollywood-studios", "hs-sunset-blvd", "hs-tower", "The Twilight Zone Tower of Terror", "ride", "thrill", 3, 4, h(40)),
  a("hollywood-studios", "hs-sunset-blvd", "hs-rock-coaster", "Rock 'n' Roller Coaster (re-themed)", "ride", "thrill", 3, 2, {
    ...h(48),
    advisories: [{ text: "Reported closed in March 2026 for a re-theme and reported reopened in mid-2026; sources differ on details — confirm it is operating", source: SECONDARY_SOURCE, checkedAt: CHECKED, confidence: "conflicting" }],
  }),
  a("hollywood-studios", "hs-sunset-blvd", "hs-beauty-beast", "Beauty and the Beast – Live on Stage", "show", "show", 1, 25),
  a("hollywood-studios", "hs-echo-lake", "hs-star-tours", "Star Tours – The Adventures Continue", "ride", "family", 2, 7, h(40)),
  a("hollywood-studios", "hs-echo-lake", "hs-fantasmic", "Fantasmic! (evening show)", "show", "spectacular", 1, 30),
  // ── Animal Kingdom ──
  a("animal-kingdom", "ak-pandora", "ak-flight-of-passage", "Avatar Flight of Passage", "ride", "thrill", 2, 6, h(44)),
  a("animal-kingdom", "ak-pandora", "ak-navi-river", "Na'vi River Journey", "ride", "family", 1, 5),
  a("animal-kingdom", "ak-africa", "ak-safaris", "Kilimanjaro Safaris", "ride", "family", 1, 20),
  a("animal-kingdom", "ak-africa", "ak-gorilla-falls", "Gorilla Falls Exploration Trail", "walkthrough", "walkthrough", 1, 30),
  a("animal-kingdom", "ak-africa", "ak-lion-king", "Festival of the Lion King", "show", "show", 1, 30),
  a("animal-kingdom", "ak-asia", "ak-everest", "Expedition Everest", "ride", "thrill", 3, 4, h(44)),
  a("animal-kingdom", "ak-asia", "ak-kali", "Kali River Rapids", "ride", "water", 2, 5, h(38)),
  a("animal-kingdom", "ak-asia", "ak-maharajah", "Maharajah Jungle Trek", "walkthrough", "walkthrough", 1, 25),
  a("animal-kingdom", "ak-asia", "ak-feathered-friends", "Feathered Friends in Flight!", "show", "show", 1, 25),
  a("animal-kingdom", "ak-discovery-island", "ak-zootopia", "Zootopia: Better Zoogether!", "show", "show", 1, 10, {
    schedule: "continuous",
    advisories: [{ text: "Reported to have debuted in November 2025 in the Tree of Life theater; confirm it is running", source: SECONDARY_SOURCE, checkedAt: CHECKED, confidence: "single" }],
  }),
  a("animal-kingdom", "ak-discovery-island", "ak-discovery-trails", "Discovery Island Trails (Tree of Life)", "walkthrough", "walkthrough", 1, 20),
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
  spectacular: "Evening show / parade",
  transport: "Train / transport ride",
};

export const SCHEDULE_LABEL: Record<ScheduleType, string> = {
  continuous: "Runs through the day",
  showtimes: "Scheduled performances: check times",
  spectacular: "Set showtime: enter it to plan",
};

/** Advisories whose reported period overlaps the trip (or that have no dates). */
export function advisoriesFor(a: Attraction, from: string, to: string): Advisory[] {
  return (a.advisories ?? []).filter((x) => (!x.from || x.from <= to) && (!x.to || x.to >= from));
}

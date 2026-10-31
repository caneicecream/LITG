# Data sources

Status of every source investigated. "Verified" means checked first-hand. Third-party claims are labelled as such. Update this file rather than repeating research.

## In use

| Source | Used for | Basis |
| --- | --- | --- |
| The user | Quotes, rates, ticket prices and rules, promotions, park hours (form or paste from the official calendar), show times, reservations, Lightning Lane windows, closures, wait and crowd estimates | Stored with source, date and status (`manual` / `estimated`); never labelled verified |
| Project reference data (`src/data/reference.ts`) | Tax rates, transport/parking estimates | `estimated`, documented basis |
| Illustrative dataset and demo scenario | Demonstration only | `illustrative`; never mixed with real prices |
| Attraction catalog (`src/itinerary/catalog.ts`) | Attraction list, lands, kinds, schedule types | Curated; spot-checked 2026-10-31 against third-party guides via web search. Durations and walking are estimates; heights are "reported, verify". |

## Investigated, not integrated

| Source | What it offers (per research) | Terms / licensing | Status | Checked |
| --- | --- | --- | --- | --- |
| **Disney websites and apps** | Prices, hours, waits, availability | Site terms prohibit automated access | **Not used**: no scraping, no private endpoints | M0, 2026-10-30 |
| **Queue-Times.com API** (`/parks.json`, `/parks/{id}/queue_times.json`) | Live posted waits and open/closed status, refreshed about every 5 min; no API key; no historical API | Free use requires a prominent "Powered by Queue-Times.com" link (per third-party descriptions; the official page `queue-times.com/pages/api` was not read) | Host blocked by this session's network policy (proxy 403). Only useful for an in-park "today" view; live waits must not be presented as forecasts | 2026-10-31 |
| **ThemeParks.wiki API v1** (`api.themeparks.wiki/v1`) | Live waits, entity metadata, and park schedules (hours, including upcoming dates) per third-party listings; no key; rate-limited (an SDK handles HTTP 429) | Official terms and rate limits not verified. The data reportedly originates from park operators' own apps, so its permission to redistribute Disney data is an open question | Host blocked by network policy. The most valuable candidate (future park hours) if terms are acceptable | 2026-10-31 |
| **RideSpy** | The user finds it useful | Nothing found: no documented API or data source in search results | Unresolved: ask the developer whether a permitted integration exists | 2026-10-31 |
| Thrill-Data, TouringPlans | Wait history and crowd forecasts (reportedly built from Disney app data and crowdsourcing) | Commercial or proprietary; not evaluated in depth | Not pursued | 2026-10-31 |
| Wikipedia attraction lists | Attraction membership, opening years | CC BY-SA | Host blocked by network policy | 2026-10-31 |
| Travel-trade wholesale (e.g. Hotelbeds), licensed historical pricing | Hotel/package pricing | Require B2B agreements | Not feasible for a personal tool | M0 |

## Open questions

1. May the session's network allow `api.themeparks.wiki` and `queue-times.com`? (Environment settings → Network access.)
2. Does ThemeParks.wiki permit this use (terms, attribution, rate limits), and is the user comfortable with data that originates from Disney's apps?
3. What is RideSpy's data source, and does it offer a permitted integration? This needs contact with its developer.

## Integration rules (when a source is approved)

Implement it through `ParkInfoSource` (`src/itinerary/sources.ts`) or `ObservationAdapter` (`src/monitoring/adapters.ts`). Validate with the existing schemas, store provenance (source name, retrieval time, status), cache and respect rate limits, show the required attribution, keep manual entry as the fallback, and never present a live reading as a future forecast.

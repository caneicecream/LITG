# Architecture and design decisions

## Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| **Domain** (pricing + optimization) | `src/domain/` | Pure TypeScript with no I/O or framework imports. Calculates costs, checks promotion eligibility and hard constraints, enumerates and ranks configurations, computes savings. Fully deterministic, so the same inputs always give the same output. |
| **Data** | `src/data/` | Catalog (structure), reference estimates, the illustrative dataset, the user's local store, and a `PriceSource` registry that assembles `PriceData` for the optimizer. |
| **App** | `src/app/`, `src/components/` | Next.js pages and API routes. The UI only collects a `TripRequest` and renders an `OptimizationResult`; it does no pricing of its own. |
| **AI** (future) | n/a | Will translate natural language into a `TripRequest` (validated by `src/domain/schema.ts`), call the same optimizer, and explain its structured result. It must never compute prices itself. |

### Why this stack

- **Next.js + TypeScript** in a single app: one language end to end, runs locally with `npm run dev`, and leaves a straightforward path to deployment later. No microservices.
- **Optimizer in TypeScript, not Python:** the problem is enumeration plus integer arithmetic, not numerical computing. Sharing types between the engine, the API and the UI removes a whole class of bugs. A typical run evaluates about 8,000 configurations in about 0.3s.
- **JSON-file store, not Postgres (yet):** it needs zero setup for a personal demo. All persistence goes through `src/data/store.ts`, so moving to Postgres/Supabase (for monitoring and history) replaces one module.
- **Zod** validates every input at the boundary: trip requests and user price entries.

## Data integrity model

Every price-bearing object has a `Provenance { status, source, sourceUrl?, observedAt, notes? }`.

| Status | Meaning | Who can create it |
| --- | --- | --- |
| `verified` | Reliable source with evidence it applies | Reserved for vetted automated adapters (none connected yet) |
| `manual` | Copied by the user from a real quote/page | User |
| `estimated` | Documented estimate or assumption | User, reference data |
| `illustrative` | Demo data, never a real offer | Bundled dataset only |
| `stale` | *Derived:* a `verified`/`manual` observation older than the user's threshold (default 14 days) | Computed |
| `unavailable` | *Derived:* no price could be found | Computed |

Rules enforced in code (and tested):

1. **Source resolution** (`pricing/resolve.ts`): for each item (room night, ticket, dining night, tax rate, transport), pick the best effective status (`verified > manual > stale > estimated > illustrative`). Ties go to the newest observation, then to id for reproducibility. Ticket sales channels compete on trust first, then price. Third-party tickets are never used inside a Disney package.
2. **No silent gaps:** a missing component becomes an `unavailable` cost line with an explanation. The total is then a lower bound, and the configuration is marked incomplete.
3. **Incomplete never outranks complete:** only complete, within-hard-limit configurations are *comparable*.
4. **Illustrative never competes with real:** if any comparable option is free of illustrative data, every option containing illustrative data is set aside. A single illustrative component (for example a demo promotion on a real room rate) taints the whole configuration. When only illustrative options exist, the run is in **demo mode** and every surface says so.
5. **Awards need a comparison:** "Cheapest" and "Best value" require at least two comparable options. "Best alternative" requires a fully priced baseline in the same trust class and a like-for-like saving.
6. **Savings are only claimed against a meaningful baseline:** the user's preferred plan is priced by the same engine. Savings are computed only when both sides are complete and in the same trust class. They are labelled *not like-for-like* when nights, tickets or dining differ, with per-night deltas alongside.
7. **No double counting:** a package quote replaces the room, ticket and included dining lines, which are shown as "Included" at $0. Quotes are tax-inclusive, so no estimated tax is added, and promotions are never stacked on a quote.

## Cost calculation (`pricing/calculate.ts`)

For one configuration (arrival, nights, resort/room, ticket type, booking method, dining choice):

| Line | Rule |
| --- | --- |
| Package quote | Exact match on resort, room, check-in, nights, adults, children, ticket type and days, and dining. Total used as entered. |
| Room | Sum of per-night resolved rates (weekday-specific rates supported), or a room-only quote. |
| Promotion | Best single eligible offer (see below). Percent and per-night discounts apply per night. Package discounts are fixed. |
| Room taxes | Lodging rate × (room − per-night discounts) for nights whose rate excludes tax. |
| Tickets | Adults (10+) and children (3–9) priced at the resolved price for the start date (arrival, or arrival + 1 unless "park on arrival day"). Children under 3 are free. |
| Ticket tax | Sales rate on tickets whose price excludes tax. |
| Dining | Plan: per person per night (+ tax if excluded). Pay-as-you-go: the user's per-person-per-night estimate. |
| Transport | Per resort: no car → per-park-day cost (Disney resorts $0). Car → overnight parking × nights + park parking × park days. |
| Rental car | User's daily rate × nights. |
| Other | User expenses per trip, night, person or person-night. |

Money is integer cents. Percentages round half-up to the cent once per line.

### Promotions (`pricing/promotions.ts`)

Structured rules: discount (room % / room $ per night / package $), a travel window with a rule (`all_nights`, `arrival_date`, `per_night`), a booking window, eligible resorts and rooms, min/max nights, minimum ticket days, package-only, party size, audience (Florida resident, passholder, military) and blackout nights.

- Every checkable condition must pass → **eligible**, applied.
- An audience condition answered "Not sure" → **uncertain**: shown as a possible saving and never added to a total.
- Offers are assumed **not to combine**. The single largest eligible saving is applied.

## Optimization (`optimizer/`)

1. **Enumerate** arrival dates × stay lengths in the window × resorts/rooms × allowed ticket types × dining choices × booking methods. Structurally impossible combinations are never generated: dining plans need a package, and packages need tickets and a Disney resort.
2. **Hard constraints** (`constraints.ts`): date window, nights range, allowed resorts, Disney-only, room occupancy, required park days fitting the stay, accepted ticket types, dining policy, and package rules. Infeasible configurations are counted by reason and shown to the user.
3. **Price** each feasible configuration.
4. **Collapse** package vs. separate for otherwise identical trips, within the same trust class. The cheaper method wins (ties → separate, which is more flexible), and the other method's total is kept for display.
5. **Partition** into comparable, illustrative-set-aside, incomplete and over-hard-limit groups.
6. **Score** best value: a weighted mean of explicit 0–100 sub-scores. Price is min–max normalized within the comparable set. Resort is 100 if preferred, 60 if the same tier as a preferred resort, 25 otherwise. Convenience is the editorial 1–5 rating. Ticket is 100 if it matches the preference, 50 otherwise. Dining is 100/40 when a plan is preferred. Dates lose 10 per day of arrival shift and 15 per night of length change. The score is relative to one run, so it is not an absolute measure of value.
7. **Rank** deterministically. Cost: total → better data status → closer to preferred dates → earlier arrival → id. Value: score → cost order.
8. **Awards, savings, date calendar, notices.**

## Extending

- **New data source:** implement `PriceSource` in `src/data/sources.ts` (e.g. an authorized partner feed) and tag its output with honest provenance. The resolver handles precedence. Nothing in the optimizer changes.
- **New resort or room:** add it to `src/data/catalog.ts`, and to the illustrative generator if demo coverage is wanted.
- **AI assistant:** produce a `TripRequest` (schema already strict), call `optimize()`, and explain `awards[].explanation`, `lines[].calculation` and `assumptions`. Those are the facts the assistant may state.
- **Monitoring:** saved trips already store run snapshots. Next steps are a scheduled job that re-runs saved requests, a table of price observations, and change detection with switching costs.

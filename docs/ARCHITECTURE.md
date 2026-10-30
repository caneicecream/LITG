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
7. **No double counting:** a package quote replaces the room, ticket and included dining lines, which are shown as "Included" at $0. Promotions are never stacked on a quote. Quote taxes follow explicit rules (below), and a tax-inclusive quote never gets estimated tax added.
8. **History is never overwritten:** re-checking an entry appends its previous observation (date, value, source, status) to `history`, which is owned by the server and never accepted from clients.

## Cost calculation (`pricing/calculate.ts`)

For one configuration (arrival, nights, resort/room, ticket type, booking method, dining choice):

| Line | Rule |
| --- | --- |
| Package quote | Exact match on resort, room, check-in, nights, adults, children, ticket type and days, and dining. Total used as entered. |
| Room | Sum of per-night resolved rates (weekday-specific rates supported), or a room-only quote. |
| Villa (DVC points) | Points per night from point charts × the chosen cost per point (+ provider fee), or a matching point-rental quote. No lodging tax (documented assumption). |
| Quote taxes | Tax-inclusive → none added. Pre-tax with a quoted tax amount → that amount (manual). Pre-tax room-only → estimated at the resort's lodging rate. Pre-tax package without an amount → **unavailable** (taxes can't be split between room and tickets), so the option is incomplete. |
| Promotion | Best single eligible offer (see below). Percent and per-night discounts apply per night. Package discounts are fixed. |
| Room taxes | The resort jurisdiction's lodging rate × (room − per-night discounts) for nights whose rate excludes tax. |
| Tickets | Adults (10+) and children (3–9) priced at the resolved price for the start date (arrival, or arrival + 1 unless "park on arrival day"). Children under 3 are free. |
| Ticket tax | Sales rate of the catalog's `ticketTaxJurisdictionId` (Orange County, where the parks are) on tickets whose price excludes tax. |
| Dining | Plan: per person per night (+ the resort jurisdiction's sales tax if excluded). Pay-as-you-go: the user's per-person-per-night estimate. |
| Transport | Per resort: no car → per-park-day cost (Disney resorts $0). Car → overnight parking × nights + park parking × park days. |
| Rental car | User's daily rate × nights. |
| Other | User expenses per trip, night, person or person-night. |

Money is integer cents. Percentages round half-up to the cent once per line.

### Promotions (`pricing/promotions.ts`)

Structured rules: discount (room % / room $ per night / package $), a travel window with a rule (`all_nights`, `arrival_date`, `per_night`), a booking window, eligible resorts and rooms, min/max nights, minimum ticket days, package-only, party size, audience (Florida resident, passholder, military) and blackout nights.

- Every checkable condition must pass → **eligible**, applied.
- An audience condition answered "Not sure" → **uncertain**: shown as a possible saving and never added to a total.
- Offers are assumed **not to combine**. The single largest eligible saving is applied.

### Tax jurisdictions

Each resort has a `taxJurisdictionId` in the catalog, and each `TaxRate` has a `jurisdictionId`. The engine only looks rates up; it hardcodes no county. Current reference estimates are Orange County (12.5% lodging, 6.5% sales) and Osceola County (13.5% lodging, 7.5% sales).

Resort assignments:
- The All-Star resorts are Osceola, per published sources.
- Animal Kingdom Lodge and Kidani Village are unconfirmed. They carry a `taxJurisdictionNote` and use the higher Osceola rate so costs aren't understated. The note appears in the tax line's calculation.

### Payment terms and switching costs (`pricing/payments.ts`)

A quote (or a point-rental cost) can carry `PaymentTerms`: deposit, installments, the final-balance due date, amount already paid, refundability, the free-cancellation date, and penalty tiers (fixed or % of total, from a date on). `summarizePayments` derives:
- the amount due to book, separate from the trip total
- the payment schedule (paid / overdue / upcoming)
- cancellation exposure on a date

Exposure rules, in order:
- The latest penalty tier in effect applies.
- Otherwise, a refundable booking inside its free window costs 0.
- A non-refundable booking loses what was paid (the full amount, for an unpaid quote).
- Anything else is **unknown**.

A quote marked `booked` is an existing reservation. When the preferred plan is priced from one, every saving carries `switching: { penaltyCents, netSavingsCents }`. "Best alternative" is only awarded when the net saving is known and positive. Otherwise a notice explains why no saving is claimed.

### Ticket usage (`pricing/ticketUsage.ts`)

Price and usability are separate. `TicketUsage` records:
- the use-within window (`null` = unknown)
- the expiration date
- blocked-out dates
- whether park reservations are required (`null` = unknown)

It comes from the ticket price itself, or from a product-level `TicketRule` (option, days or "all durations", channel). An exact-duration rule beats an all-durations rule at equal trust. Rules are never assumed: the illustrative dataset attaches its demo usage only to its own illustrative prices.

How usability is evaluated:
- The usable days run from the ticket start to the last possible park day of the trip, limited by the window and expiration, minus blockouts.
- If they are fewer than the required park days, the ticket is **violated**. The resolver skips violated prices (a cheaper unusable ticket is no bargain).
- If no usable ticket exists, the configuration is infeasible and the reason is reported.
- An unknown window gives **unknown**, which is reported per option and in a notice.

### DVC point stays

DVC resorts have `accommodation: "dvc_villa"` and `dvcPoints: true`. Their villas can be booked for cash, like a hotel room or a Disney package, or with points as a separate booking method, `points`. Point stays are only enumerated when the request sets `resorts.considerPoints`.

Pricing a point stay:
- Points per night come from `PointChartEntry` data. The cash cost comes from a `PointCost`: a rental provider's price per point with optional fee, minimum and terms, or the user's own valuation of owned points, which should be marked estimated.
- Several point costs compete as separate options, like ticket channels: trust first, then cash cost.
- Point stays never receive cash promotions, aren't packaged, and are never collapsed with cash stays, because their cancellation terms differ.

### Importers (`data/importers/`)

These are pure and deterministic, and every result is re-validated with the server's `priceEntrySchema`.
- **`quoteText.ts`** parses `Key: value` quote text. It requires every essential field and resolves resort and room names by exact or unique match. Ambiguity is an error, never a guess. `formatQuoteText` writes the same format; a parse → format → parse round-trip is tested.
- **`ticketBulk.ts`** parses date/price lines or a CSV/TSV table. It validates every line, rejects overlapping ranges for the same product, and is all-or-nothing.

## Optimization (`optimizer/`)

1. **Enumerate** arrival dates × stay lengths in the window × resorts/rooms × allowed ticket types × dining choices × booking methods. Structurally impossible combinations are never generated: dining plans need a package, and packages need tickets and a Disney resort.
2. **Hard constraints** (`constraints.ts`): date window, nights range, allowed resorts, Disney-only, room occupancy, required park days fitting the stay, accepted ticket types, dining policy, and package rules. Infeasible configurations are counted by reason and shown to the user.
3. **Group, bound, price.** Configurations that differ only in package vs separate form a group. Groups are priced in order of their lower bound, and a group is skipped only when the bound proves it can't appear in any output (see *Pruning*). Problems found while pricing (no usable ticket) are hard violations.
4. **Collapse** package vs. separate within each group and trust class. Complete beats incomplete; between incomplete options, fewer missing prices beats a lower partial total. Then the cheaper method wins (ties → separate, which is more flexible), and the other method's total is kept for display. DVC point stays are never collapsed.
5. **Partition** into comparable, illustrative-set-aside, incomplete and over-hard-limit groups.
6. **Score** best value: a weighted mean of explicit 0–100 sub-scores. Price is the cheapest comparable total ÷ this total, so the cheapest scores 100 and one costing 25% more scores 80. This replaced Milestone 1's min–max scaling: it doesn't depend on the most expensive option, so outliers can't distort scores, and an upper bound is computable before pricing. Resort is 100 if preferred, 60 if the same tier as a preferred resort, 25 otherwise. Convenience is the editorial 1–5 rating. Ticket is 100 if it matches the preference, 50 otherwise. Dining is 100/40 when a plan is preferred. Dates lose 10 per day of arrival shift and 15 per night of length change. The score is relative to one run, so it is not an absolute measure of value.
7. **Rank** deterministically. Cost: total → better data status → closer to preferred dates → earlier arrival → id. Value: score → cost order.
8. **Awards, savings (net of switching costs), date calendar, notices.** Notices are phrased only from outputs, so they are identical with or without pruning.

### Pruning (`optimizer/bound.ts`)

The workload is large. The wide benchmark (120-day arrival window, 4–10 nights, all ticket types, all 30 accommodations) has **450,492** configurations, more than the roadmap's original 180k estimate because the catalog grew.

**The bound.** `createBounder` computes a lower bound per configuration:
- Room, points, dining, transport and other costs are exact (memoized resolution).
- Promotions are bounded by the largest single possible discount (offers don't combine), and taxes by the rate applied to the bound.
- Tickets use the cheapest candidate price of any status, ignoring usability.

Flags over-approximate whether the result may be complete, incomplete, illustrative or real. Configurations a stay quote could price are never bounded.

**When a group is skipped.** Only when, for every trust class it may belong to, its bound exceeds the current threshold of every output it could enter:
- the cost top-N
- the value top-K (using an *upper* bound on the score)
- the date-calendar cell
- the best alternative
- the incomplete list
- the over-limit list

Thresholds only tighten as pricing proceeds, so a skipped group can never belong in the final outputs. Value-heap scores use a lower bound on the final cheapest total, keeping that threshold conservative too.

**Proof by test.** `tests/pruning.test.ts` runs 80 randomized requests and datasets with and without pruning and requires identical results, everything except `stats`. A mutation check (an inflated bound) makes it fail.

Results (median, same machine, `npm run bench`):

| Scenario | Configurations | Milestone 1 catalog | Expanded catalog, no pruning | With pruning |
| --- | --- | --- | --- | --- |
| Default (Jan 4–Feb 20, 5–7 nights) | 43,596 | 0.42 s (8,316 configs) | 2.58 s | **0.31 s** |
| Wide (120 days, 4–10 nights, 3 tickets) | 450,492 | 5.37 s (85,932 configs) | 45.4 s | **4.3 s** |
| Widest (120 days, 1–14 nights, no tickets) | 83,895 | 0.66 s (16,065 configs) | 6.5 s | **1.9 s** |

What remains in the wide case is enumerating, constraint-checking and bounding 450k configurations. `addDays` results are memoized because date construction dominated the profile.

## Extending

- **New data source:** implement `PriceSource` in `src/data/sources.ts` (e.g. an authorized partner feed) and tag its output with honest provenance. The resolver handles precedence. Nothing in the optimizer changes.
- **New resort or room:** add it to `src/data/catalog.ts`, and to the illustrative generator if demo coverage is wanted.
- **AI assistant:** produce a `TripRequest` (schema already strict), call `optimize()`, and explain `awards[].explanation`, `lines[].calculation` and `assumptions`. Those are the facts the assistant may state.
- **Monitoring:** saved trips store run snapshots; price entries keep their observation history; booked quotes carry payment and cancellation terms, and savings are already netted against them. Next steps are a scheduled job that re-runs saved requests and change detection over history.

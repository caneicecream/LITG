# Architecture and design decisions

## Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| **Domain** (pricing + optimization) | `src/domain/` | Pure TypeScript with no I/O or framework imports. Calculates costs, checks promotion eligibility and hard constraints, enumerates and ranks configurations, computes savings. Fully deterministic, so the same inputs always give the same output. |
| **Data** | `src/data/` | Catalog (structure), reference estimates, the illustrative dataset, the store facade (`store.ts`) with JSON and PostgreSQL backends (`backends/`), and a `PriceSource` registry that assembles `PriceData` for the optimizer. |
| **Database** | `src/db/` | PostgreSQL pool, versioned migrations, the append-only observation table and the JSON import. Server-only; the domain never imports it. |
| **Itinerary** | `src/itinerary/` | Park catalog, the park-information model with provenance, and the deterministic itinerary planner (pure, framework-free; consumes a validated trip context, never the price optimizer's internals). See *Itinerary planning*. |
| **Monitoring** | `src/monitoring/` | Pure parts (configuration fingerprints, price series, change detection, switching-cost analysis) and the service that runs checks, schedules them and sends notifications. See *Price history and monitoring*. |
| **App** | `src/app/`, `src/components/` | Next.js pages and API routes. The UI only collects a `TripRequest` and renders an `OptimizationResult`; it does no pricing of its own. |
| **AI** | `src/ai/` | Interprets natural language into a reviewable patch to the `TripRequest`, and explains the optimizer's result from a facts digest. It never computes or states a price the optimizer didn't produce. See *AI-assisted planning*. |

### Why this stack

- **Next.js + TypeScript** in a single app: one language end to end, runs locally with `npm run dev`, and leaves a straightforward path to deployment later. No microservices.
- **Optimizer in TypeScript, not Python:** the problem is enumeration plus integer arithmetic, not numerical computing. Sharing types between the engine, the API and the UI removes a whole class of bugs. A typical run evaluates about 8,000 configurations in about 0.3s.
- **Two interchangeable stores:** the JSON file needs zero setup and stays the default. PostgreSQL (set `DATABASE_URL`) adds durable, append-only price history and monitoring. All persistence goes through the `src/data/store.ts` facade, so routes and the domain don't know which backend is active.
- **`pg` with hand-written SQL migrations, no ORM:** the schema is small, the SQL is reviewable in one file (`src/db/migrations.ts`), and constraints such as "observations are append-only" are enforced in the database itself.
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

## AI-assisted planning (`src/ai/`)

**Principle: AI interprets the vacation; the deterministic optimizer calculates it.**

```
user message ─▶ provider.interpret ─▶ proposalSchema (strict zod) ─▶ applyPatch ─▶ parseTripRequest
                                                                       │ (diff, adjustments, warnings, errors)
                                                     reviewable proposal ◀┘
apply ─▶ optimize(request) [+ optimize(variant) for each comparison] ─▶ OptimizationResult (stored)
      ─▶ buildDigest(result, previous run, variants) ─▶ numbered facts
      ─▶ provider.explain(facts) ─▶ explanationSchema ─▶ groundExplanation ─▶ AI text  |  deterministic facts
```

- **The model's output is a patch, not a request.** `proposalSchema` contains only request fields, all nullable (null = unchanged). Relative operations ("+1 night", "arrive 1 day earlier") are resolved in code, so the model never does date arithmetic. Strict objects reject extra keys, so prices or totals can't be smuggled in.
- **`applyPatch` is deterministic.** It changes only the named fields, so unrelated preferences survive every refinement. It also:
  - keeps the window and baseline consistent, with every consequential change listed as an "adjustment"
  - validates resort and room ids against the catalog
  - validates the result with the planner's own `parseTripRequest`
  - applies **money values only if the user stated that amount**; otherwise it reports "not applied"
- **Hard vs soft.** Requirements map to filtering fields: date window, nights range, allowed resorts/tiers, accepted tickets, dining require/exclude, hard limit. Preferences map to ranking fields: the preferred plan, preferred resorts, budget target, objective and weights. `describeRequest` shows both, plus which sections are still defaults the user hasn't confirmed.
- **Review before apply.** Proposals are stored as `pending` (or `invalid`, with reasons) and applied only on request, unless the conversation's auto-apply setting is on. Each applied run stores its request snapshot, so any earlier decision can be restored.
- **Facts digest (`digest.ts`).** Every statement the assistant may make about money is generated from the `OptimizationResult`, using the optimizer's own formatting:
  - award winners and their reasons
  - the baseline and the top-ranked options
  - the cost breakdown, offers (applied and possible), assumptions and notices
  - exclusions, nearby arrival dates
  - changes vs the previous run, and comparison variants

  Differences the user may ask about are precomputed, so the model never needs to do arithmetic.
- **Grounding (`grounding.ts`).** Every `$` amount, percentage and score in AI text must appear in the facts (or be the user's own number), and every citation must exist; otherwise the AI text is replaced by a deterministic explanation built from the facts, with the reason shown. The interpretation reply is checked the same way. Displayed numbers in the results panel always come from the stored `OptimizationResult`, never from AI text.
- **Providers (`providers/`).** `AiProvider` has two methods, `interpret` and `explain`, both returning raw output that the service validates.
  - `AnthropicProvider` uses the official `@anthropic-ai/sdk` (`beta.messages.parse` with `betaZodOutputFormat`). It uses adaptive thinking with explicit effort (`medium` to interpret, `low` to explain), a cached system prompt, and `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) for refusals.
  - Typed SDK errors map to `rate_limited`, `unavailable`, `timeout`, `auth`, `bad_request`, `refused` and `invalid_output`. The SDK retries 429/5xx twice.
  - `RulesProvider` is the keyless basic mode. A mock provider is used in tests.
  - If the configured provider fails or returns unusable output, that message is handled by basic mode with a visible notice. The request is never changed by a failed call.
  - Keys live only in server environment variables (`providers/config.ts`).
- **Persistence.** Conversations live in the active store (JSON or PostgreSQL) with prices and trips, holding the request, confirmed sections, messages (proposals, runs, explanations with their facts) and the latest full result.
- **History questions.** Every explanation also gets *Price history* facts (recorded observations of the preferred plan's exact configuration: latest, previous, change in $ and %, lowest and highest, age and staleness) and *Switching analysis* facts (the same `analyzeSwitching` arithmetic as monitoring). They go through the same grounding check, so the AI cannot invent a price drop or call a price difference a saving. Basic mode treats history and switching questions ("what's the lowest price we've recorded?", "is it worth switching?") as explanations, never as a change of objective. In JSON mode the observations are rebuilt from each entry's re-check history.
- **Adding a vendor.** Implement `AiProvider` (reuse `prompts.ts` and the zod schemas for structured output) and add a case in `providers/config.ts`.

## Extending

- **New data source:** implement `PriceSource` in `src/data/sources.ts` (e.g. an authorized partner feed) and tag its output with honest provenance. The resolver handles precedence. Nothing in the optimizer changes.
- **New resort or room:** add it to `src/data/catalog.ts`, and to the illustrative generator if demo coverage is wanted.
- **AI provider:** see *AI-assisted planning* above.
- **Authorized price adapter:** implement `ObservationAdapter` in `src/monitoring/adapters.ts` and register it. Its quotes are validated like user quotes, must match the tracked configuration exactly, are stored as `verified` observations with the adapter's limitations attached, and identical repeats create nothing. Never point an adapter at Disney's consumer website.
- **Authorized park-information source:** implement `ParkInfoSource` in `src/itinerary/sources.ts` (none is registered). Its items must carry honest provenance (`verified` or `predicted`, source and retrieval time) and pass `parkInfoSchema`.
- **Schema change:** add a migration to `MIGRATIONS` (never edit an applied one; checksums are verified) and bump nothing else.
- **Optimizer rule change:** bump `ENGINE_VERSION` (`src/domain/optimizer/version.ts`) so monitoring labels the resulting total changes as recalculations, not price changes.

## Price history and monitoring (Milestone 4)

**Central principle:** a lower quoted price is not necessarily a better financial decision. Monitoring tells you what changed, and whether switching would actually save money after the cost of switching.

### Storage

| Table | Contents |
| --- | --- |
| `price_entries` | Current state of each price entry (JSON), soft-deleted with `deleted_at` so its history survives. |
| `price_observations` | One immutable row per observed version of an entry: source, URL, observed date, recorded time, origin (`entry`, `recheck`, `import`, `adapter`), status, value, the full configuration (resort, room, check-in/out, party, booking method, tickets, dining), tax treatment and quoted tax, comparable total, payment/cancellation terms, assumptions, and a snapshot of the entry exactly as observed. A trigger rejects every `UPDATE` and `DELETE`. `UNIQUE (entry_id, content_hash)` makes identical content impossible to record twice. |
| `trips`, `trip_runs` | Saved trips and every run snapshot (the API returns the latest 50). |
| `conversations` | Assistant conversations. |
| `monitors` | One per monitored trip (opt-in): enabled, settings, last/next check. |
| `monitor_checks` | Append-only log: what each check saw (`CheckSnapshot`) and the events it detected. |
| `notifications` | In-app notifications (one digest per check), read state, email delivery result. |
| `app_settings` | Notification preferences (email address). |
| `schema_migrations` | Applied migrations with SHA-256 checksums. |

**Migrations** (`npm run db:migrate`) run each pending migration in its own transaction under an advisory lock, and refuse to run if an applied migration was edited. The app never migrates implicitly: when the schema is behind, requests get a clear 503 asking you to migrate.

**Connection failures** become `DatabaseUnavailableError` and a 503 with an explanation (`src/lib/guarded.ts`), never a crash. Without `DATABASE_URL`, monitoring endpoints answer "not configured" and the UI shows setup steps; the rest of the app is unaffected.

**JSON import** (`npm run db:import-json`, with `--dry-run`): one transaction, idempotent, never modifies the JSON file. Each entry's `history` becomes observations (marked as reconstructed, since the JSON history kept only price, date, status and source). Rows that already exist are never overwritten; differences are reported. Structurally broken files abort with nothing imported; entries that fail today's validation are imported verbatim with a warning.

### Equivalent configurations (`monitoring/fingerprint.ts`, `series.ts`)

A **fingerprint** is resort | room | check-in | nights | party | booking method | tickets (option and days) | dining. Observations are joined into one trend line only when their fingerprint, **tax treatment** (all-in vs pre-tax) and **evidence** (quoted vs your estimate) all match. Anything else is a separate series, and the UI explains why. A series with one point shows no trend and says a trend needs two observations.

### Checks (`monitoring/service.ts`)

A check re-evaluates the saved trip with the prices stored at that moment, exactly as the planner would, and stores a `CheckSnapshot`:

- hashes of the request, of all price data (ignoring history), of the catalog and reference data, plus `ENGINE_VERSION`;
- the tracked plan (the trip's preferred plan), the cheapest like-for-like alternative and the cheapest option, with cost lines;
- the booked reservation pricing the plan, if any, and the switching analysis;
- observations of the tracked configuration recorded since the previous check, and what any adapter returned.

**A check never creates observations.** It is labelled everywhere as a re-evaluation with stored prices, not a live price check. New observations come only from your entries and re-checks, imports, or an authorized adapter. Re-checking a quote with identical content is rejected ("nothing new to record").

Scheduling: `npm run monitor` (cron), `POST /api/monitoring/run` with `x-monitor-secret` (external scheduler), or `MONITOR_SCHEDULER=on` (in-app timer from `instrumentation.ts`). Due monitors are claimed with `FOR UPDATE SKIP LOCKED` and a short lease, so overlapping schedulers never run a check twice, and one failing monitor doesn't stop the others.

### Change detection (`monitoring/detect.ts`, pure)

Comparing the previous and current snapshots:

1. **Configuration changed** (request hash or tracked fingerprint differs): reported as such; totals are not compared.
2. **Price change** (`price_decrease` / `price_increase`): same configuration, same real/illustrative class, both complete, and the price data changed. Gives $ and %, and the changed cost lines with their sources. Notifies when the change is at least `minChangeCents` or `minChangePct`, subject to per-type preferences.
3. **Recalculated**: the total moved but no price data changed (engine/catalog/reference update, or a date-dependent rule). Explicitly "not a change in Disney's price"; never notified.
4. **Price confirmed / provenance changed**: same total from a newer observation, or a status change (e.g. manual → estimated).
5. **Promotion applied / ended / possible**, **stale** evidence (once per data state), **price missing** / **price available**, **new comparable quote** (another observation of the same configuration, disclosing a different tax treatment), **cheaper alternative** (reported when it first appears or changes, with the switching verdict).

Every event has a stable `dedupeKey`; a notification digest includes only events never notified before, so the same situation never notifies twice.

### Switching-cost analysis (`monitoring/switching.ts`, pure)

Inputs: reservation total and terms (amount paid, refundability, free-cancellation date, penalty tiers), alternative total and deposit, known fees, other non-refundable amounts, ticket and dining change costs (`null` = unknown), and a minimum benefit.

```
price difference   = reservation total − alternative total      (never called a saving)
cancellation cost  = cancellationExposure(terms, total, paid, today)   (null = unknown)
switching cost     = cancellation + fees + other non-refundable + ticket change + dining change
net benefit        = price difference − switching cost
refund             = max(0, paid − cancellation)
due now            = new deposit + fees
left to pay        = alternative total − new deposit
```

Verdicts: **unknown** (any input to the switching cost is unknown, or a price is illustrative/unavailable: "no reliable recommendation can be made"), **not worth it** (net ≤ 0), **review** (positive but below the threshold, not like-for-like, or a price is stale or estimated), **worth considering** (net ≥ threshold on known figures). It always reminds you that the app never books, changes or cancels anything, and that you should book the alternative and confirm its price before cancelling.

### Notifications (`monitoring/notify.ts`)

In-app always (bell with unread count, `/notifications`). Optional email via SMTP (`SMTP_URL`, server-side only), enabled globally and per monitor. A failed email is recorded on the notification and never loses it.

### Price sources and their limits

| Source | What it is | Limitations |
| --- | --- | --- |
| Your entries and re-checks | Quotes you copy from booking pages, agents or confirmations | Only as current as the observation date; staleness is flagged. |
| JSON import | Your earlier JSON history | Earlier observations kept only price, date, status and source; other fields are assumed unchanged (stated on each record). |
| Authorized adapters | Interface only; **none registered** | Would need a contractual API (e.g. a travel-trade wholesaler). Disney's consumer site is never scraped or automated. |
| Illustrative data | Demo prices | Never recorded as observations, never compared with real prices. |

## Itinerary planning (Milestone 5)

The itinerary planner consumes a **validated trip context** and produces a separate, explainable plan. It never changes prices or the trip. AI may interpret preferences and explain results; the deterministic planner enforces constraints and calculates scores.

### Inputs (`itinerary/types.ts`, all zod-validated)

- **Trip context** (`context.ts`), derived from a TripRequest's preferred plan: dates, party, resort, ticket option and admission days, and Park Hopper. Ticket usage rules come from a quote for exactly that stay or a product rule in the user's price data; they are null when unknown.
- **Preferences:**
  - parks, day pins, attraction choices (must / want / avoid), custom activities;
  - pace, priority toggles, day window, arrival/departure-day limits, meal windows;
  - midday rest, flexible afternoons, "busiest day not first", rest-day preference, hopping, early entry, Lightning Lane mode;
  - wait buffer, mobility, park days to use.
- **Park information**, each item with `provenance { status, source, observedAt }`:
  - park hours (with optional early entry), attraction windows, closures;
  - waits (`your_estimate`, `predicted`, or `observed`, which is reference only);
  - crowd estimates, park reservations, dining reservations, Lightning Lane return windows, Lightning Lane rules.
  - User entries are `manual`, `estimated` or `predicted`, never `verified`, which is reserved for an authorized adapter. `illustrative` is for the demo only. `stale` (older than 30 days by default) and `unavailable` are derived.
- **Catalog** (`catalog.ts`): parks, areas with schematic coordinates (walking-minute units), and 68 attractions. Each field has its own basis:

| Field | Basis |
| --- | --- |
| Existence, park, land | Curated; spot-checked against third-party guides via web search on 2026-10-31 (secondary sources). Attractions reported as closing in 2026 are left out. |
| `kind` (ride / show / walkthrough / experience), `category`, `intensity` | Curated classification. |
| `durationMin` | **Estimate** (approximate experience length, excluding waits). |
| `schedule` | `continuous`, `showtimes` (scheduled performances: times must come from the user), or `spectacular` (evening shows and parades: planned only at an entered time). |
| `minHeightIn` | **Reported** by third-party guides where they agreed; labelled "verify". Absent means unknown, never "no requirement". |
| `advisories` | Dated, sourced reports (refurbishments, re-themes) with a confidence level. Shown for overlapping trip dates; **never applied** as closures. A confirmed closure is a user entry. |

  The catalog contains no hours, waits or crowds.

### Algorithm (`itinerary/engine.ts`)

1. **Usable dates.** Exclude arrival and departure days unless the trip allows parks on them, plus dates after ticket expiry and blocked-out dates. The use-within window is enforced during allocation. Pins are validated first; impossible pins make the request infeasible with a reason.
2. **Park-day allocation.** A beam search over dates, where each date can be no park, a park, or a hop (only with Park Hopper and when allowed).
   - Constraints: ticket days, the use window, pins, commitments (dining, Lightning Lane and park reservations tie a date to a park; hop order follows commitment times), and reservations when required.
   - Allocations are ranked by a cheap estimate: capacity vs must, want and optional demand, coverage of the requested parks, the hop penalty, "busiest day first", and the rest-day preference.
   - Beam width 60; at most 21 days. The top 4 allocations are scheduled in full.
3. **Day scheduling.** Four orderings per park day:
   - priority-weighted nearest neighbour, with a revisit penalty (stronger with "avoid crossing the park");
   - **must-dos first**, in walking order;
   - clockwise and counter-clockwise area sweeps.

   The day ordering is chosen by a day score that adds a **must-do lateness penalty** (6 points per hour a must-do starts after the day's start, ignoring must-dos with their own time windows). This favours earlier must-dos without forcing them ahead of large walking costs. A must-do that still starts 3+ hours into the day gets a note explaining why: its window, the other must-dos ahead of it, or grouping to limit walking.

   An item whose window opens more than 20 minutes later is deferred while something else fits, so a late show doesn't leave the morning idle.

   For **performances** (`showtimes`, `spectacular`), the entered time is the start of the show: arriving early (10 min for shows, 30 min for evening spectaculars, assumed) happens before it. Spectaculars without an entered time are never scheduled; they're listed with a link to enter the time. Shows without times are scheduled but flagged "performance times unknown".

   Each ordering is simulated minute by minute:
   - walking between areas: schematic distance + 2 min, × 1.4 for slower mobility;
   - waits: your estimate, then a prediction, then your buffer scaled by your crowd estimate;
   - attraction windows and closures;
   - fixed items: dining, Lightning Lane windows, midday rest, flexible afternoons. Overlapping fixed items are conflicts; preferences give way to reservations;
   - meals placed in their windows, or covered by a reservation or the midday rest; a meal more than 2 hours late is dropped and reported;
   - pace breaks; optional extras only up to the pace's busy-ness target (relaxed 55%, moderate 70%, packed 85% of the window).
4. **Scoring** (0–100 per component; weights shift with your priorities):

| Component | Base weight | Calculation |
| --- | --- | --- |
| Must-do coverage | 35 | scheduled ÷ total must-dos (including must-dos in parks you didn't choose) |
| Other preferences | 20 (+15 "fit in as much as possible") | 70 × wants scheduled + 20 × requested parks visited + 10 × extras (vs 30% of extras available) |
| Walking & backtracking | 15 (+15 minimize walking, +10 avoid crossing) | 100 × (1 − 2 × walking ÷ (walking + activity)) − 6 per backtrack (12 with "avoid crossing") |
| Pacing & breaks | 20 (+15 keep it relaxed) | per day: 100 − 150 × (busy-ness above target) − 15 for a long stretch without a break − 10 per late meal; −15 if the busiest day is first when you asked otherwise |
| Data certainty | 10 | 100 − 50 × (share of park days without entered hours) − 50 × (share of rides on an assumed wait) |

   The total is the weighted mean. It measures fit with stated priorities and the share of known data, not vacation quality. The highest total among the scheduled candidates is returned as the best candidate found.
5. **Independent verification** (`verifyItinerary`) re-checks the hard constraints on the result: ticket days, Park Hopper, use window, blocked dates, expiry, trip dates, reservations, overlaps (including travel), day windows, skipped attractions, closures, attraction windows, and parks. Any violation turns the plan into "not feasible" with the reasons. A randomized test runs this over many inputs.

**Status:** *feasible* (hard constraints met, all must-dos placed), *partial* (some must-dos left out, each with a reason), or *infeasible*. A separate *provisional* flag is set when hours are unknown, waits are assumed, reservations are unresolved, or the plan is the demo.

**Comparison** (`compareVariants`, `compareItineraries`): the same inputs with different preference sets (relaxed vs ride-focused, or one fewer park day from the assistant).
- **Same-facts check.** Trip context, park information, demo flag and planner version are compared by hash. Any difference is disclosed, and the scores are then declared not directly comparable.
- **Rows.** Feasibility, must-dos, park days, activities, walking and transfers, waiting from your estimates vs assumed buffer, meals, breaks, free time, unplanned time at day ends, earliest start, latest finish, conflicts and unknowns.
- **Scores.** Per-component scores with each plan's weights. Totals count as comparable only when the weights match.
- **Trade-offs.** Generated sentences: more activities vs less rest, walking, late finishes, must-do coverage, and assumptions present in only one plan. More activities is never treated as automatically better.

### Persistence

`SavedItinerary { id, name, tripId, versions[] }`. Each version stores the validated input (including the park-information snapshot with provenance), the result (with score breakdown and `engineVersion`), a note and a timestamp.
- **Append-only.** JSON appends to `itineraries` (an optional field, so older files still load). PostgreSQL migration 003 adds `itineraries` and `itinerary_versions`, with a trigger that forbids updates.
- **Re-planning on save.** The server always re-plans from the inputs on save; a client-supplied result is never stored.
- **Old versions stay as generated.** When the planner version changes, they keep their recorded `engineVersion`, and the UI offers to plan again as a new version.

### Assistant integration (`src/ai/itinerary/`)

- **Routing.** Itinerary messages are detected deterministically; trip-pricing messages still go to the trip flow.
- **Proposals.** An `ItineraryPatch` (all fields nullable) comes from the basic-mode interpreter or from Claude (`interpretItinerary`, structured output). `applyItineraryPatch` validates ids, trip dates and ticket limits. It accepts dining and Lightning Lane times only when they appear in the user's messages, and re-validates the whole input. Proposals use the existing review/apply/dismiss and auto-apply model.
- **Planning and explaining.** Applying runs the planner (plus up to two comparison variants) and builds itinerary facts. Explanations must cite facts, and every number in them (times, minutes, counts, scores) must appear in the facts. Otherwise the deterministic fact list is shown, with the reason.
- **Current facts.** Questions about park hours, waits, crowds or availability get an honest "not available" with the manual-entry path.
- **Unsupported claims (Milestone 6).**
  - Trip and itinerary explanations are also checked for wording the facts don't support: "current/live price", "guaranteed", "is available", "you have a (confirmed) reservation", "I booked". Such text is withheld unless the same wording appears in a fact.
  - Trip explanations include a **price freshness** fact: when the user's prices were observed, how many are stale, and that re-running the optimizer re-evaluates stored prices rather than checking prices again.

### Trip ↔ itinerary workflow (Milestone 6)

- **Plan the park days for this option.** Any optimized option can be planned. The client hands the request that produced the results, plus the option's configuration, to `POST /api/itinerary/context`, which validates the option. The trip card shows exactly what is planned.
- **Saved trips** link to `/itinerary?trip=…` and list their itineraries. Saved-itinerary summaries carry the trip label and dates.
- **Trip-change warnings.** `contextDifferences` compares a saved itinerary's trip snapshot with the trip as it is now: dates, resort, party, tickets, ticket rules, arrival/departure-day parks. Differences are shown; nothing is replaced until the user presses "Use the current trip details". Planning again then adds a new version.
- **Actionable unknowns.** Missing information in a plan (hours, show times, closures, waits, Lightning Lane windows, park reservations) has a button that opens the matching entry form.

## Security model (Milestone 6)

- **Single user.** There are no accounts and no authentication. The app is meant for a personal machine or private network; public deployment needs an authenticating proxy in front of it.
- **CSRF.** `src/proxy.ts` (the Next 16 proxy) runs on `/api/*`. Writes with an `Origin` from another host (or `null`) get 403. Form-encoded and `text/plain` bodies get 415, so cross-site HTML forms can't reach the JSON APIs. `POST /api/monitoring/run` is exempt from the content-type rule; it is authenticated by `MONITOR_CRON_SECRET` with a constant-time comparison.
- **Errors.** Intentional, user-facing errors are `RequestError`s (400). Database outages are 503. Anything else is logged server-side with credentials redacted (`redact()`: URL passwords, API keys, configured secrets) and answered with a generic 500. Email failures store a redacted error on the notification and never lose it.
- **Secrets** (`ANTHROPIC_API_KEY`, `DATABASE_URL`, `SMTP_URL`, `MONITOR_CRON_SECRET`) are read only on the server and never sent to the browser.

## Performance (measured 2026-10-31, development container)

| Workflow | Median |
| --- | --- |
| Price optimization, default search (43,596 candidates, 98% pruned or infeasible) | 375 ms |
| Price optimization, wide search (450,492 candidates) | 5.2 s |
| Itinerary: demo, 4 park days | 13 ms |
| Itinerary: 15-day trip, 10 Park Hopper days, 23 must-dos | 127 ms |
| Itinerary: regenerate after an edit | 8 ms |
| Relaxed vs ride-focused comparison | 21 ms |
| Save an itinerary version (JSON / PostgreSQL) | 19 ms / 16 ms |
| Reopen an itinerary with 20 versions (JSON / PostgreSQL) | 18 ms / 13 ms |
| Monitoring history query, 500 observations (PostgreSQL) | 9 ms |

Reproduce with `npm run bench` and `npm run perf`. No performance change was needed in Milestone 6.

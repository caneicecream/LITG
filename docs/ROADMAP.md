# Roadmap

## Milestone 0: assessment (done, 2026-10-30)

**Starting point:** an empty repository (no commits). Node 22, npm, Python 3.13 and PostgreSQL 16 were available. We started from scratch with the brief's suggested stack, simplified to one Next.js app with no database server.

**Pricing data access: the main risk.**

- Walt Disney World publishes no public API for room rates, ticket prices or packages.
- Disney's website terms prohibit access by automated robots without permission, and Disney has acted against scrapers before (for example, dining-reservation crawlers). So **this project does not scrape Disney's sites.**
- Legitimate routes for later:
  - Travel-trade wholesale channels such as Hotelbeds document Walt Disney World hotel and package content, but require a B2B agreement.
  - Licensed historical pricing datasets exist from third parties, under custom contracts.
  - Disney's own travel-agent programs.
  - All of these need business agreements, so none fits a personal demo.
- **Decision:** Milestone 1 optimizes **user-entered real quotes**, with a clearly labelled **illustrative** dataset for demonstration. The `PriceSource` interface keeps a future authorized feed isolated from the optimizer.

**Other risks and mitigations**

| Risk | Mitigation |
| --- | --- |
| Illustrative numbers mistaken for real offers | Status on every line. Demo banner. Illustrative results are set aside when real ones exist and are never mixed in awards or savings. |
| Comparing unequal trips (e.g. 6 vs 7 nights) as "savings" | Like-for-like flag, per-night deltas, and "best alternative" restricted to like-for-like options. |
| Partial pricing that looks cheap | Incomplete totals are lower bounds, kept out of rankings and awards. |
| Package double counting | Quote-included components are shown at $0, and taxes and promotions are not re-applied to quotes. |
| Promotion terms too complex to model fully | Structured rules for the common conditions. Unknown eligibility is reported, not applied. Terms text is stored alongside. |
| Taxes vary by county | Taxes are labelled as estimates. Tax-inclusive quotes override them. |

## Milestone 1: working optimizer (done)

Acceptance criteria and status:

| Criterion | Status |
| --- | --- |
| Launch locally, enter requirements, run a comparison, get ranked results with traceable calculations | ✅ `npm run dev`. Every line shows its calculation, source and status. |
| Changing dates, budget or tickets recalculates correctly | ✅ Covered by tests and checked in the browser (e.g. a $3,000 hard limit leaves only totals ≤ $3,000). |
| Can tell verified, estimated, manual and illustrative prices apart | ✅ Status chips per line, a per-result status mix, and the demo-mode banner. |
| No savings claims the data can't support | ✅ Savings only within the same trust class against a fully priced baseline, labelled not-like-for-like where needed. |
| Flexible dates, budget (soft/hard), hard vs soft preferences, package vs separate, promotions with eligibility, saved trips | ✅ |
| Tests for the core financial logic | ✅ 66 tests |

## Milestone 2: better optimization (next)

Highest value first:

1. **More real-data ergonomics:** paste-friendly quote entry, duplicating a quote to tweak dates, bulk ticket-price entry from a published price calendar, and an "is this quote still current?" flow for stale entries.
2. **Catalog breadth:** more resorts and room views, plus Disney Vacation Club or rental-point stays as a separate accommodation type.
3. **Per-resort tax jurisdiction** (Orange vs Osceola) as data.
4. **Package nuances:** deposits, payment schedules, and cancellation terms, needed later for switching-cost math.
5. **Ticket validity windows** (an N-day ticket used within M days) and date-specific park reservations, if they apply again.
6. **Known-scenario regression tests** built from saved real quotes.
7. **Performance guard** for very wide windows (a 120-day window × 14-night range is about 180k configurations, or a few seconds), using pruning by lower bounds.

## Milestone 3: AI-assisted planning

A natural-language request becomes a `TripRequest` (validated by the existing schema). It runs through `optimize()`, and an explanation is grounded only in `awards`, `lines` and `assumptions`. Conversational refinements ("what if 7 nights?") edit the request and re-run. Provider-agnostic through a small interface, with keys from env vars and graceful degradation without them.

## Milestone 4: price monitoring

A Postgres store (price observations with history), scheduled re-runs of saved trips, change detection versus the last snapshot, switching-cost-aware "is rebooking worth it", and notifications. Never any automatic booking changes.

## Milestone 5: itinerary optimization

Park hours, crowd estimates and Lightning Lane decisions, with verified vs predicted inputs kept distinct.

## Milestone 6: expansion

Only after the core has proven useful with real quotes.

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
| Tests for the core financial logic | ✅ 66 tests at Milestone 1 (122 after Milestone 2) |

## Milestone 2: better optimization (done, 2026-10-30)

| Item | Status | Notes |
| --- | --- | --- |
| Paste-friendly quote entry | ✅ | `Key: value` text, several quotes per paste. Every essential field is required, with ambiguities and conflicts reported. Review before saving, or open a quote in the full form. |
| Duplicate quotes | ✅ | Copies into the form with the total and label cleared; the original is preserved. |
| Bulk ticket-price entry | ✅ | Date/range lines or a CSV/TSV table with per-row ticket, days, age and usage window. All-or-nothing validation, including overlap detection. |
| Quote freshness ("still current?") | ✅ | Stale review panel; re-check with or without a new price or source. Previous observations are kept in `history` and shown per entry. |
| Catalog breadth | ✅ | 30 accommodations: Value, Moderate and Deluxe resorts with room views, 7 DVC villa resorts, the Swan and Dolphin as on-site partners, and 3 generic off-property slots (hotel, suite or vacation rental, Disney Springs area). |
| DVC / rental points | ✅ | A distinct accommodation type and booking method: point charts, cost per point (rental or owned), fees, terms, point-rental quotes. Never collapsed with cash stays. |
| Per-resort tax jurisdiction | ✅ | Catalog data. Orange vs Osceola rates; unconfirmed assignments are flagged. Quote tax handling is explicit. |
| Package payments and cancellation | ✅ | Deposit, schedule, balance, due dates, refundability, free-cancellation date, penalty tiers. The amount due is separate from the total, and savings against an existing reservation are net of cancellation cost. |
| Ticket restrictions | ✅ | Use-within window, expiration, blocked-out dates, park-reservation flag; product rules or per-price. Unknown rules are reported. Unusable tickets are skipped, and trips with no usable ticket are ruled out with a reason. |
| Known-scenario regression tests | ✅ | `tests/scenarios.test.ts`: 21 hand-checkable scenarios with fictional, labelled quotes. |
| Performance | ✅ | Measured, then lower-bound pruning with a randomized equivalence proof: wide search 45.4 s → 4.3 s. See ARCHITECTURE.md, *Pruning*. |

Also changed:
- Best-value price scoring now uses cheapest ÷ total, documented and tested.
- Ruled-out reasons aggregate allow-list exclusions.
- Between two incomplete options, the one with fewer missing prices is shown.

**Partly done or deferred, and why**

- *Installment schedules*: modeled, validated and computed, but the forms and paste format only capture the deposit and final balance. Most Disney package quotes have just those two.
- *Choosing the county for a generic off-property slot*: the slot has a fixed, documented assumption. A tax-inclusive quote is the recommended way to price an off-site stay exactly.
- *Park-reservation availability*: only the requirement flag is modeled. No legitimate data source exists for availability.
- *DVC booking windows, banking/borrowing, and dining plans on point stays*: not modeled (rules not verified). Point stays exclude dining plans.
- *Bulk entry for room rates and point charts*: not done; Milestone 2 asked for bulk ticket prices. The same importer pattern applies.
- *Pushing to GitHub*: blocked by repository access in this environment. The work is committed locally.

## Next steps (highest value first)

1. Enter real quotes for an actual trip and use them to grow the scenario regression suite.
2. Installments in the forms; bulk entry for room rates and point charts.
3. Per-entry tax jurisdiction override for generic off-property slots.
4. Milestone 3 (AI-assisted planning) on top of the existing `TripRequest` contract.

## Milestone 3: AI-assisted planning

A natural-language request becomes a `TripRequest` (validated by the existing schema). It runs through `optimize()`, and an explanation is grounded only in `awards`, `lines` and `assumptions`. Conversational refinements ("what if 7 nights?") edit the request and re-run. Provider-agnostic through a small interface, with keys from env vars and graceful degradation without them.

## Milestone 4: price monitoring

A Postgres store (price observations with history), scheduled re-runs of saved trips, change detection versus the last snapshot, switching-cost-aware "is rebooking worth it", and notifications. Never any automatic booking changes.

## Milestone 5: itinerary optimization

Park hours, crowd estimates and Lightning Lane decisions, with verified vs predicted inputs kept distinct.

## Milestone 6: expansion

Only after the core has proven useful with real quotes.

# Roadmap

## Milestone 0: assessment (done, 2026-10-30)

**Starting point:** an empty repository (no commits). Node 22, npm, Python 3.13 and PostgreSQL 16 were available. We started from scratch with the brief's suggested stack, simplified to one Next.js app with no database server (PostgreSQL was added, as an option, in Milestone 4).

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
- *Pushing to GitHub*: was blocked by repository access during Milestone 2; resolved, and all milestones are now pushed.

## Next steps (highest value first)

1. Enter real quotes for an actual trip and use them to grow the scenario regression suite.
2. Installments in the forms; bulk entry for room rates and point charts.
3. Per-entry tax jurisdiction override for generic off-property slots.
4. ~~Milestone 3 (AI-assisted planning)~~ done; see below.
5. ~~Milestone 4 (historical pricing and monitoring)~~ done; see below.
6. ~~Milestone 5 (itinerary optimization)~~ done; see below.
7. ~~Milestone 6 (product readiness and data quality)~~ done; see below.

## Milestone 3: AI-assisted planning (done, 2026-10-30)

| Item | Status | Notes |
| --- | --- | --- |
| Conversational planning interface | ✅ | Assistant page: chat beside the plan and the existing results panel; new, continue and delete conversations; handoff from the planner. |
| Natural language → validated `TripRequest` | ✅ | Strict proposal schema → deterministic `applyPatch` → planner schema. Hard vs soft mapping, evidence quotes, clarifications, unsupported items, unstated money rejected. |
| Always use the optimizer | ✅ | Proposals change only the request; results come from `optimize()` (plus comparison variants). AI output has no price fields, and extra keys are rejected. |
| Grounded explanations | ✅ | Facts digest with precomputed deltas; every figure in AI text is checked; a deterministic fallback is shown with the reason. |
| Interactive refinement | ✅ | Relative changes (nights, arrival), resort/ticket/dining/budget/DVC changes, comparisons; unrelated choices preserved (tested). Edit in the form, restore earlier versions. |
| Provider architecture | ✅ | `AiProvider` interface; Claude via the official SDK (structured outputs, refusal fallbacks, typed error mapping); keyless basic mode; mock for tests; per-message fallback to basic mode on provider failure. |
| Conversation persistence | ✅ | Local JSON store: request, confirmed sections, messages, run snapshots, latest result. |
| Works without an API key | ✅ | Planner unaffected; assistant in basic mode. |
| Tests | ✅ | 43 AI tests (165 total) with mocked providers. |

**Deferred or limited**

- *Live Claude verification*: the Anthropic provider is tested against a mocked SDK client only. No API key was available in the build environment.
- *Additional vendors* (e.g. OpenAI): the interface and shared prompts/schemas are in place, but only the Claude provider is implemented.
- *Streaming responses*: requests are short structured calls, so the UI shows a progress state instead of streamed text.
- *Basic-mode coverage*: the keyless interpreter understands common phrasings only, and asks or reports anything else.

## Milestone 4: historical pricing and vacation monitoring (done, 2026-10-30)

| Item | Status | Notes |
| --- | --- | --- |
| PostgreSQL persistence | ✅ | Store facade with JSON (default) and PostgreSQL backends selected by `DATABASE_URL`. `pg`, versioned and checksummed migrations, `docker-compose.yml`, clear 503s when the database is down or behind. The domain layer is unchanged. |
| Safe import from JSON | ✅ | `npm run db:import-json` (with `--dry-run`): one transaction, idempotent, never modifies the file, never overwrites rows, reports differences, keeps entries that fail today's validation (with a warning). History becomes observations. |
| Historical observations | ✅ | Append-only (trigger-enforced). Each records source, URL, observed date, recorded time, full configuration, tax treatment, payment/cancellation terms, status, assumptions and a full snapshot. Identical content can't be recorded twice; re-reading a quote is not an observation. |
| Saved-vacation monitoring | ✅ | Opt-in per trip: pause/resume; preferences; latest and previous price, $/% change, trend, last observation, stale flag; "Check now"; source and status of every observation. |
| Scheduled monitoring | ✅ | Cron script, secret-protected endpoint, or in-app timer. Due monitors are claimed with `SKIP LOCKED` (no double runs). Checks are labelled as re-evaluations with stored prices, never as live price checks. Adapter interface for authorized sources (none registered). |
| Change detection | ✅ | Increases/decreases with $ and %, thresholds, confirmations, status changes, configuration changes, recalculations (engine/catalog versions), promotions applied/ended/possible, stale, missing, newly available, new comparable quotes, cheaper alternatives. Only equivalent configurations are compared. |
| Switching-cost analysis | ✅ | Original/new cost, cancellation cost, fees and other non-refundable amounts, ticket/dining change costs, net difference, due now, remaining balances, refund. Unknown inputs mean "no reliable recommendation"; never a saving from totals alone. Editable calculator. |
| Notifications | ✅ | In-app (bell, page, read state). Optional SMTP email, global and per monitor. One digest per check; dedupe keys mean a situation never notifies twice. Email failures are recorded and never lose the notification. |
| History visualization | ✅ | One SVG chart per equivalent series (hover details, stale points hollow, table view). Different series are never joined, and a single observation says why there's no trend. |
| AI assistant | ✅ | Price-history and switching facts in the digest, grounded like every other figure. Basic mode treats history questions as explanations. Works from re-check history in JSON mode. |
| Tests | ✅ | 240 total: pure financial/detection tests plus PostgreSQL suites (`TEST_DATABASE_URL`). |

**Deferred or limited**

- *Live prices*: no authorized source exists for this personal project (see Milestone 0). Monitoring is only as current as your re-checks, and the UI says so everywhere.
- *Tracked configuration*: the trip's preferred plan only. Tracking several configurations per trip is a natural extension of the same fingerprint model.
- *Modify-in-place rebooking*: the switching analysis assumes cancel-and-rebook and says so.
- *Email*: plain-text SMTP only; no unsubscribe links or delivery retries (a failed email is shown on the notification).
- *Imported history*: older JSON observations kept only price, date, status and source, so other details are assumed unchanged (stated on each record).

## Milestone 5: itinerary optimization (done, 2026-10-31)

| Item | Status | Notes |
| --- | --- | --- |
| Park-information model | ✅ | Park hours with optional early entry; attraction windows; closures; wait information (your estimate, prediction, or an observed wait kept for reference only); crowd estimates; park reservations; dining reservations; Lightning Lane return windows and rules. Every item carries source, entered/observed date and a status (verified, manual, estimated, predicted or illustrative; stale and unknown are derived). User entries can't be "verified". Validated with zod. |
| Park and attraction catalog | ✅ | Four parks, their areas on a schematic map, and about 40 long-running attractions with approximate durations. Dated and labelled approximate. No hours, waits or crowds. |
| Planning experience | ✅ | `/itinerary`: start from a saved trip, the current plan, or the labelled demo. Then trip review, parks, attractions (Must / Like / Maybe / Skip, plus your own activities), pace and preferences, and optional known information. Plan, review, edit and plan again, save and reopen. |
| Deterministic planner | ✅ | Usable dates (trip, arrival/departure, ticket expiry, blocked dates, use window); bounded beam search for park-day allocation (pins, reservations, Park Hopper only when the ticket has it); day scheduling with travel, waits, meals, breaks, flexible time and fixed reservations; an independent constraint check. |
| Scoring | ✅ | Must-do coverage, other preferences, walking and backtracking, pacing, and data certainty, weighted by your priorities. Documented and shown with what it measures. "Best candidate found", never "optimal". |
| Uncertainty | ✅ | No hours → your planning window, provisional. No wait data → your buffer, labelled unknown. Crowd estimates (yours) only scale that buffer. Observed waits aren't forecasts. Stale entries flagged. |
| Lightning Lane | ✅ | Return windows you hold are scheduled inside the window. Availability is never assumed, checked or booked. Rules are unknown unless entered. |
| Park-day allocation | ✅ | Musts spread across parks, a rest day when preferred, the busiest day not first when asked, reservations honoured. Infeasible pins and reservations are explained. |
| Assistant | ✅ | Itinerary proposals (basic mode and Claude) with the same review/apply/auto-apply model. Times are accepted only when the user stated them. Comparisons ("relaxed vs ride-focused", "one fewer park day") and explanations grounded in planner facts (times, minutes, counts and scores checked). Honest answers to current-facts questions. |
| Results | ✅ | Day-by-day timeline with walking, wait and duration; meal windows and reservations; breaks; must-do coverage; unscheduled items and reasons; conflicts; information used with status; score breakdown; side-by-side comparison from the same facts. |
| Persistence | ✅ | Saved itineraries keep inputs (with park-information snapshots), output, score breakdown, planner version and timestamps. Versions are append-only (immutable in PostgreSQL, migration 003). JSON files from before Milestone 5 still load. The JSON import covers itineraries. |
| Performance | ✅ | Bounded search (21-day cap, beam width 60, 4 full schedules). A 15-day Park Hopper trip plans in well under a second. |
| Tests | ✅ | 308 total (68 new): engine, persistence (JSON + PostgreSQL), API, assistant. |

**Deferred or limited**

- *Live park data*: no authorized source for hours, closures, waits, crowds, show times, or reservation and Lightning Lane availability. Manual entry is the path, and no adapter is implemented.
- *Catalog breadth*: a starter set of attractions with approximate durations; shows' performance times, parades, fireworks, height and accessibility requirements are not modelled.
- *Breakfast and multi-hop days*: not planned (one hop per day, around midday).
- *Weather, transport timetables*: not modelled; transfer and walking times are estimates.
- *Live Claude verification*: as before, the provider is tested against a mocked SDK client only.

## Milestone 6: product readiness and data quality (done, 2026-10-31)

**Prioritized checklist (from inspecting the code, tests and running app) and outcome**

| # | Issue | Type | Outcome |
| --- | --- | --- | --- |
| 1 | Must-dos could land late in the day without a deliberate reason | Confirmed defect (M5 known issue) | ✅ Must-first ordering plus a documented lateness penalty; a late must-do says why; regression tests. |
| 2 | Evening shows could be placed at arbitrary times; a show's entered time was treated as a window to fit the whole visit inside | Confirmed defect | ✅ Spectaculars only at entered times; performance times are show starts. A show-time entry form was added: the model supported it, but the UI didn't. |
| 3 | An item whose window opens later could leave hours of idle time | Confirmed defect | ✅ Deferred while something else fits. |
| 4 | Thin catalog, durations presented without per-field basis | Data quality | ✅ 68 curated entries with kind, schedule type, reported heights (where guides agree), dated advisories, and an explicit basis per field. |
| 5 | Comparisons only counted activities | Gap | ✅ Same-facts check, waits (estimate vs assumed), meals, breaks, free time, start and finish, feasibility, trade-offs, score comparability. |
| 6 | No path from an optimized option or saved trip to an itinerary; no warning when a trip changed | Gap | ✅ "Plan the park days" from options and saved trips; trip-change warnings with explicit update; linked itineraries on saved trips. |
| 7 | Missing information only displayed | Gap | ✅ Unknowns link to the matching entry form. |
| 8 | API writes accepted cross-site form posts (CSRF against a local instance) | Confirmed defect (security) | ✅ Same-origin proxy; 403 and 415 responses; tests. |
| 9 | Assistant routes echoed internal error messages; credentials could appear in stored email errors and logs | Confirmed defect (security) | ✅ `RequestError` vs generic 500; redaction. |
| 10 | Assistant explanations could claim current prices, guarantees or availability | Risk | ✅ Claim check withholds such text; price-freshness facts. |
| 11 | Itinerary form overflowed at phone width; two pages lacked an `<h1>`; one input lacked a label | Confirmed defects (UX/a11y) | ✅ Fixed; browser smoke test added. |
| 12 | Pricing engine correctness | Review | ✅ No defect found. Hand-checked scenarios added: family component pricing, a missing child price (incomplete, never cheaper), a tax-exclusive package with a promotion present, best-value price-score dependence on alternatives. |
| 13 | Performance | Measurement | ✅ Measured (see ARCHITECTURE.md); no change needed. |

**Data sources used.** Third-party Disney guides found by web search on 2026-10-31, used for spot checks: attraction membership, reported heights, reported 2026 changes. Wikipedia and Disney's site couldn't be fetched from the build environment (network policy). No scraping; nothing is presented as confirmed by Disney.

**Live AI verification.** Not performed: no Claude API key was available. The provider remains tested against a mocked SDK client only.

**Remaining known issues**

- Durations, walking distances and arrive-early times are estimates. Heights and advisories are secondary-source reports to verify.
- No show performance times or park hours are known unless the user enters them.
- One hop per day; breakfast isn't planned; weather isn't modelled.
- The wide price search takes about 5 s.
- Single-user with no authentication: not for public deployment.

## Next steps (after Milestone 6)

1. Use it with a real trip: enter real quotes, park hours and reservations, and turn what's learned into scenario and itinerary regression tests.
2. Authentication in front of the app before any shared or hosted use.
3. An authorized data source, if one becomes available (licensed park-hours or pricing feed), through the existing adapter interfaces.
4. Installments in the forms; bulk entry for room rates and point charts.
5. A user-maintained catalog override: correct durations and heights in the UI and keep them with provenance.

## Milestone 7: expansion (not started)

Only after the core has proven useful with real quotes.

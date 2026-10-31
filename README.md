# Disney Vacation Optimizer

A personal tool that compares Walt Disney World vacation configurations by **total trip cost**, with every number traceable to its source.

You describe the trip: party, flexible dates, resorts, park days, tickets, dining, transport and budget. The optimizer considers every valid combination of:

- arrival date and stay length
- resort and room
- ticket type
- booking method: room + tickets separately, a Disney package, or a DVC villa booked with points
- dining plan

It prices each combination deterministically and ranks the results. It shows:

- **Cheapest**: the lowest total among fully priced options.
- **Best value**: the highest score under adjustable, explicit weights (price, resort preference, convenience, ticket, dining, dates).
- **Best alternative to your plan**: the biggest *like-for-like* saving compared with your own preferred plan. If your plan is a reservation you already hold, the saving is shown net of what cancelling it would cost.
- A flexible-date calendar, full cost breakdowns, payment schedules and cancellation exposure, and ticket usability.

You can also **plan in conversation** on the **Assistant** page ("two adults, six or seven nights, preferably Pop Century, under $5,000"). The assistant turns your words into structured changes you review, the optimizer prices them, and the assistant explains the optimizer's actual results. The AI never produces a price.

Once a trip is chosen, the **Itinerary** page plans the park days: which park each day, what to do in what order, with meals, breaks and estimated walking. A deterministic planner builds the schedule from your preferences and whatever park information you enter. The app has no live park hours, waits, crowds or availability, and says so on every plan.

> **Data integrity first.** Every price carries a status: *Verified*, *Manually entered*, *Estimated*, *Illustrative*, *Unavailable* or *Stale*. The bundled dataset is **illustrative**: plausible numbers for demonstrating the optimizer, **not real prices or offers**. Illustrative results are never ranked against real quotes, and incomplete totals are never ranked against complete ones.

## Quick start

Requires Node.js 20+ (developed on Node 22).

```bash
npm install
npm run dev          # http://localhost:3000
```

Production build:

```bash
npm run build && npm start
```

No API keys, database or environment variables are required. The app works offline with the illustrative dataset and anything you enter yourself, stored in a local JSON file. Price history and monitoring are optional and need PostgreSQL (see *Database and monitoring*).

## Working with real prices

Everything happens on the **Price data** page:

| Feature | What it does |
| --- | --- |
| **Paste quotes** | Type or paste `Key: value` lines (see below), several quotes separated by `---`. Each quote is checked and explained: what's missing, what's ambiguous, what conflicts. Nothing is inferred, and nothing is saved until you confirm (individually, or "Save all ready quotes"). |
| **Quote form** | The same fields as a form: resort, room, check-in/out, party, booking type, included tickets and dining, total, whether taxes are included (or a separately quoted tax amount), DVC points, payment and cancellation terms, and whether it's a reservation you already hold. |
| **Duplicate** | Copies any quote into the form so you can price a variant (other dates, resort, room, tickets, package vs room-only). The total and label are cleared so an old price can't be reused by accident; the original quote is kept. |
| **Bulk ticket prices** | Paste many date-specific ticket prices from a price calendar (`2027-01-04, $612` or ranges `2027-01-05 .. 2027-01-08, 598`), or a CSV/TSV table with a header (`start,end,ticket,days,age,price,use_within`). Every line is validated (dates, ticket type, duration, amount, overlaps), and nothing is saved unless all lines are valid. |
| **Re-check** | "Is this still current?": confirm a price, or record a new price or source. The previous observation is kept in the entry's **history**. Entries older than your staleness setting appear under **Needs re-checking**, and results using them are marked *Stale*. |
| **Other entries** | Nightly room rates, single ticket prices, ticket usage rules, dining plan prices, DVC point charts, DVC point costs (rental price per point, or your own points' value), and promotions with their rules. |

Paste format example (all values fictional):

```
Resort: Pop Century
Room: Standard Room
Check-in: Jan 17, 2027
Check-out: 2027-01-23
Adults: 2
Children: 0
Booking: package            # package | room only | points
Tickets: Park Hopper, 5 days
Dining: none                # none | Quick-Service Dining Plan | Disney Dining Plan
Total: $2,450.00
Taxes included: yes         # if "no", optionally add  Taxes: $123.45
Deposit: $200
Final payment due: 2026-12-18
Refundable: yes             # yes | no | partial | unknown
Free cancellation until: 2026-12-18
Cancellation penalty: $200 from 2026-12-19   # repeatable; also "100% from <date>"
Source: disneyworld.com quote
URL: https://...
Observed: 2026-10-29
```

Then on **Plan & compare**, press **Find best options**. As soon as fully real-priced options exist, illustrative ones are set aside automatically. You can also untick "Include illustrative demo prices". Tick **"Also consider DVC villas booked with points"** to include point stays.

**Saved trips** store the request and a snapshot of each run, so you can see how results change as you add or re-check prices.

## Planning with the assistant

Open **Assistant** (or press "Ask the assistant about this plan" in the planner) and describe the trip. Then:

1. **Interpretation.** The assistant turns your message into a **proposal**: a list of changes to your plan (`Stay length: 5–7 nights → 6–7 nights`, `Budget target: $4,000.00 → $5,000.00`). Each change is backed by quotes of your own words. Firm wording ("must", "can't go over") becomes a hard requirement; hedged wording ("ideally", "preferably") becomes a preference. Things it can't represent (two rooms, flights) are reported. Missing information is asked about, and defaults you haven't confirmed are marked "default" in the plan panel.
2. **Review.** Nothing changes until you press **Apply & run optimizer**, unless you turn on "Apply changes automatically".
3. **Results.** The existing optimizer runs (plus one run per comparison, e.g. "compare deluxe vs value"). The results panel is the same as the planner's.
4. **Explanation.** The assistant explains the result using a numbered list of facts produced by the optimizer, cited inline like `F3`. Every dollar amount and percentage in the AI's text is checked against those facts. If any figure doesn't match, the AI text is withheld and the facts themselves are shown, with a note saying why.

Refine conversationally: "one more night", "arrive a day earlier", "switch to All-Star Movies", "something under $4,500", "without Park Hopper Plus", "compare the same trip without the dining plan", "use DVC points". Each refinement changes only what you mention and re-runs the optimizer.

You can also edit the plan directly ("Edit plan" or "Open in full planner"), restore any earlier version from the conversation, and switch between saved conversations. Conversations are saved locally with their plan, latest results and history.

**Without an API key** the assistant runs in **basic mode**. A small deterministic interpreter understands phrases like the ones above, and explanations are the optimizer's facts. The planner itself never needs a key.

## Planning the park days (itineraries)

Open **Itinerary** and start from a saved trip, from your current plan on Plan & compare, or from the **demo** (a fictional trip with illustrative hours and waits, clearly labelled). The trip's preferred plan supplies the dates, party, resort and ticket.

1. **Your trip.** Dates, party, resort, ticket (admission days, Park Hopper or not) and any recorded ticket rules: use-within window, expiration, blocked dates, park-reservation requirement. Unknown rules are shown as unknown, never assumed.
2. **Parks.** Tick the parks you want. Optionally fix specific days to a park, or to a rest day.
3. **Attractions.** Mark each attraction *Must*, *Like*, *Maybe* (an extra if there's time) or *Skip*, and add your own activities. Nothing needs to be filled in to try it.
4. **Pace and preferences.**
   - Pace: relaxed, moderate or packed.
   - Priorities: minimize walking, avoid crossing the park, fit in as much as possible, keep it relaxed.
   - Optional: midday rest, keep 2–4 pm free, not the busiest day first, rest day.
   - Park hopping (only if the ticket has it).
   - Day start and end, meal windows, mobility, and the wait buffer used when a wait is unknown.
5. **What you already know (optional).** Park hours, dining reservations, Lightning Lane return windows you hold, park reservations, closures, your wait estimates, and crowd estimates. Each entry records its source and when you entered it, and is marked "You entered" or "Your estimate", never "Verified".
6. **Plan my days** or **Compare relaxed vs ride-focused.** Review the plan, edit anything, and plan again; unrelated choices are kept.
7. **Save.** Saving keeps the inputs (including your park information with its provenance), the plan, its score breakdown and the planner version. Planning again and saving adds a **new version**; earlier versions are never changed and can be reopened.

The plan shows each day's park and window (and what it's based on), timed activities with walking, wait and duration, meals and breaks, must-do coverage, anything that didn't fit and why, conflicts, unknowns and assumptions, and every piece of information used with its status. A **fit score** breaks down into must-do coverage, other preferences, walking and backtracking, pacing, and data certainty. It measures fit with *your stated priorities*, not how good the vacation will be.

**Plan with the assistant** opens a conversation about the itinerary. Examples:
- "Build a relaxed four-day plan."
- "Minimize walking and avoid crossing the park repeatedly."
- "Keep our afternoons flexible."
- "Move the most demanding day away from our arrival day."
- "Seven Dwarfs and Remy are must-dos, skip TRON."
- "Add our dinner reservation at 6:30 pm on Feb 3 at EPCOT."
- "What would we lose if we removed a park day?"
- "Compare a ride-focused plan with a relaxed plan."

These become proposals you review before they apply, and the planner produces the plan. Asked for current facts ("what are the park hours?"), the assistant says it doesn't have them and points to manual entry.

**What the planner can and can't promise**

- **Hard constraints are always met, or the plan says it can't meet them.** These include:
  - trip dates, ticket days, use window, expiration and blocked dates;
  - no park hopping without a Park Hopper ticket;
  - park reservations and hours you entered;
  - attraction windows and closures;
  - no overlapping activities;
  - attractions you skip.

  An independent check re-verifies every plan; a violation makes the plan "not feasible" rather than showing it as valid.
- **Must-dos are prioritized.** Ones that can't fit are listed with the reason; the plan is then marked "Some must-dos left out".
- **Without park hours you entered, the plan is provisional.** It uses your planning window, and waits use your buffer. The plan is labelled provisional, and actual waits, show times, weather and closures will change the day.
- **The result is the highest-scoring candidate found by a bounded search, not a proven optimum.** No crowd calendar is used, so no day of the week is claimed to be better.
- **No Lightning Lane availability is ever assumed or checked, and nothing is booked.**

## Database and monitoring

PostgreSQL adds durable **price history** and **saved-vacation monitoring**. Without it, everything else works as before.

### Setup

```bash
docker compose up -d db                                   # or use any PostgreSQL 14+
echo 'DATABASE_URL=postgresql://dvo:dvo@localhost:5432/dvo' >> .env.local
npm run db:migrate                                        # apply migrations (also: -- --status)
npm run db:import-json -- --dry-run                       # preview copying your JSON data
npm run db:import-json                                    # copy it (safe to re-run)
npm run dev
```

- **Migrations** are versioned and checksummed. The app never migrates on its own: if the schema is behind, it says so and asks you to run `npm run db:migrate`.
- **The JSON import** only reads your JSON file (it is never modified or deleted). Re-running it adds nothing twice and never overwrites existing rows; differences are reported. Each entry's re-check history becomes historical observations.
- **If the database is down**, pages show a clear "database unavailable" message and API calls return 503. Nothing crashes, and no data is lost.

While `DATABASE_URL` is set, all data (prices, trips, conversations) lives in PostgreSQL. Unset it to go back to the JSON file.

### Price history

Every time you add or re-check a price, an immutable **observation** is recorded with its source, URL, observation date, recording time, the full configuration (resort, room, dates, party, booking method, tickets, dining), tax treatment, payment and cancellation terms, status and assumptions. Observations are never changed or deleted (the database enforces it). Deleting a price entry only hides it. Re-checking a quote with exactly the same details records nothing: reading the same old quote again is not a new observation.

### Monitoring a trip

On **Saved trips**, press **Monitor** on a trip (monitoring is opt-in per trip). The monitor page shows:

- the tracked plan (the trip's preferred plan) with the **latest and previous observed price**, the change in $ and %, the trend, when it was last observed, and a **stale** flag;
- a **price-history chart** per *equivalent* configuration. Different configurations, all-in vs pre-tax totals, and your estimates vs quotes are never joined into one line. With one observation it says a trend needs two;
- every observation with its source and status;
- **what changed** at the last check, and a check log;
- **Is switching worth it?** (see below);
- preferences: how often (daily, weekly, or only when you ask), staleness, notification thresholds ($ or %), the smallest net benefit worth switching for, known switching fees and other non-refundable amounts, which events notify, and email.

**"Check now" is not a live price check.** A check re-evaluates the saved trip with the prices stored in the app. New prices come only from your quotes and re-checks ("Record a new observation" takes you there). No automated source is connected: Disney publishes no pricing API, and this project does not scrape Disney's site.

**Change detection** tells apart:
- a price change (new price data for the same configuration, with $ and %);
- a confirmation (same price, newer source);
- a status change;
- a change to the trip itself;
- a recalculation (rules or tax tables changed, "not a change in Disney's price");
- promotions applied, ended or possibly available;
- stale prices, missing prices, and new quotes for the same configuration;
- a cheaper like-for-like option.

### Is switching worth it?

A lower quote is not a saving until the cost of switching is subtracted. For a reservation you hold (a quote marked "a reservation I already hold", with its payment and cancellation terms), the analysis shows:

| | |
| --- | --- |
| Original cost / new cost | Your reservation's total and the alternative's |
| Price difference | Shown, but never called a saving |
| Cancellation cost today | From your recorded terms: free-cancellation date, penalty tiers, refundability, amount paid |
| Switching cost | Cancellation + known fees + other non-refundable amounts + ticket/dining change costs |
| Net difference | Price difference − switching cost |
| Due now / remaining balance | The new deposit plus fees; what's left to pay on the new booking; refund expected; what's left if you keep yours |

If any part of the switching cost is unknown (no terms recorded, refundability unknown, after the free-cancellation date with no recorded penalty, unknown ticket/dining change cost), the verdict is **"No reliable recommendation can be made"**. If a price is stale, an estimate, or the alternative isn't the same trip, the verdict is **Review**. The app never books, changes or cancels anything. You can edit every figure in the calculator.

### Scheduling and notifications

Choose one way to run checks on schedule:

- `npm run monitor` from cron (e.g. hourly; it runs monitors that are due). Add `-- --all` to check every enabled monitor now.
- `POST /api/monitoring/run` with header `x-monitor-secret: $MONITOR_CRON_SECRET`, from an external scheduler.
- `MONITOR_SCHEDULER=on`: the app itself looks for due monitors every 15 minutes while it runs.

Notifications appear in the app (🔔 and **Notifications**). There is one digest per check, and the same situation is never notified twice. Email is optional: set `SMTP_URL` on the server, then enable it under **Monitoring → Notifications** and per monitor.

### Asking the assistant about history

The assistant can answer "what's the lowest price we've recorded?", "has the price dropped?" or "is it worth switching?" from recorded observations and the same switching arithmetic. Its answers pass the same figure checks as before, so it can't invent a price drop or call a price difference a saving. In JSON mode it uses each entry's re-check history.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DVO_STORE_PATH` | `./data/local-store.json` | JSON-mode file for your prices, their history, saved trips and conversations (git-ignored). Also the default source for `db:import-json`. |
| `ANTHROPIC_API_KEY` | none | Enables the AI assistant (Claude). Server-side only, never sent to the browser. |
| `AI_PROVIDER` | `anthropic` if a key is set, else `rules` | Set `rules` to force basic mode. |
| `AI_MODEL` | `claude-opus-5-5` | Model used by the assistant. |
| `AI_EFFORT` | `medium` | Interpretation effort (`low`…`max`); explanations use `low`. |
| `AI_FALLBACKS` | on | Server-side refusal fallbacks; set `off` to disable. |
| `DATABASE_URL` | none | PostgreSQL connection string. Enables price history and monitoring; all data then lives in the database. |
| `MONITOR_SCHEDULER` | off | `on` runs due monitor checks inside the app every 15 minutes. |
| `MONITOR_CRON_SECRET` | none | Enables `POST /api/monitoring/run` for an external scheduler (header `x-monitor-secret`). |
| `SMTP_URL` | none | SMTP connection URL for optional email notifications (server-side only). |
| `NOTIFY_EMAIL_FROM` | `no-reply@localhost` | Sender address for notification emails. |
| `TEST_DATABASE_URL` | none | Runs the PostgreSQL test suites (each test file uses its own schema). |

Copy `.env.example` to `.env.local` and restart the app after changing these.

## Tests and benchmarks

```bash
npm test             # unit, scenario, property, AI and monitoring tests (Vitest; AI providers are mocked)
TEST_DATABASE_URL=postgresql://dvo:dvo@localhost:5432/dvo_test npm test   # also the PostgreSQL suites
npm run typecheck    # TypeScript, strict mode
npm run bench        # optimizer timings for default, wide and widest searches
```

308 tests in total: 278 run without a database, and the 30 PostgreSQL tests run when `TEST_DATABASE_URL` is set.

The tests cover:

- **Pricing:** cost calculation, package double counting, quote tax handling, tax jurisdictions, promotion eligibility, price-source resolution and staleness.
- **Rules:** hard constraints, budgets, flexible dates, trust partitioning, tie-breaks, savings and switching costs.
- **New features:** payment schedules and cancellation exposure, ticket usability, DVC point stays, observation history.
- **Importers:** the paste and bulk importers.
- **Scenarios:** a known-scenario regression suite built from fictional, clearly labelled quotes.
- **Pruning:** a randomized property test proving that pruning never changes results.
- **Monitoring (pure, no database):**
  - switching-cost calculations, including unknown cancellation conditions
  - change detection: increases and decreases with $ and %, thresholds, confirmations vs price changes, recalculations, configuration changes, promotions, stale and missing prices, new quotes, illustrative vs real
  - equivalent vs non-equivalent series
- **PostgreSQL (with `TEST_DATABASE_URL`):**
  - migrations and checksums
  - persistence of prices, trips and conversations
  - append-only and duplicate observations
  - JSON import: dry run, history, idempotence, no overwrites, broken files
  - monitoring end to end: checks, scheduled runs without double runs, notifications and dedupe, email success and failure, adapters
  - saved itineraries: versions, immutability, link to trips, JSON import
  - failure handling: database down, not configured
- **Itineraries (pure, no database):**
  - dates, tickets and park days; Park Hopper; operating hours and early entry; attraction windows and closures
  - no overlaps, with travel time between activities; meals and breaks; must-dos and exclusions; hard vs soft constraints
  - infeasible requests; missing, stale and illustrative data; user entries can't claim "verified"
  - waits and crowds as uncertain inputs; Lightning Lane windows and unknown availability; park-day allocation
  - deterministic scoring and reproducibility; relaxed vs ride-focused comparison
  - a randomized check that no invalid plan is presented as feasible; bounded search on a 15-day hopper trip
  - API validation, server-side re-planning on save, and versioning
  - saved itineraries in JSON (and older JSON files without itineraries)
- **AI layer (mocked providers, no network):**
  - natural-language parsing (basic mode)
  - patch application and schema validation
  - hard vs soft constraints
  - preservation across refinements
  - comparison variants
  - grounding, which proves the AI can't introduce prices or overwrite optimizer results
  - invalid output, provider failures and rate limits
  - missing configuration
  - Anthropic request shape and error mapping
  - answers about recorded price history and switching, with invented price drops rejected
  - itinerary requests: basic-mode phrasings, validated patches (no reservation time the user didn't state), proposal/apply, auto-apply, comparisons, fallbacks, Claude request shape, explanations with invented times or durations rejected

## Project layout

```
src/
  domain/              Pure, framework-free business logic (the core)
    types.ts           Data model: catalog, prices with provenance and history, terms, requests, results
    provenance.ts      Price statuses, staleness, trust ranking
    schema.ts          Zod validation of trip requests (the contract the AI layer produces)
    pricing/           resolve.ts (pick the best source), calculate.ts (cost lines), promotions.ts,
                       payments.ts (schedule & cancellation exposure), ticketUsage.ts (usability)
    optimizer/         optimize.ts (enumerate → constrain → bound → price → rank → award),
                       bound.ts (lower bounds for pruning), constraints.ts, scoring.ts
  itinerary/           catalog.ts (parks, areas, attractions; approximate), types.ts (validated inputs with provenance, outputs),
                       context.ts (trip context, demo), engine.ts (allocation, scheduling, scoring, verification, comparison)
  db/                  PostgreSQL: pool, migrations, observation queries, JSON import
  monitoring/          fingerprint.ts (equivalent configurations), series.ts (history), detect.ts (change detection),
                       switching.ts (switching costs), service.ts (checks, scheduling), notify.ts, adapters.ts
  data/                Catalog, reference estimates, illustrative dataset, store facade + backends/ (json, pg), sources registry,
                       entrySchema.ts (validation), observations.ts (re-check history),
                       importers/ (paste-quote and bulk ticket parsers)
  ai/                  The assistant: types.ts (proposal schema), patch.ts (apply/diff/describe), digest.ts (optimizer facts),
                       grounding.ts (figure checks), prompts.ts, service.ts (workflow), providers/ (anthropic, rules, config),
                       itinerary/ (itinerary proposals, basic-mode interpreter, planner facts, workflow)
  app/                 Next.js pages and API routes (/api/optimize, /api/prices, /api/prices/recheck, /api/trips,
                       /api/assistant, /api/conversations, /api/monitoring/*, /api/notifications/*,
                       /api/itinerary/{plan,context}, /api/itineraries/*)
  components/          React UI (prices/: price-data workflows; monitoring/; itinerary/: planner, plan view, known-info editor)
scripts/               bench.ts, db-migrate.ts, import-json.ts, monitor.ts
tests/                 Vitest suites and hand-checkable fixtures (all prices fictional)
docs/                  ARCHITECTURE.md (design & rules), ROADMAP.md (milestones and status)
```

## Known limitations

- **No live pricing.** Disney offers no public pricing API, and its site terms prohibit automated access. Real prices come only from what you enter.
- **Catalog:** 30 accommodations: 17 Disney hotels, 7 DVC villa resorts, the Swan and Dolphin, and 3 generic off-property slots. It is not every resort or room view. Occupancy is conservative; verify on the booking site.
- **Taxes are estimates:** Orange County 12.5% lodging / 6.5% sales, Osceola County 13.5% / 7.5%. Jurisdiction is catalog data. The All-Star resorts are documented as Osceola. Animal Kingdom Lodge and Kidani Village are unconfirmed, so the higher Osceola rate is used. A tax-inclusive quote always overrides the estimate.
- **DVC:** point stays are assumed to carry no per-stay lodging tax. Booking windows, banking and borrowing, and dining plans for point stays are not modeled.
- **Ticket rules** are only enforced where recorded. Unknown rules are reported, never assumed. Park-reservation availability is not checked.
- **Payment terms:** installments are supported by the data model and API, but not yet editable in the forms.
- **Simplifications:** promotions don't stack; a dining plan replaces all pay-as-you-go food; a package without a quote is priced as the sum of its parts; one room per party.
- **Assistant:**
  - The Claude provider has been tested only against a mocked SDK client in this environment; no live API call has been made.
  - Basic mode understands a limited set of phrasings.
  - The assistant can't express things the optimizer doesn't model: several rooms, flights. (Park days are planned on the Itinerary page.)
  - Explanations deliberately won't state figures the optimizer didn't produce, even when they are simple arithmetic.
- **Monitoring:**
  - It only knows the prices you record. It can't see live prices or availability: there is no authorized automatic source (the adapter interface exists, with none registered).
  - It requires PostgreSQL.
  - The tracked configuration is the trip's preferred plan.
  - Switching analysis assumes cancel-and-rebook; Disney can sometimes modify a booking or apply an offer instead.
- **Imported history:** the JSON store kept only price, date, status and source for earlier observations, so other details of those observations are assumed unchanged (stated on each record).
- **Itineraries:**
  - **No live park data.** No park hours, closures, wait times, crowd levels, show times, or park-reservation and Lightning Lane availability, because there is no authorized source. You enter what you know; everything else is unknown and labelled.
  - **Approximate catalog.** About 40 long-running attractions with approximate durations and a schematic map for walking estimates. It may be out of date. Height and accessibility requirements, parades, fireworks and character meets are not modelled; add them as your own activities.
  - **Simplified planning.** One planned hop per day, around midday. Early entry is used only when you enter it. Breakfast is not planned.
  - **Bounded search.** A beam search over park-day allocations, then three route orderings per day: the best candidate found, not a proven optimum.
- Single-user. No accounts.

For design decisions and the full calculation rules, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For status and next steps, see [docs/ROADMAP.md](docs/ROADMAP.md).

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

No API keys or environment variables are required. The app works offline with the illustrative dataset and anything you enter yourself.

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

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DVO_STORE_PATH` | `./data/local-store.json` | Where your entered prices, their history, and saved trips are stored (git-ignored). |

## Tests and benchmarks

```bash
npm test             # 122 unit, scenario and property tests (Vitest)
npm run typecheck    # TypeScript, strict mode
npm run bench        # optimizer timings for default, wide and widest searches
```

The tests cover:

- **Pricing:** cost calculation, package double counting, quote tax handling, tax jurisdictions, promotion eligibility, price-source resolution and staleness.
- **Rules:** hard constraints, budgets, flexible dates, trust partitioning, tie-breaks, savings and switching costs.
- **New features:** payment schedules and cancellation exposure, ticket usability, DVC point stays, observation history.
- **Importers:** the paste and bulk importers.
- **Scenarios:** a known-scenario regression suite built from fictional, clearly labelled quotes.
- **Pruning:** a randomized property test proving that pruning never changes results.

## Project layout

```
src/
  domain/              Pure, framework-free business logic (the core)
    types.ts           Data model: catalog, prices with provenance and history, terms, requests, results
    provenance.ts      Price statuses, staleness, trust ranking
    schema.ts          Zod validation of trip requests (the contract a future AI layer will produce)
    pricing/           resolve.ts (pick the best source), calculate.ts (cost lines), promotions.ts,
                       payments.ts (schedule & cancellation exposure), ticketUsage.ts (usability)
    optimizer/         optimize.ts (enumerate → constrain → bound → price → rank → award),
                       bound.ts (lower bounds for pruning), constraints.ts, scoring.ts
  data/                Catalog, reference estimates, illustrative dataset, JSON store, sources registry,
                       entrySchema.ts (validation), observations.ts (re-check history),
                       importers/ (paste-quote and bulk ticket parsers)
  app/                 Next.js pages and API routes (/api/optimize, /api/prices, /api/prices/recheck, /api/trips)
  components/          React UI (components/prices/ holds the price-data workflows)
scripts/bench.ts       Benchmark
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
- Single-user, local storage. No accounts, scheduling or notifications yet.

For design decisions and the full calculation rules, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For status and next steps, see [docs/ROADMAP.md](docs/ROADMAP.md).

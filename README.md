# Disney Vacation Optimizer

A personal tool that compares Walt Disney World vacation configurations by **total trip cost**, with every number traceable to its source.

You describe the trip (party, flexible dates, resorts, park days, tickets, dining, transport, budget). The optimizer enumerates every valid combination of arrival date, stay length, resort and room, ticket type, booking method (package or separate) and dining plan. It then prices each one deterministically and ranks the results. It shows:

- **Cheapest**: the lowest total among fully priced options.
- **Best value**: the highest score under adjustable, explicit weights (price, resort preference, convenience, ticket, dining, dates).
- **Best alternative to your plan**: the biggest *like-for-like* saving versus your own preferred plan (same nights, park days, tickets and dining).
- A flexible-date calendar, full cost breakdowns, and savings against your plan.

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

No API keys or environment variables are required. The app works fully offline with the illustrative dataset and anything you enter yourself.

### Using real prices

1. Open **Price data** and add what you see on a booking page. The most useful entry is a **stay/package quote**: resort, room, dates, party, included tickets and dining, and the total *including taxes*. You can also add nightly room rates, ticket prices (Disney or authorized third-party), dining plan prices and promotions, each with its rules.
2. Back on **Plan & compare**, press **Find best options**. As soon as fully real-priced options exist, illustrative ones are set aside automatically. You can also untick "Include illustrative demo prices".
3. **Save trip** stores the request plus a snapshot of the results. Each later save adds a new snapshot, so you can see how options change as prices are updated.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DVO_STORE_PATH` | `./data/local-store.json` | Where your entered prices and saved trips are stored (git-ignored). |

## Tests

```bash
npm test             # 66 unit + integration tests (Vitest)
npm run typecheck    # TypeScript, strict mode
```

The tests cover cost calculation, package double-counting, tax-inclusive quotes, promotion eligibility (each rule), price-source resolution and staleness, date arithmetic, hard constraints, budget handling, flexible dates, trust partitioning, ranking tie-breaks, savings baselines, booking-method collapsing, and the bundled dataset's labelling.

## Project layout

```
src/
  domain/            Pure, framework-free business logic (the core)
    types.ts         Data model: catalog, prices with provenance, requests, results
    provenance.ts    Price statuses, staleness, trust ranking
    schema.ts        Zod validation of trip requests (the contract a future AI layer will produce)
    pricing/         resolve.ts (pick the best source), calculate.ts (cost lines), promotions.ts (eligibility)
    optimizer/       optimize.ts (enumerate → constrain → price → rank → award), constraints.ts, scoring.ts
  data/              Data layer: catalog, reference estimates, illustrative dataset, JSON store, sources registry
  app/               Next.js pages (planner, price data, saved trips) and API routes
  components/        React UI
tests/               Vitest suites and hand-checkable fixtures
docs/                ARCHITECTURE.md (design & rules), ROADMAP.md (assessment, milestones, next steps)
```

## Known limitations

- **No live pricing.** Disney offers no public pricing API, and its site terms prohibit automated access. Real prices come only from what you enter. See `docs/ROADMAP.md` for legitimate options.
- **Small catalog:** 7 Disney resorts (Value, Moderate, Deluxe) plus a generic off-property slot, mostly standard rooms. Occupancy figures are conservative and should be verified.
- **Estimates:** lodging tax (12.5%), sales tax (6.5%) and parking/transport costs are documented estimates. Some resorts are in Osceola County, where tax may differ. A tax-inclusive quote always overrides the estimate.
- **Simplifications:** promotions are assumed not to stack; a dining plan is assumed to replace all pay-as-you-go food; package prices without a quote are the sum of their parts; one room per party.
- Single-user, local storage. No accounts, scheduling or notifications yet.

For design decisions and the full calculation rules, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For the plan, see [docs/ROADMAP.md](docs/ROADMAP.md).

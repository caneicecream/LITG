# Project state

_Last validated: 2026-10-31 (branch `claude/cloud-session-local-files-hm0edd`)._

## What exists

| Area | Where | Notes |
| --- | --- | --- |
| Price optimizer | `src/domain/` | Enumerate → constrain → bound/prune → price → rank → award; savings vs the preferred plan; switching cost vs a held reservation |
| Data and stores | `src/data/`, `src/db/` | JSON default; PostgreSQL optional (migrations 001–003); JSON→PG import |
| Assistant | `src/ai/` | Claude provider (mocked in tests) or keyless basic mode; trip and itinerary proposals; grounded explanations |
| Monitoring | `src/monitoring/` | PostgreSQL only; append-only checks; change detection; switching analysis; notifications |
| Itinerary | `src/itinerary/` | Catalog (68 entries), planner, comparison, park-hours paste importer (`importers/hours.ts`) |
| Security | `src/proxy.ts`, `src/lib/errors.ts` | Same-origin protection for writes; redaction; generic 500s |
| Docs | `README.md`, `docs/` | ARCHITECTURE, ROADMAP, PRODUCT_VISION, DECISIONS, DATA_SOURCES, this file |

## Latest validated results (2026-10-31)

- `npm test`: 358 tests with `TEST_DATABASE_URL` (all pass); 328 pass and 30 skip without a database.
- `npm run typecheck` and `npm run build` pass.
- `npm run e2e` passes against a JSON-mode server and a PostgreSQL-mode server.
- `npm run bench`: default search 375 ms, wide search 5.2 s. `npm run perf`: itineraries 8–127 ms; save/reopen 13–19 ms; history query 9 ms.
- No live Claude call has ever been made (no API key). Provider behaviour is tested against a mocked SDK client.

## Known limitations and defects

- **No live data.** No live pricing or park information; candidate park-data hosts are blocked by the session network policy (see DATA_SOURCES.md).
- **Estimates.** Attraction durations, walking distances and arrive-early times are estimates; heights and advisories are secondary-source reports.
- **Itinerary simplifications.** One hop per day, no breakfast planning, no weather.
- **Single-user.** No authentication or backups; not for public deployment.
- **Wide price search** takes about 5 s.

## Environment notes (cloud container)

- Local PostgreSQL 16: `pg_ctlcluster 16 main start` (it can stop when the container restarts). Role `dvo`/`dvo`; databases `dvo_dev`, `dvo_test`.
- Outbound network is restricted. Web search works; most hosts (Wikipedia, ThemeParks.wiki, Queue-Times, RideSpy) return a proxy 403.
- Kill dev servers by process name (`next-server`); `pkill -f` can match the calling shell.

## Next priorities

1. **Real-trip validation.** Use the app for an actual trip, then turn discrepancies into regression tests. Needs the user's quotes and park hours.
2. **A permitted park-schedule source,** if the user allows the hosts and the terms check out (DATA_SOURCES.md, open questions 1–2).
3. **Show times paste importer.** Same pattern as park hours, to reduce the remaining manual entry.
4. **A user-maintained catalog override** for durations and heights, with provenance.

# Decisions

Significant decisions, why they were made, and what would justify revisiting them. Newest last.

| # | Decision | Rationale | Revisit if |
| --- | --- | --- | --- |
| 1 | One Next.js + TypeScript app; pure domain code in `src/domain` | One language end to end; types shared by engine, API and UI | Heavy numerical work needs another runtime |
| 2 | No scraping; prices come from the user, labelled illustrative data is for demos | Disney's terms; trust contract | An authorized feed becomes available |
| 3 | Money as integer cents; provenance status on every value; illustrative never ranked with real prices; incomplete never ranked with complete | Correctness and honesty | — |
| 4 | Lower-bound pruning in the optimizer, proven equivalent by a randomized test | Wide search went from 45 s to about 5 s | Search space grows again |
| 5 | AI proposes nullable patches; deterministic code applies, validates, optimizes; explanations are grounded (money, ratios, numbers, unsupported claims) | AI never becomes a source of financial or schedule truth | — |
| 6 | JSON store by default; PostgreSQL optional via `DATABASE_URL`; hand-written checksummed migrations, no ORM | Zero setup for personal use; reviewable SQL; trigger-enforced append-only tables | Multi-user deployment |
| 7 | Price observations and itinerary versions are append-only; monitor checks never create observations | Never rewrite history; a recalculation isn't a price check | — |
| 8 | Switching analysis returns "no reliable recommendation" when any switching cost is unknown | A price difference isn't a saving | — |
| 9 | Itinerary engine: bounded beam search over park-day allocations, plus minute-by-minute simulation of 4 route orderings, plus an independent constraint check; the result is the "best candidate found" | Explainable, testable, fast (under 150 ms on 15-day trips) | Plans regularly need manual rearranging |
| 10 | Must-do lateness penalty (6 points per hour) in day ordering; not part of the reported fit score | Earlier must-dos are weighed against walking, not forced; score semantics unchanged | Real trips show must-dos still landing too late or too early |
| 11 | Catalog fields carry their basis (curated / estimate / reported); advisories are never applied as closures | Uncertain facts stay visible and user-correctable | An authorized attraction-status source exists |
| 12 | Same-origin proxy for API writes; no authentication; documented as unsafe for public exposure | Prevents CSRF against a local instance; accounts are out of scope | Any shared or hosted deployment, which needs auth first |
| 13 | (2026-10-31) Park hours via a paste importer with review, instead of a live integration | Candidate hosts are blocked and terms unverified; missing hours are the main reason plans are provisional; pasting from the official calendar is permitted and fast | A permitted schedule source is approved and reachable (see DATA_SOURCES.md) |

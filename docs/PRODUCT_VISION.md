# Product vision

**Goal:** help a person make better Walt Disney World vacation decisions with less effort: when to go, where to stay, which tickets, whether a deal or a switch really saves money, how to allocate park days, and how to use time in the parks. Show trade-offs, not one optimized number. The cheapest trip isn't automatically the best trip, and the fullest itinerary isn't automatically the best itinerary.

## Trust contract (non-negotiable)

- **Never invent** prices, discounts, park hours, attraction status, waits, crowds, availability (reservations, Lightning Lane), ticket rules, cancellation terms, or source verification.
- **Every value says what it is:** verified, entered by the user, estimated, predicted, illustrative, stale, or unknown.
  - A stored observation is not a current one.
  - A recalculation is not a live check.
  - A feasible itinerary is not necessarily a realistic one.
  - A price difference is not a saving.
  - An incomplete price never wins because missing costs make it look cheaper.
- **When information is missing,** say what's missing and how to supply it. Continue with a clearly labelled provisional result where possible.
- **AI's role:** it interprets and explains. Deterministic code computes every price, total, score and schedule, reproducibly from recorded inputs.

## Scope boundaries

- Personal, single-user tool. No accounts, subscriptions, billing or automated booking or cancellation.
- No scraping of Disney sites, no bypassing access controls, no undocumented private endpoints.
- External data only from documented, permitted sources, through the existing adapter interfaces, with attribution, timestamps and manual fallbacks.
- PostgreSQL stays optional. Everything core works without an AI key or a database.
- Prefer a few high-value, tested improvements over many superficial features. Don't redesign working systems without evidence.

## How success is judged

Recommendations survive manual review. Comparisons include all relevant costs. Missing information is handled honestly. Itineraries satisfy hard constraints and need little rearranging. Results are explainable and reproducible. Important workflows work without AI or a database. Performance stays practical.

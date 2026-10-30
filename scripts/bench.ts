/**
 * Optimizer benchmark: `npm run bench`.
 * Runs representative requests against the catalog + illustrative data and
 * reports configuration counts and timings (median of several runs).
 */
import { CATALOG } from "../src/data/catalog";
import { defaultTripRequest } from "../src/data/defaults";
import { ILLUSTRATIVE_DATA } from "../src/data/illustrative";
import { TAX_RATES, TRANSPORT } from "../src/data/reference";
import { mergePriceData } from "../src/data/sources";
import { optimize } from "../src/domain/optimizer/optimize";
import type { TripRequest } from "../src/domain/types";

const data = mergePriceData([{ taxRates: TAX_RATES, transport: TRANSPORT }, ILLUSTRATIVE_DATA]);
const now = new Date("2026-10-30T12:00:00Z");
const base = defaultTripRequest();

const scenarios: { name: string; request: TripRequest }[] = [
  { name: "default (Jan 4–Feb 20, 5–7 nights, 5 park days)", request: base },
  {
    name: "wide (120-day arrival window, 4–10 nights, 3 park days, all tickets)",
    request: {
      ...base,
      dates: { earliestArrival: "2027-01-04", latestDeparture: "2027-05-14", minNights: 4, maxNights: 10 },
      tickets: { ...base.tickets, parkDays: 3, allowedOptions: ["base", "park_hopper", "park_hopper_plus"] },
      resorts: { ...base.resorts, requireOnProperty: false },
    },
  },
  {
    name: "widest allowed (120-day window, 1–14 nights, no park days)",
    request: {
      ...base,
      dates: { earliestArrival: "2027-01-04", latestDeparture: "2027-05-18", minNights: 1, maxNights: 14 },
      tickets: { ...base.tickets, parkDays: 0 },
      resorts: { ...base.resorts, requireOnProperty: false },
    },
  },
];

const runs = Number(process.env.BENCH_RUNS ?? 3);
const extra = (process.env.BENCH_OPTS ? JSON.parse(process.env.BENCH_OPTS) : {}) as Record<string, unknown>;
for (const s of scenarios) {
  const times: number[] = [];
  let stats: unknown;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = optimize({ catalog: CATALOG, data, request: s.request, now, ...extra });
    times.push(performance.now() - t0);
    stats = r.stats;
  }
  times.sort((a, b) => a - b);
  console.log(`${s.name}\n  median ${Math.round(times[Math.floor(times.length / 2)]!)} ms  (runs: ${times.map((t) => Math.round(t)).join(", ")})\n  stats ${JSON.stringify(stats)}`);
}

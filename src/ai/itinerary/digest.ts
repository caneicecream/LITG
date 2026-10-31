import { formatShortDate } from "@/domain/dates";
import { attractionById, parkById } from "@/itinerary/catalog";
import { compareSummary, fmtTime, type ItineraryComparison } from "@/itinerary/engine";
import type { Itinerary } from "@/itinerary/types";
import type { Fact } from "../types";
import { deterministicExplanation } from "../grounding";

/**
 * Facts about an itinerary for the assistant to explain. Every time, duration
 * and score the assistant may mention appears here; the planner produced them.
 */
export function itineraryFacts(it: Itinerary, variants: { label: string; differs: string[]; itinerary: Itinerary }[] = [], details: ItineraryComparison | null = null): Fact[] {
  const out: string[] = [];
  const add = (t: string) => out.push(t);
  add(`Itinerary: ${it.headline}`);
  if (it.demo) add("This is a DEMONSTRATION: its park hours, waits and reservation are illustrative, not real schedules or availability.");
  if (it.provisional && !it.demo) add("The plan is provisional: it relies on assumed hours or waits, or unresolved reservations, as listed below.");
  for (const r of it.infeasibleReasons) add(`Not feasible: ${r}`);
  for (const c of it.conflicts) add(`Conflict or adjustment: ${c}`);
  if (it.score) {
    add(
      `Fit score ${it.score.total}/100. It measures fit with the stated priorities and data certainty, not how good the vacation will be. Components: ${it.score.components.map((c) => `${c.label} ${c.score}/100 (weight ${c.weightPct}%; ${c.detail})`).join("; ")}.`,
    );
  }
  add(`Must-dos scheduled: ${it.coverage.must.scheduled} of ${it.coverage.must.total}. "Would like" items scheduled: ${it.coverage.want.scheduled} of ${it.coverage.want.total}.`);
  for (const m of it.coverage.must.missing) add(`Must-do not scheduled: ${m.name} (${m.reason}).`);
  for (const d of it.days) {
    if (d.kind === "rest" || d.kind === "no_park") {
      add(`${formatShortDate(d.date)}: no park (${d.window.detail.replace(/\.$/, "")}).`);
      continue;
    }
    const rides = d.items.filter((i) => i.kind === "attraction" || i.kind === "lightning_lane" || i.kind === "custom");
    const musts = rides.filter((i) => i.priority === "must").map((i) => i.title);
    const others = rides.filter((i) => i.priority !== "must").map((i) => i.title);
    const meals = d.items.filter((i) => i.kind === "meal" || i.kind === "dining").map((i) => `${i.title} at ${fmtTime(i.start)}`);
    const rests = d.items.filter((i) => i.kind === "break" || i.kind === "flexible").reduce((t, i) => t + (i.end - i.start), 0);
    add(
      `${formatShortDate(d.date)}: ${d.parkIds.map((p) => parkById.get(p)?.name).join(" then ")}, ${fmtTime(d.window.start)} to ${fmtTime(d.window.end)} (${d.window.basis === "park_hours" ? "park hours you entered" : d.window.basis === "illustrative_hours" ? "illustrative hours" : "your planning window; park hours unknown"}). ` +
        `${musts.length ? `Must-dos: ${musts.join(", ")}. ` : ""}${others.length ? `Also: ${others.join(", ")}. ` : ""}${meals.length ? `Meals: ${meals.join("; ")}. ` : ""}About ${d.walkingMin} min walking (estimated), ${rests} min of breaks and free time, ${d.backtracks} backtrack${d.backtracks === 1 ? "" : "s"}.`,
    );
  }
  for (const u of it.unknowns) add(`Unknown: ${u}`);
  for (const a of it.assumptions) add(`Assumption: ${a}`);
  add(`Search: ${it.search.note}`);

  const [a, b] = variants;
  if (a && b) {
    add(`Comparison "${a.label}" vs "${b.label}" (same trip and park information; preferences differ: ${a.label}: ${a.differs.join(", ")}; ${b.label}: ${b.differs.join(", ")}). ${compareSummary(a.itinerary, b.itinerary).join(" ")}`);
    const ids = (x: Itinerary) => new Set(x.days.flatMap((d) => d.items.flatMap((i) => (i.attractionId ? [i.attractionId] : []))));
    const ia = ids(a.itinerary);
    const ib = ids(b.itinerary);
    const onlyA = [...ia].filter((x) => !ib.has(x)).map((x) => attractionById.get(x)?.name);
    const onlyB = [...ib].filter((x) => !ia.has(x)).map((x) => attractionById.get(x)?.name);
    add(`Only in "${a.label}": ${onlyA.join(", ") || "nothing"}. Only in "${b.label}": ${onlyB.join(", ") || "nothing"}.`);
    if (details) {
      add(`Comparison details ("${a.label}" vs "${b.label}"): ${details.rows.map((r) => `${r.label}: ${r.a} vs ${r.b}`).join("; ")}.`);
      if (details.factDifferences.length) add(`Comparison caution: ${details.factDifferences.join(" ")}`);
      for (const t of details.tradeoffs) add(`Comparison trade-off: ${t}`);
    }
  }
  return out.map((text, i) => ({ id: `F${i + 1}`, text }));
}

/** Numbers in assistant text must all appear in the facts (times, minutes, counts, scores). */
export function checkItineraryNumbers(text: string, facts: Fact[]): string[] {
  const allowed = new Set(facts.flatMap((f) => [...f.text.replace(/\bF\d+\b/g, "").matchAll(/\d+(?::\d{2})?/g)].map((m) => m[0])));
  return [...text.replace(/\[F\d+\]/g, "").matchAll(/\d+(?::\d{2})?/g)].map((m) => m[0]).filter((x) => !allowed.has(x));
}

/** The facts the deterministic explanation shows for an itinerary question. */
export function itineraryExplanation(facts: Fact[], question: string, diff: string[]): { message: string; cited: string[] } {
  const q = question.toLowerCase();
  const pick = (pred: (t: string) => boolean, max = 20) => facts.filter((f) => pred(f.text)).slice(0, max);
  const chosen = [
    ...pick((t) => t.startsWith("This is a DEMONSTRATION") || t.startsWith("Itinerary:") || t.startsWith("Not feasible")),
    ...pick((t) => t.startsWith("Comparison") || t.startsWith("Only in")),
    ...(q.match(/score|why/) ? pick((t) => t.startsWith("Fit score")) : []),
    ...pick((t) => t.startsWith("Must-do")),
    ...pick((t) => /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d/.test(t)),
    ...pick((t) => t.startsWith("Conflict")),
    ...pick((t) => t.startsWith("Unknown:"), 3),
  ];
  const unique = [...new Map(chosen.map((f) => [f.id, f])).values()];
  if (!unique.length) return deterministicExplanation(facts, { question, diff });
  const lead = diff.length ? `I applied: ${diff.join("; ")}.\n\n` : "";
  return { message: lead + unique.map((f) => `• ${f.text} [${f.id}]`).join("\n"), cited: unique.map((f) => f.id) };
}

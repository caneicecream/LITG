import type { Cents } from "@/domain/money";
import type { Explanation, Fact } from "./types";

/**
 * Grounding checks: AI text may only state money amounts, percentages and
 * scores that appear in the facts digest (or that the user said themselves).
 * Anything else is treated as an invented figure and the AI text is replaced
 * by a deterministic explanation.
 */

/** Money amounts written with a $ sign or "dollars", in cents. */
export function moneyIn(text: string): { raw: string; cents: Cents }[] {
  const out: { raw: string; cents: Cents }[] = [];
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\s?(?:k|thousand)\b)?|(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?dollars?\b/gi;
  for (const m of text.matchAll(re)) {
    const whole = Number((m[1] ?? m[4])!.replace(/,/g, ""));
    const fracStr = m[2] ?? m[5];
    const frac = fracStr ? Number(fracStr.padEnd(2, "0")) : 0;
    const cents = m[3] ? Math.round((whole + frac / 100) * 1000) * 100 : whole * 100 + frac;
    out.push({ raw: m[0].trim(), cents });
  }
  return out;
}

/** Percentages ("20%", "12.5 percent") and scores ("93.4/100"). */
export function ratiosIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?(?:%|percent\b)/gi)) out.push(`${Number(m[1])}%`);
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?\/\s?100\b/g)) out.push(`${Number(m[1])}/100`);
  return out;
}

export interface GroundingCheck {
  ok: boolean;
  unknownAmounts: string[];
  unknownRatios: string[];
  unknownFacts: string[];
}

export function checkGrounding(text: string, facts: Fact[], cited: string[], extraAllowedCents: Iterable<Cents> = []): GroundingCheck {
  const factText = facts.map((f) => f.text).join("\n");
  const allowed = new Set<Cents>([...moneyIn(factText).map((m) => m.cents), ...extraAllowedCents]);
  const allowedRatios = new Set(ratiosIn(factText));
  const ids = new Set(facts.map((f) => f.id));
  const inlineCitations = [...text.matchAll(/\[(F\d+)\]/g)].map((m) => m[1]!);
  const unknownAmounts = moneyIn(text).filter((m) => !allowed.has(m.cents)).map((m) => m.raw);
  const unknownRatios = ratiosIn(text).filter((r) => !allowedRatios.has(r));
  const unknownFacts = [...cited, ...inlineCitations].filter((id) => !ids.has(id));
  return { ok: unknownAmounts.length === 0 && unknownRatios.length === 0 && unknownFacts.length === 0, unknownAmounts, unknownRatios, unknownFacts };
}

/** Accept the AI explanation only if every figure in it comes from the facts. */
export function groundExplanation(
  ai: Explanation | null,
  facts: Fact[],
  context: { question: string; diff: string[] },
  extraAllowedCents: Iterable<Cents> = [],
): { message: string; cited: string[]; grounded: "ai" | "deterministic"; rejectedReason?: string } {
  if (ai && ai.message.trim()) {
    const check = checkGrounding(ai.message, facts, ai.citedFacts, extraAllowedCents);
    if (check.ok) return { message: ai.message.trim(), cited: [...new Set(ai.citedFacts)], grounded: "ai" };
    const reasons = [
      ...(check.unknownAmounts.length ? [`amounts not produced by the optimizer: ${check.unknownAmounts.join(", ")}`] : []),
      ...(check.unknownRatios.length ? [`figures not in the results: ${check.unknownRatios.join(", ")}`] : []),
      ...(check.unknownFacts.length ? [`citations to unknown facts: ${check.unknownFacts.join(", ")}`] : []),
    ];
    return { ...deterministicExplanation(facts, context), grounded: "deterministic", rejectedReason: `The AI explanation was withheld because it contained ${reasons.join("; ")}.` };
  }
  return { ...deterministicExplanation(facts, context), grounded: "deterministic" };
}

/**
 * Explanation built only from facts (used without an AI provider, or when the
 * AI text fails the grounding check). Picks the facts that answer the common
 * questions: what changed, what won, by how much, and what is uncertain.
 */
export function deterministicExplanation(facts: Fact[], context: { question: string; diff: string[] }): { message: string; cited: string[] } {
  const pick = (pred: (f: Fact) => boolean, max = 1) => facts.filter(pred).slice(0, max);
  const q = context.question.toLowerCase();
  // Price-history and switching questions are answered from those facts alone.
  const aboutHistory = /record|histor|observ|trend|drop|went (up|down)|price change|has the price/.test(q);
  const aboutSwitching = /switch|rebook|cancel|worth/.test(q);
  const focused = [
    ...(aboutHistory ? pick((f) => f.text.startsWith("Price history"), 8) : []),
    ...(aboutSwitching ? pick((f) => f.text.startsWith("Switching analysis"), 8) : []),
  ];
  const chosen: Fact[] = focused.length ? [...pick((f) => f.text.startsWith("These results use ILLUSTRATIVE")), ...focused] : [
    ...pick((f) => f.text.startsWith("These results use ILLUSTRATIVE")),
    ...pick((f) => f.text.startsWith("No option could be fully priced")),
    ...pick((f) => f.text.startsWith("Before this change"), 3),
    ...pick((f) => f.text.startsWith("Comparison "), 6),
    ...pick((f) => f.text.startsWith("Cheapest option:")),
    ...pick((f) => f.text.startsWith("Only one option is fully priced")),
    ...pick((f) => f.text.startsWith("Best-value option:")),
    ...pick((f) => f.text.startsWith("Best alternative")),
    ...(q.match(/earlier|later|date|arriv|cheaper day/) ? pick((f) => f.text.startsWith("Arriving ") || f.text.startsWith("Cheapest arrival"), 3) : []),
    ...(q.match(/why|explain|break ?down|cost/) ? pick((f) => f.text.startsWith("Optimizer's reasoning") || f.text.startsWith("Cost breakdown"), 3) : []),
    ...pick((f) => f.text.startsWith("Possible offer NOT included")),
    ...pick((f) => f.text.startsWith("Optimizer notice:") && !f.text.includes("ILLUSTRATIVE"), 1),
    ...pick((f) => f.text.startsWith("Not ranked (incomplete pricing)")),
  ];
  const unique = [...new Map(chosen.map((f) => [f.id, f])).values()];
  const lead = context.diff.length ? `I applied: ${context.diff.join("; ")}.\n\n` : "";
  const body = unique.length ? unique.map((f) => `• ${f.text} [${f.id}]`).join("\n") : "The optimizer returned no results to explain yet.";
  return { message: lead + body, cited: unique.map((f) => f.id) };
}

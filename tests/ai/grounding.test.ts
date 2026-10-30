import { describe, expect, it } from "vitest";
import { buildDigest, summarizeRun } from "@/ai/digest";
import { checkGrounding, deterministicExplanation, groundExplanation, moneyIn } from "@/ai/grounding";
import { CATALOG } from "@/data/catalog";
import { defaultTripRequest } from "@/data/defaults";
import { formatCents } from "@/domain/money";
import { optimize } from "@/domain/optimizer/optimize";
import { DATA, NOW } from "./helpers";

const request = defaultTripRequest();
const result = optimize({ catalog: CATALOG, data: DATA, request, now: NOW });
const facts = buildDigest({ result, request });
const cheapest = result.ranked.find((e) => e.id === result.awards.find((a) => a.kind === "cheapest")!.evaluationId)!;

describe("facts digest", () => {
  it("states the optimizer's own totals and labels illustrative data", () => {
    const all = facts.map((f) => f.text).join("\n");
    expect(all).toContain(formatCents(cheapest.totalCents));
    expect(facts[0]!.text).toMatch(/ILLUSTRATIVE/);
    expect(facts.every((f, i) => f.id === `F${i + 1}`)).toBe(true);
  });

  it("precomputes differences vs the previous run and between variants", () => {
    const longer = { ...request, preferred: { ...request.preferred, nights: 7 }, dates: { ...request.dates, minNights: 7, maxNights: 7 } };
    const r2 = optimize({ catalog: CATALOG, data: DATA, request: longer, now: NOW });
    const f2 = buildDigest({ result: r2, request: longer, previous: summarizeRun(result), variants: [{ label: "Value only", summary: summarizeRun(result) }] });
    const prev = f2.find((f) => f.text.startsWith("Before this change the cheapest"))!.text;
    const now = summarizeRun(r2).cheapest!.totalCents;
    expect(prev).toContain(formatCents(cheapest.totalCents));
    expect(prev).toContain(formatCents(Math.abs(now - cheapest.totalCents)));
    expect(f2.some((f) => f.text.startsWith('Comparison "Value only": cheapest'))).toBe(true);
  });
});

describe("grounding check (the AI cannot introduce prices)", () => {
  it("parses money in text", () => {
    expect(moneyIn("about $3,410.00 or $3,410 or 2000 dollars, $5k").map((m) => m.cents)).toEqual([341_000, 341_000, 200_000, 500_000]);
  });

  it("accepts amounts copied from the facts and rejects invented ones", () => {
    const ok = `The cheapest option is ${formatCents(cheapest.totalCents)} [F2].`;
    expect(checkGrounding(ok, facts, ["F2"]).ok).toBe(true);
    const invented = checkGrounding("You could probably get it for $2,999.99 with a discount.", facts, []);
    expect(invented.ok).toBe(false);
    expect(invented.unknownAmounts).toEqual(["$2,999.99"]);
    expect(checkGrounding("That's 37% cheaper.", facts, []).unknownRatios).toEqual(["37%"]);
    expect(checkGrounding("See [F999].", facts, []).unknownFacts).toEqual(["F999"]);
  });

  it("allows repeating the user's own budget", () => {
    expect(checkGrounding("You asked to stay under $5,000.", facts, [], [500_000]).ok).toBe(true);
  });

  it("replaces an ungrounded AI explanation with the deterministic one", () => {
    const g = groundExplanation({ message: "Great news: it's only $1,234.56!", citedFacts: [] }, facts, { question: "how much?", diff: [] });
    expect(g.grounded).toBe("deterministic");
    expect(g.rejectedReason).toMatch(/\$1,234\.56/);
    expect(g.message).not.toContain("$1,234.56");
  });

  it("keeps a grounded AI explanation", () => {
    const g = groundExplanation({ message: `Cheapest: ${formatCents(cheapest.totalCents)} [F2].`, citedFacts: ["F2"] }, facts, { question: "?", diff: [] });
    expect(g.grounded).toBe("ai");
  });

  it("builds deterministic explanations only from facts", () => {
    const d = deterministicExplanation(facts, { question: "why did this win?", diff: ["Preferred nights: 6 → 7"] });
    expect(checkGrounding(d.message, facts, d.cited).ok).toBe(true);
    expect(d.message).toContain("I applied: Preferred nights: 6 → 7");
    expect(d.cited.length).toBeGreaterThan(0);
  });
});

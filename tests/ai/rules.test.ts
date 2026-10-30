import { describe, expect, it } from "vitest";
import { applyPatch } from "@/ai/patch";
import { interpretWithRules } from "@/ai/providers/rules";
import { proposalSchema } from "@/ai/types";
import { CATALOG } from "@/data/catalog";
import { defaultTripRequest } from "@/data/defaults";

const req = defaultTripRequest();
const interpret = (message: string, request = req) =>
  interpretWithRules({ today: "2026-10-30", request, confirmed: [], catalog: CATALOG, history: [], lastRun: null, message });

describe("basic mode (rules interpreter, no AI key)", () => {
  it("parses the birthday example into requirements and preferences", () => {
    const p = interpret(
      "I want to take two adults to Disney World for my birthday. Ideally six or seven nights, preferably Pop Century, with Park Hopper Plus tickets and a dining plan. I'd like to keep the total under $5,000, but I can be flexible with dates.",
    );
    expect(proposalSchema.safeParse(p).success).toBe(true);
    expect(p.intent).toBe("update");
    expect(p.patch.party?.adults).toBe(2);
    expect(p.patch.dates).toMatchObject({ minNights: 6, maxNights: 7 });
    expect(p.patch.preferred).toMatchObject({ resortId: "pop-century", ticketOption: "park_hopper_plus", dining: "dining_plan", bookingMethod: "package" });
    expect(p.patch.resorts?.preferredResortIds).toEqual(["pop-century"]); // a preference, not an allow-list
    expect(p.patch.resorts?.allowedResortIds).toBeNull();
    expect(p.patch.dining?.policy).toBe("prefer"); // "a dining plan" with hedged wording → preference
    expect(p.patch.budget).toMatchObject({ targetDollars: 5000, hardLimitDollars: null }); // "keep it under" → soft target
    expect(p.clarifications.join()).toMatch(/flexible/);
    const applied = applyPatch(req, p.patch, CATALOG, ["under $5,000"]);
    expect(applied.errors).toEqual([]);
    expect(applied.request!.budget.targetCents).toBe(500_000);
  });

  it("treats a tier comparison as side-by-side variants and 'experience' as best value", () => {
    const p = interpret("I want to compare staying at a Deluxe resort against staying at a Value resort. I care more about the overall experience than finding the absolute cheapest option.");
    expect(p.comparisons.map((c) => c.patch.resorts?.allowTiers)).toEqual([["value"], ["deluxe"]]);
    expect(p.patch.objective?.objective).toBe("best_value");
    expect(p.patch.resorts).toBeNull(); // the main request's resorts are not changed
  });

  it("handles refinements as relative changes", () => {
    expect(interpret("Could I save money by arriving a day earlier?").patch.shiftPreferredArrivalDays).toBe(-1);
    expect(interpret("What if we stayed one more night?").patch.adjustNights).toBe(1);
    expect(interpret("What if we switched to All-Star Movies?").patch.preferred?.resortId).toBe("all-star-movies");
    expect(interpret("Can you find something under $4,500?").patch.budget?.targetDollars).toBe(4500);
    expect(interpret("We can't go over $4,000").patch.budget?.hardLimitDollars).toBe(4000);
  });

  it("removes a ticket type and keeps the rest", () => {
    const p = interpret("Show me what happens if I remove Park Hopper Plus.");
    expect(p.patch.tickets?.allowedOptions).toEqual(["park_hopper"]);
  });

  it("finds DVC villa options", () => {
    const p = interpret("Find me an option that includes a DVC villa.");
    expect(p.patch.resorts).toMatchObject({ considerPoints: true, allowTiers: ["deluxe_villa"] });
  });

  it("compares the same trip without the dining plan as a variant", () => {
    const p = interpret("Compare the same trip without the dining plan.");
    expect(p.comparisons[0]?.patch.dining?.policy).toBe("exclude");
    expect(p.patch.dining).toBeNull();
  });

  it("asks instead of guessing, and reports unsupported requests", () => {
    expect(interpret("Let's stay at the Polynesian").clarifications.join()).toMatch(/Which resort/);
    const two = interpret("We need two rooms");
    expect(two.unsupported[0]).toMatch(/one room/);
    expect(interpret("Why did that option win?").intent).toBe("explain");
    const hello = interpret("hello there");
    expect(hello.intent).toBe("chat");
    expect(Object.values(hello.patch).every((v) => v === null)).toBe(true);
  });

  it("understands month windows relative to today", () => {
    const p = interpret("late October, 5 nights");
    expect(p.patch.dates).toMatchObject({ earliestArrival: "2027-10-18", minNights: 5, maxNights: 5 });
  });
});

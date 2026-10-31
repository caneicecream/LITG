import { describe, expect, it } from "vitest";
import { applyItineraryPatch, EMPTY_ITINERARY_PATCH, itineraryProposalSchema, timesIn, type ItineraryProposal } from "@/ai/itinerary/patch";
import { dateIn, interpretItineraryWithRules, isItineraryRequest } from "@/ai/itinerary/rules";
import { checkItineraryNumbers, itineraryFacts } from "@/ai/itinerary/digest";
import { AnthropicProvider, type ParseClient } from "@/ai/providers/anthropic";
import { AiError } from "@/ai/providers/provider";
import { RulesProvider } from "@/ai/providers/rules";
import { applyProposal, createConversation, sendMessage, updateSettings } from "@/ai/service";
import type { Conversation } from "@/ai/types";
import { CATALOG } from "@/data/catalog";
import { defaultTripRequest } from "@/data/defaults";
import { demoInput } from "@/itinerary/context";
import { planItinerary } from "@/itinerary/engine";
import type { ItineraryInput } from "@/itinerary/types";
import { deps, MockProvider, proposal } from "./helpers";

// The assistant and itineraries: proposals, apply, comparisons, grounding. The
// demo input is illustrative; no live park data exists anywhere in these tests.

const TODAY = "2026-10-30";
const demo = (): ItineraryInput => demoInput(TODAY); // trip 2027-02-01 → 2027-02-06, 4 park days
const rules = (m: string, i: ItineraryInput = demo()) => interpretItineraryWithRules(m, i);
const last = (c: Conversation, kind: string) => [...c.messages].reverse().find((m) => m.kind === kind)!;
const itinProposal = (p: Partial<ItineraryProposal>): ItineraryProposal => ({ intent: "update", reply: "", patch: { ...EMPTY_ITINERARY_PATCH }, evidence: [], comparisons: [], clarifications: [], unsupported: [], ...p });

async function itinConversation(d: ReturnType<typeof deps>) {
  return createConversation(d, { itinerary: { input: demo() } });
}

describe("basic-mode itinerary interpretation", () => {
  it("understands the planning requests from the brief", () => {
    expect(rules("Build a relaxed four-day plan.").patch).toMatchObject({ pace: "relaxed", relaxedSchedule: true, parkDays: 4 });
    expect(rules("Minimize walking and avoid crossing the park repeatedly.").patch).toMatchObject({ minimizeWalking: true, reduceBacktracking: true });
    expect(rules("Keep our afternoons flexible.").patch.flexibleAfternoons).toBe(true);
    expect(rules("Move the most demanding day away from our arrival day.").patch.avoidDemandingArrivalDay).toBe(true);
    const cmp = rules("Compare a ride-focused plan with a relaxed plan.");
    expect(cmp.comparisons.map((c) => c.label)).toEqual(["Ride-focused", "Relaxed"]);
    expect(cmp.patch.pace).toBeNull();
    const lose = rules("What would we lose if we removed this park day?");
    expect(lose.comparisons[0]).toMatchObject({ label: "3 park days instead of 4", patch: { parkDays: 3 } });
  });

  it("reads attraction preferences clause by clause", () => {
    const p = rules("Seven Dwarfs and Remy are must-dos, skip TRON. We'd like Soarin if there's time.").patch.attractions;
    expect(p).toEqual(
      expect.arrayContaining([
        { attractionId: "mk-seven-dwarfs", preference: "must" },
        { attractionId: "ep-remy", preference: "must" },
        { attractionId: "mk-tron", preference: "avoid" },
        { attractionId: "ep-soarin", preference: "want" },
      ]),
    );
    const vague = rules("Prioritize the attractions that matter most to us.", { ...demo(), prefs: { ...demo().prefs, attractions: {} } });
    expect(vague.intent).toBe("clarify");
    expect(vague.clarifications[0]).toMatch(/Which attractions matter most/);
  });

  it("adds a dining reservation only with a stated date and time", () => {
    const ok = rules("Add our dinner reservation at 6:30 pm on Feb 3 at EPCOT.");
    expect(ok.patch.addDining).toEqual([{ date: "2027-02-03", time: "18:30", parkId: "epcot", name: "Dinner reservation", durationMinutes: null }]);
    const missing = rules("Add this dining reservation.");
    expect(missing.patch.addDining).toBeNull();
    expect(missing.clarifications[0]).toMatch(/What date and time/);
  });

  it("is honest about current facts it doesn't have", () => {
    const hours = rules("What are the park hours on Feb 3?");
    expect(hours.intent).toBe("unsupported");
    expect(hours.unsupported[0]).toMatch(/I don't have live park information/);
    const ll = rules("Is Lightning Lane available for Slinky Dog Dash?");
    expect(ll.unsupported.join()).toMatch(/can't check or book Lightning Lane availability/);
  });

  it("parses times and trip dates", () => {
    expect(timesIn("dinner at 6:30 pm, lunch 12:15, breakfast 8am, 7 people")).toEqual(["18:30", "12:15", "08:00"]);
    expect(dateIn("on February 4th", demo())).toBe("2027-02-04");
    expect(dateIn("on day 2", demo())).toBe("2027-02-02");
    expect(dateIn("on Mar 9", demo())).toBeNull();
    expect(isItineraryRequest("Build a relaxed four-day plan")).toBe(true);
    expect(isItineraryRequest("What if we stayed one more night?")).toBe(false);
  });
});

describe("applying itinerary patches", () => {
  it("validates against the trip and the user's own words", () => {
    const base = demo();
    const p = { ...EMPTY_ITINERARY_PATCH, addDining: [{ date: "2027-02-03", time: "18:30", parkId: "epcot", name: "Dinner", durationMinutes: null }] };
    expect(applyItineraryPatch(base, p, ["dinner at 7pm"], TODAY).errors.join()).toMatch(/time you stated; 18:30 isn't in your messages/);
    const ok = applyItineraryPatch(base, p, ["dinner at 6:30pm on Feb 3"], TODAY);
    expect(ok.errors).toEqual([]);
    expect(ok.input!.parkInfo.dining.at(-1)!.provenance).toEqual({ status: "manual", source: "You told the assistant", observedAt: TODAY });
    expect(applyItineraryPatch(base, { ...p, addDining: [{ ...p.addDining[0]!, date: "2027-03-03" }] }, ["6:30pm"], TODAY).errors.join()).toMatch(/not a day of this trip/);
    expect(applyItineraryPatch(base, { ...EMPTY_ITINERARY_PATCH, parkDays: 6 }, [], TODAY).errors.join()).toMatch(/ticket has 4 park days/);
    expect(applyItineraryPatch(base, { ...EMPTY_ITINERARY_PATCH, allowHopping: true }, [], TODAY).errors.join()).toMatch(/Park Hopper/);
    expect(applyItineraryPatch(base, { ...EMPTY_ITINERARY_PATCH, attractions: [{ attractionId: "made-up", preference: "must" }] }, [], TODAY).errors.join()).toMatch(/Unknown attraction/);
  });

  it("changes only what was asked", () => {
    const base = demo();
    const r = applyItineraryPatch(base, { ...EMPTY_ITINERARY_PATCH, pace: "relaxed" }, [], TODAY);
    expect(r.diff).toEqual(["Pace: moderate → relaxed"]);
    expect({ ...r.input!.prefs, pace: base.prefs.pace }).toEqual(base.prefs);
    expect(r.input!.parkInfo).toEqual(base.parkInfo);
  });
});

describe("assistant itinerary workflow (basic mode)", () => {
  it("proposes, waits for review, then plans deterministically and explains from facts", async () => {
    const d = deps(new RulesProvider(CATALOG));
    const conv = await itinConversation(d);
    const after = await sendMessage(d, conv.id, "Build a relaxed plan and keep our afternoons flexible.");
    const p = last(after, "itinerary_proposal");
    expect(p.itineraryProposal!.status).toBe("pending");
    expect(p.itineraryProposal!.diff).toEqual(expect.arrayContaining(["Pace: moderate → relaxed", "Keep 2–4 pm free: off → on"]));
    expect(after.itinerary!.input.prefs.pace).toBe("moderate"); // not applied yet
    const applied = await applyProposal(d, conv.id, p.id);
    expect(applied.itinerary!.input.prefs.pace).toBe("relaxed");
    expect(applied.itinerary!.input.prefs.attractions).toEqual(demo().prefs.attractions); // unrelated preferences kept
    expect(applied.itinerary!.lastResult).toEqual(planItinerary(applied.itinerary!.input, { today: "2026-10-30" }));
    expect(last(applied, "itinerary_result").itineraryRun!.headline).toMatch(/^Demonstration — Best candidate found/);
    const e = last(applied, "explanation");
    expect(e.explanation!.grounded).toBe("deterministic");
    expect(e.text).toMatch(/DEMONSTRATION/);
  });

  it("auto-apply runs the planner immediately", async () => {
    const d = deps(new RulesProvider(CATALOG));
    const conv = await itinConversation(d);
    await updateSettings(d, conv.id, { autoApply: true });
    const after = await sendMessage(d, conv.id, "Minimize walking.");
    expect(last(after, "itinerary_proposal").itineraryProposal!.status).toBe("applied");
    expect(after.itinerary!.lastResult).not.toBeNull();
  });

  it("compares a ride-focused and a relaxed plan from the same facts", async () => {
    const d = deps(new RulesProvider(CATALOG));
    const conv = await itinConversation(d);
    const p = last(await sendMessage(d, conv.id, "Compare a ride-focused plan with a relaxed plan."), "itinerary_proposal");
    const after = await applyProposal(d, conv.id, p.id);
    expect(after.itinerary!.lastComparison!.map((v) => v.label)).toEqual(["Ride-focused", "Relaxed"]);
    expect(last(after, "itinerary_result").itineraryRun!.comparison[1]).toMatch(/^Must-dos: \d+ of \d+ vs \d+ of \d+\.$/);
    expect(after.itinerary!.input.prefs).toEqual(demo().prefs); // the main plan is unchanged
  });

  it("answers 'what would we lose' with a one-day-fewer comparison", async () => {
    const d = deps(new RulesProvider(CATALOG));
    const conv = await itinConversation(d);
    const p = last(await sendMessage(d, conv.id, "What would we lose if we removed a park day?"), "itinerary_proposal");
    const after = await applyProposal(d, conv.id, p.id);
    const facts = last(after, "explanation").explanation!.facts.map((f) => f.text).join("\n");
    expect(facts).toMatch(/Comparison "Current plan" vs "3 park days instead of 4"/);
    expect(facts).toMatch(/Only in "Current plan": /);
  });

  it("starts itinerary planning from a trip conversation, or says what's missing", async () => {
    const d = deps(new RulesProvider(CATALOG));
    const conv = await createConversation(d, { request: defaultTripRequest() });
    const after = await sendMessage(d, conv.id, "Build a relaxed four-day plan.");
    expect(after.itinerary!.input.context).toMatchObject({ arrival: "2027-01-17", resortId: "pop-century" });
    // The default plan has 5 park days on the ticket, so 4 is accepted.
    expect(last(after, "itinerary_proposal").itineraryProposal!.diff).toContain("Park days used: 5 → 4");

    const incomplete = await createConversation(d, { request: { ...defaultTripRequest(), preferred: {} } });
    const r = await sendMessage(d, incomplete.id, "Build a relaxed plan.");
    expect(last(r, "reply").text).toMatch(/preferred plan is incomplete/);
  });

  it("trip-pricing messages still go to the trip planner in an itinerary conversation", async () => {
    const d = deps(new RulesProvider(CATALOG));
    const conv = await itinConversation(d);
    const after = await sendMessage(d, conv.id, "What if we stayed one more night?");
    expect(last(after, "proposal").proposal!.diff.join()).toMatch(/nights/i);
  });
});

describe("assistant itinerary workflow (AI provider, mocked)", () => {
  const llm = (onExplain: (facts: { id: string; text: string }[]) => unknown, onItinerary?: () => unknown) => {
    const p = new MockProvider(() => proposal({}), (input) => onExplain(input.facts));
    if (onItinerary) (p as unknown as { interpretItinerary: () => Promise<unknown> }).interpretItinerary = async () => onItinerary();
    return p;
  };

  it("uses the AI's validated proposal and accepts an explanation whose figures come from the facts", async () => {
    const provider = llm(
      (facts) => {
        const f = facts.find((x) => x.text.startsWith("Must-dos scheduled"))!;
        const n = f.text.match(/(\d+) of (\d+)/)!;
        return { message: `${n[1]} of ${n[2]} must-dos are in the plan [${f.id}].`, citedFacts: [f.id] };
      },
      () => itinProposal({ reply: "Making it relaxed.", patch: { ...EMPTY_ITINERARY_PATCH, pace: "relaxed" } }),
    );
    const d = deps(provider);
    const conv = await itinConversation(d);
    const p = last(await sendMessage(d, conv.id, "Make it relaxed please"), "itinerary_proposal");
    expect(p.source).toBe("mock:test-model");
    const after = await applyProposal(d, conv.id, p.id);
    expect(last(after, "explanation").explanation!.grounded).toBe("ai");
  });

  it("withholds AI text with invented times or durations", async () => {
    const provider = llm(
      (facts) => ({ message: `Rides open at 7:45 AM and Slinky has a 15 minute wait [${facts[0]!.id}].`, citedFacts: [facts[0]!.id] }),
      () => itinProposal({ patch: { ...EMPTY_ITINERARY_PATCH, minimizeWalking: true } }),
    );
    const d = deps(provider);
    const conv = await itinConversation(d);
    const after = await applyProposal(d, conv.id, last(await sendMessage(d, conv.id, "less walking"), "itinerary_proposal").id);
    const e = last(after, "explanation");
    expect(e.explanation!.grounded).toBe("deterministic");
    expect(e.explanation!.rejectedReason).toMatch(/7:45/);
  });

  it("rejects AI proposals that invent reservation times", async () => {
    const provider = llm(() => null, () => itinProposal({ patch: { ...EMPTY_ITINERARY_PATCH, addDining: [{ date: "2027-02-03", time: "19:00", parkId: "epcot", name: "Dinner", durationMinutes: 90 }] } }));
    const d = deps(provider);
    const conv = await itinConversation(d);
    const p = last(await sendMessage(d, conv.id, "add our dinner reservation"), "itinerary_proposal");
    expect(p.itineraryProposal!.status).toBe("invalid");
    expect(p.itineraryProposal!.errors.join()).toMatch(/19:00 isn't in your messages/);
  });

  it("falls back to basic mode when the provider fails or can't do itineraries", async () => {
    const failing = llm(() => null, () => {
      throw new AiError("rate_limited");
    });
    const d = deps(failing);
    const conv = await itinConversation(d);
    const after = await sendMessage(d, conv.id, "Keep our afternoons flexible.");
    expect(last(after, "notice").text).toMatch(/rate-limiting.*basic mode/);
    expect(last(after, "itinerary_proposal").itineraryProposal!.diff).toContain("Keep 2–4 pm free: off → on");

    const noSupport = deps(new MockProvider(() => proposal({})));
    const c2 = await itinConversation(noSupport);
    const a2 = await sendMessage(noSupport, c2.id, "Keep our afternoons flexible.");
    expect(last(a2, "notice").text).toMatch(/doesn't support itinerary requests/);
  });

  it("the Claude provider sends an itinerary structured-output request with the catalog", async () => {
    const calls: Record<string, unknown>[] = [];
    const client: ParseClient = { beta: { messages: { parse: (async (params: Record<string, unknown>) => (calls.push(params), { stop_reason: "end_turn", parsed_output: itinProposal({}) })) as never } } };
    const provider = new AnthropicProvider({ model: "claude-opus-5-5", interpretEffort: "medium", explainEffort: "low", fallbacks: true, client });
    const out = await provider.interpretItinerary({ today: TODAY, input: demo(), history: [], message: "relaxed please" });
    expect(itineraryProposalSchema.safeParse(out).success).toBe(true);
    const p = calls[0]!;
    expect((p.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    const system = JSON.stringify(p.system);
    expect(system).toContain("mk-seven-dwarfs");
    expect(system).toMatch(/Never invent or state park hours/);
    expect(JSON.stringify(p.messages)).toContain("relaxed please");
  });
});

describe("itinerary facts", () => {
  it("contain every figure needed and nothing invented", () => {
    const it0 = planItinerary(demo(), { today: TODAY });
    const facts = itineraryFacts(it0);
    expect(facts[0]!.text).toMatch(/^Itinerary: Demonstration/);
    expect(facts.some((f) => f.text.includes("DEMONSTRATION"))).toBe(true);
    expect(facts.some((f) => f.text.startsWith("Fit score") && f.text.includes("not how good the vacation will be"))).toBe(true);
    expect(checkItineraryNumbers("Day one starts at 9:00 AM", facts)).toEqual([]);
    expect(checkItineraryNumbers("Arrive at 7:13", facts)).toEqual(["7:13"]);
  });
});

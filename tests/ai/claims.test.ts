import { describe, expect, it } from "vitest";
import { unsupportedClaims } from "@/ai/grounding";
import { freshnessFacts, createConversation, sendMessage, applyProposal } from "@/ai/service";
import { RulesProvider } from "@/ai/providers/rules";
import { interpretWithRules } from "@/ai/providers/rules";
import { CATALOG } from "@/data/catalog";
import { defaultTripRequest } from "@/data/defaults";
import { TAX_RATES, TRANSPORT } from "@/data/reference";
import { mergePriceData } from "@/data/sources";
import { demoInput } from "@/itinerary/context";
import type { Conversation } from "@/ai/types";
import { deps, MockProvider, proposal } from "./helpers";

// Real-world assistant behaviour: unsupported claims, freshness, ambiguity,
// malformed output and failures. Prices are fictional test data.

const last = (c: Conversation, kind: string) => [...c.messages].reverse().find((m) => m.kind === kind)!;
const quote = (observedAt: string) => ({
  id: `q-${observedAt}`,
  kind: "stay_quote" as const,
  label: "TEST",
  resortId: "pop-century",
  roomTypeId: "standard",
  checkIn: "2027-01-17",
  nights: 6,
  adults: 2,
  children: 0,
  bookingMethod: "separate" as const,
  dining: "out_of_pocket" as const,
  totalCents: 150_000,
  taxIncluded: true,
  provenance: { status: "manual" as const, source: "TEST", observedAt },
});

describe("unsupported claims", () => {
  const facts = [{ id: "F1", text: "Cheapest option: Pop Century. Total $1,500.00. Data: Manually entered." }];
  it("flags wording the facts don't support", () => {
    expect(unsupportedClaims("This is the current price and it's guaranteed.", facts)).toEqual(expect.arrayContaining(["current conditions", "a guarantee"]));
    expect(unsupportedClaims("Lightning Lane is available for Slinky.", facts)).toEqual(["availability"]);
    expect(unsupportedClaims("You have a confirmed reservation at Pop Century.", facts)).toEqual(["a reservation"]);
    expect(unsupportedClaims("I've booked it for you.", facts)).toEqual(["a booking action"]);
    expect(unsupportedClaims("The cheapest option costs $1,500.00 [F1].", facts)).toEqual([]);
  });
  it("allows wording that the facts themselves contain", () => {
    expect(unsupportedClaims("Free cancellation is guaranteed until Dec 18.", [{ id: "F1", text: "The quote says cancellation is guaranteed free until Dec 18." }])).toEqual([]);
  });

  it("an AI explanation claiming a current price is withheld", async () => {
    const llm = new MockProvider(
      () => proposal({ intent: "explain" }),
      (input) => {
        const f = input.facts.find((x) => x.text.startsWith("Cheapest option"))!;
        const amount = f.text.match(/\$[\d,]+\.\d\d/)![0];
        return { message: `The current price is ${amount} [${f.id}], guaranteed.`, citedFacts: [f.id] };
      },
    );
    const d = deps(llm);
    const conv = await createConversation(d, { request: defaultTripRequest() });
    const after = await sendMessage(d, conv.id, "Why is this the cheapest?");
    const e = last(after, "explanation");
    expect(e.explanation!.grounded).toBe("deterministic");
    expect(e.explanation!.rejectedReason).toMatch(/claims the facts don't support \(.*(current conditions|a guarantee)/);
  });

  it("an itinerary explanation claiming availability is withheld", async () => {
    const llm = new MockProvider(() => proposal({}), (input) => ({ message: `Lightning Lane is available for every ride [${input.facts[0]!.id}].`, citedFacts: [input.facts[0]!.id] }));
    (llm as unknown as { interpretItinerary: () => Promise<unknown> }).interpretItinerary = async () => ({ intent: "update", reply: "", patch: { pace: "relaxed", minimizeWalking: null, reduceBacktracking: null, maximizeAttractions: null, relaxedSchedule: null, middayBreak: null, flexibleAfternoons: null, avoidDemandingArrivalDay: null, restDay: null, allowHopping: null, parks: null, parkDays: null, attractions: null, addDining: null, addLightningLane: null, dayStart: null, dayEnd: null }, evidence: [], comparisons: [], clarifications: [], unsupported: [] });
    const d = deps(llm);
    const conv = await createConversation(d, { itinerary: { input: demoInput("2026-10-30") } });
    const p = last(await sendMessage(d, conv.id, "relaxed please"), "itinerary_proposal");
    const after = await applyProposal(d, conv.id, p.id);
    expect(last(after, "explanation").explanation!.rejectedReason).toMatch(/availability/);
  });
});

describe("price freshness", () => {
  it("says how old stored prices are and that a re-run is not a new price check", () => {
    const data = mergePriceData([{ taxRates: TAX_RATES, transport: TRANSPORT, stayQuotes: [quote("2026-09-01"), quote("2026-10-29")] }]);
    const [f] = freshnessFacts(data, defaultTripRequest(), "2026-10-30");
    expect(f).toMatch(/your 2 recorded prices were observed between 2026-09-01 and 2026-10-29; 1 is older than 14 days/);
    expect(f).toMatch(/not live prices; re-running the optimizer re-evaluates them and is not a new price check/);
    expect(freshnessFacts(mergePriceData([{ taxRates: TAX_RATES }]), defaultTripRequest(), "2026-10-30")[0]).toMatch(/none of your own prices are recorded/);
  });

  it("basic mode answers 'is this price still current?' from the freshness fact", async () => {
    const data = mergePriceData([{ taxRates: TAX_RATES, transport: TRANSPORT, stayQuotes: [quote("2026-09-01")] }]);
    const d = deps(new RulesProvider(CATALOG));
    d.loadData = async () => data;
    d.loadObservations = async () => [];
    const conv = await createConversation(d, { request: { ...defaultTripRequest(), data: { includeIllustrative: false, staleAfterDays: 14 } } });
    const after = await sendMessage(d, conv.id, "Is this price still current?");
    expect(last(after, "explanation").text).toMatch(/Price freshness: .* not live prices/);
  });
});

describe("ambiguity, malformed output and failures", () => {
  it("asks when a resort name is ambiguous instead of guessing", () => {
    const p = interpretWithRules({ message: "switch to All-Star", request: defaultTripRequest(), catalog: CATALOG } as never);
    expect(p.patch.preferred?.resortId ?? null).toBeNull();
    expect(p.clarifications.join()).toMatch(/All-Star/);
  });

  it("malformed AI output changes nothing and falls back visibly", async () => {
    const llm = new MockProvider(() => ({ intent: "update", patch: { party: "two adults" } }));
    const d = deps(llm);
    const conv = await createConversation(d, { request: defaultTripRequest() });
    const after = await sendMessage(d, conv.id, "two adults please");
    expect(after.request).toEqual(conv.request);
    expect(after.messages.some((m) => m.kind === "notice" && /basic mode/.test(m.text))).toBe(true);
  });

  it("a failing provider never changes the request", async () => {
    const llm = new MockProvider(() => {
      throw new Error("socket hang up");
    });
    const d = deps(llm);
    const conv = await createConversation(d, { request: defaultTripRequest() });
    const after = await sendMessage(d, conv.id, "7 nights");
    expect(after.request).toEqual(conv.request);
    expect(last(after, "proposal").proposal!.status).toBe("pending");
  });
});

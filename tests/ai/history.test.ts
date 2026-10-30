import { describe, expect, it } from "vitest";
import { createConversation, sendMessage } from "@/ai/service";
import { interpretWithRules } from "@/ai/providers/rules";
import { diffRequests } from "@/ai/patch";
import { RulesProvider } from "@/ai/providers/rules";
import type { Conversation } from "@/ai/types";
import { CATALOG } from "@/data/catalog";
import { defaultTripRequest } from "@/data/defaults";
import { TAX_RATES, TRANSPORT } from "@/data/reference";
import { mergePriceData } from "@/data/sources";
import { observationsForImport } from "@/db/importJson";
import type { PaymentTerms, StayQuote, TripRequest } from "@/domain/types";
import { deps, MockProvider, NOW, proposal } from "./helpers";

// The assistant answers price-history and switching questions from recorded
// observations and the deterministic switching arithmetic. Fictional prices.

const request = (): TripRequest => ({
  ...defaultTripRequest(),
  dates: { earliestArrival: "2027-02-01", latestDeparture: "2027-02-05", minNights: 4, maxNights: 4 },
  preferred: { arrival: "2027-02-01", nights: 4, resortId: "pop-century", roomTypeId: "standard", ticketOption: "base", bookingMethod: "package", dining: "out_of_pocket" },
  resorts: { allowedResortIds: ["pop-century", "all-star-movies"], requireOnProperty: true, preferredResortIds: [] },
  tickets: { parkDays: 3, allowedOptions: ["base"], parkOnArrivalDay: false, parkOnDepartureDay: false, allowThirdParty: true },
  dining: { policy: "exclude", outOfPocketPerAdultPerNightCents: 0, outOfPocketPerChildPerNightCents: 0 },
  budget: {},
  data: { includeIllustrative: false, staleAfterDays: 14 },
});

const q = (over: Partial<StayQuote>): StayQuote => ({
  id: "q-pop",
  kind: "stay_quote",
  label: "TEST",
  resortId: "pop-century",
  roomTypeId: "standard",
  checkIn: "2027-02-01",
  nights: 4,
  adults: 2,
  children: 0,
  bookingMethod: "package",
  ticket: { option: "base", days: 3 },
  dining: "out_of_pocket",
  totalCents: 245_000,
  taxIncluded: true,
  provenance: { status: "manual", source: "disneyworld.com (TEST)", observedAt: "2026-10-28" },
  ...over,
});

const terms: PaymentTerms = { depositCents: 20_000, installments: [], amountPaidCents: 20_000, refundability: "refundable", freeCancellationUntil: "2026-12-18", cancellationPenalties: [] };

const history = [
  { observedAt: "2026-10-01", supersededAt: "2026-10-15T09:00:00.000Z", status: "manual" as const, source: "disneyworld.com (TEST)", value: 262_000 },
  { observedAt: "2026-10-15", supersededAt: "2026-10-28T09:00:00.000Z", status: "manual" as const, source: "disneyworld.com (TEST)", value: 251_000 },
];

function setup(quotes: StayQuote[], opts: { failObservations?: boolean; provider?: MockProvider | RulesProvider } = {}) {
  const data = mergePriceData([{ taxRates: TAX_RATES, transport: TRANSPORT, stayQuotes: quotes }]);
  const d = deps(opts.provider ?? new RulesProvider(CATALOG));
  d.loadData = async () => data;
  d.loadObservations = async (fps) => {
    if (opts.failObservations) throw new Error("ECONNREFUSED");
    return quotes.flatMap((x) => observationsForImport(x, NOW.toISOString())).filter((o) => fps.includes(o.fingerprint!));
  };
  return d;
}

const lastExplanation = (c: Conversation) => [...c.messages].reverse().find((m) => m.kind === "explanation")!;
const factText = (c: Conversation) => lastExplanation(c).explanation!.facts.map((f) => f.text).join("\n");

describe("assistant: price history questions", () => {
  it("basic mode treats history questions as explanations, never as an objective change", () => {
    const p = interpretWithRules({ message: "What's the lowest price we've recorded?", request: request(), catalog: CATALOG } as never);
    expect(p.intent).toBe("explain");
    expect(p.patch.objective).toBeNull();
    expect(interpretWithRules({ message: "Is it worth switching?", request: request(), catalog: CATALOG } as never).intent).toBe("explain");
    // A plain resort change is still a change.
    expect(interpretWithRules({ message: "switch to All-Star Movies", request: request(), catalog: CATALOG } as never).intent).toBe("update");
  });

  it("answers from recorded observations of the exact configuration", async () => {
    const d = setup([q({ history })]);
    const conv = await createConversation(d, { request: request() });
    const after = await sendMessage(d, conv.id, "What's the lowest price we've recorded?");
    expect(after.request.objective).toBe(conv.request.objective);
    const facts = factText(after);
    expect(facts).toMatch(/3 recorded observations from Thu, Oct 1 to Wed, Oct 28\. Latest: \$2,450\.00 observed Wed, Oct 28/);
    expect(facts).toMatch(/previous observation was \$2,510\.00 on Thu, Oct 15 .*; the latest is \$60\.00 lower \(-2\.39%\)/);
    expect(facts).toMatch(/lowest recorded \$2,450\.00 on Wed, Oct 28 .*highest recorded \$2,620\.00 on Thu, Oct 1/);
    expect(facts).toMatch(/Recorded observations are not live prices/);
    expect(lastExplanation(after).text).toMatch(/lowest recorded \$2,450\.00/);
  });

  it("says when there is no history instead of inventing one", async () => {
    const d = setup([q({ resortId: "all-star-movies", id: "q-asm" })]);
    const conv = await createConversation(d, { request: request() });
    const after = await sendMessage(d, conv.id, "Has the price dropped?");
    expect(factText(after)).toMatch(/no quote has been recorded for your preferred plan's exact configuration, so there is no price history/);
  });

  it("an AI answer that invents a price drop is withheld", async () => {
    const llm = new MockProvider(
      () => proposal({ intent: "explain", reply: "Let me check." }),
      (input) => {
        const f = input.facts.find((x) => x.text.startsWith("Price history"))!;
        return { message: `Great news: the price dropped by $300.00 [${f.id}].`, citedFacts: [f.id] };
      },
    );
    const d = setup([q({ history })], { provider: llm });
    const conv = await createConversation(d, { request: request() });
    const after = await sendMessage(d, conv.id, "Did the price drop?");
    const e = lastExplanation(after);
    expect(e.explanation!.grounded).toBe("deterministic");
    expect(e.explanation!.rejectedReason).toMatch(/\$300\.00/);
  });

  it("an AI answer quoting the recorded change is accepted", async () => {
    const llm = new MockProvider(
      () => proposal({ intent: "explain", reply: "Let me check." }),
      (input) => {
        const f = input.facts.find((x) => x.text.includes("previous observation"))!;
        return { message: `It is $60.00 lower than the previous observation (-2.39%) [${f.id}].`, citedFacts: [f.id] };
      },
    );
    const d = setup([q({ history })], { provider: llm });
    const after = await sendMessage(d, (await createConversation(d, { request: request() })).id, "How has the price changed?");
    expect(lastExplanation(after).explanation!.grounded).toBe("ai");
  });

  it("switching questions use the deterministic switching analysis", async () => {
    const d = setup([q({ booked: true, terms }), q({ id: "q-asm", resortId: "all-star-movies", totalCents: 215_000 })]);
    const after = await sendMessage(d, (await createConversation(d, { request: request() })).id, "Is it worth switching?");
    const facts = factText(after);
    expect(facts).toMatch(/Switching analysis: Worth considering: switching would leave you \$300\.00 better off/);
    expect(facts).toMatch(/price difference \$300\.00 \(not a saving by itself\); cancellation cost today \$0\.00; total switching cost \$0\.00; net difference after switching costs \$300\.00/);
    expect(facts).toMatch(/nothing is booked, changed or cancelled by the app/);
  });

  it("with unknown cancellation terms, the assistant can't recommend switching", async () => {
    const d = setup([q({ booked: true }), q({ id: "q-asm", resortId: "all-star-movies", totalCents: 215_000 })]);
    const after = await sendMessage(d, (await createConversation(d, { request: request() })).id, "Should I rebook?");
    const facts = factText(after);
    expect(facts).toMatch(/No reliable recommendation can be made/);
    expect(facts).toMatch(/net difference after switching costs unknown/);
    expect(lastExplanation(after).text).toMatch(/No reliable recommendation/);
  });

  it("a database failure drops only the history facts", async () => {
    const d = setup([q({ history })], { failObservations: true });
    const after = await sendMessage(d, (await createConversation(d, { request: request() })).id, "What's the lowest price we've recorded?");
    expect(factText(after)).toMatch(/recorded price history is unavailable right now/);
    expect(lastExplanation(after).text.length).toBeGreaterThan(0);
  });
});

describe("stored requests", () => {
  it("a request whose keys were reordered by storage (jsonb) shows no changes", () => {
    const r = request();
    const reordered = JSON.parse(JSON.stringify({ ...r, weights: Object.fromEntries(Object.entries(r.weights).reverse()), eligibility: Object.fromEntries(Object.entries(r.eligibility).reverse()) })) as TripRequest;
    expect(diffRequests(r, reordered, CATALOG)).toEqual([]);
  });
});

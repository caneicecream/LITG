import { describe, expect, it } from "vitest";
import { getProvider } from "@/ai/providers/config";
import { AiError } from "@/ai/providers/provider";
import { applyProposal, createConversation, dismissProposal, runRequest, sendMessage, updateSettings } from "@/ai/service";
import type { Conversation } from "@/ai/types";
import { CATALOG } from "@/data/catalog";
import { defaultTripRequest } from "@/data/defaults";
import { formatCents } from "@/domain/money";
import { optimize } from "@/domain/optimizer/optimize";
import { DATA, deps, MockProvider, NOW, patch, proposal } from "./helpers";

const last = (c: Conversation, kind?: string) => [...c.messages].reverse().find((m) => !kind || m.kind === kind)!;
const nightsPatch = (nights: number) => patch({ preferred: { arrival: null, nights, resortId: null, roomTypeId: null, ticketOption: null, bookingMethod: null, dining: null } });

/** A mock model that interprets "N nights" and explains by quoting the first fact with a money amount. */
function goodModel() {
  return new MockProvider(
    (input) => {
      const m = input.message.match(/(\d+) nights/);
      return proposal({
        reply: "Changing the stay length.",
        patch: m ? nightsPatch(Number(m[1])) : patch({}),
        evidence: m ? [{ field: "preferred.nights", userQuote: m[0] }] : [],
        intent: m ? "update" : "explain",
      });
    },
    (input) => {
      const f = input.facts.find((x) => x.text.startsWith("Cheapest option:"))!;
      const amount = f.text.match(/\$[\d,]+\.\d\d/)![0];
      return { message: `The cheapest option costs ${amount} [${f.id}].`, citedFacts: [f.id] };
    },
  );
}

describe("assistant service", () => {
  it("turns a message into a reviewable proposal without changing anything until applied", async () => {
    const d = deps(goodModel());
    const conv = await createConversation(d);
    const before = structuredClone(conv.request);
    const after = await sendMessage(d, conv.id, "Let's do 7 nights");
    const p = last(after, "proposal");
    expect(p.proposal?.status).toBe("pending");
    expect(p.proposal?.diff).toEqual(["Preferred nights: 6 → 7"]);
    expect(after.request).toEqual(before); // not applied yet
    expect(after.lastResult).toBeNull();
    expect(p.text).toMatch(/Who's traveling|park day/); // defaults the user hasn't confirmed are surfaced
  });

  it("applies via the existing optimizer and grounds the explanation in its result", async () => {
    const d = deps(goodModel());
    let conv = await createConversation(d);
    conv = await sendMessage(d, conv.id, "Let's do 7 nights");
    conv = await applyProposal(d, conv.id, last(conv, "proposal").id);
    expect(conv.request.preferred.nights).toBe(7);
    // The stored result is exactly what optimize() produces for the new request.
    const independent = optimize({ catalog: CATALOG, data: DATA, request: conv.request, now: NOW });
    expect(conv.lastResult!.ranked.map((e) => [e.id, e.totalCents])).toEqual(independent.ranked.map((e) => [e.id, e.totalCents]));
    const result = last(conv, "result");
    expect(result.source).toBe("optimizer");
    expect(result.run?.diff).toEqual(["Preferred nights: 6 → 7"]);
    const exp = last(conv, "explanation");
    expect(exp.explanation?.grounded).toBe("ai");
    const cheapest = independent.ranked.find((e) => e.id === independent.awards.find((a) => a.kind === "cheapest")!.evaluationId)!;
    expect(exp.text).toContain(formatCents(cheapest.totalCents));
    expect(conv.confirmed).toContain("preferred");
  });

  it("the AI cannot introduce its own prices: an invented amount is withheld and results are untouched", async () => {
    const liar = new MockProvider(
      () => proposal({ patch: nightsPatch(7), evidence: [{ field: "preferred.nights", userQuote: "7 nights" }] }),
      () => ({ message: "Book now for just $999.00, the best deal around!", citedFacts: [] }),
    );
    const d = deps(liar);
    let conv = await createConversation(d);
    conv = await sendMessage(d, conv.id, "7 nights please");
    conv = await applyProposal(d, conv.id, last(conv, "proposal").id);
    const exp = last(conv, "explanation");
    expect(exp.explanation?.grounded).toBe("deterministic");
    expect(exp.explanation?.rejectedReason).toMatch(/\$999\.00/);
    expect(exp.text).not.toContain("$999.00");
    const independent = optimize({ catalog: CATALOG, data: DATA, request: conv.request, now: NOW });
    expect(conv.lastResult!.awards).toEqual(independent.awards);
  });

  it("rejects AI output that tries to carry prices or totals (strict schema) and falls back visibly", async () => {
    const sneaky = new MockProvider(() => ({ ...proposal({ patch: nightsPatch(7) }), totalCents: 1, cheapestPrice: "$10" }));
    const d = deps(sneaky);
    const conv = await createConversation(d);
    const after = await sendMessage(d, conv.id, "7 nights");
    expect(after.messages.some((m) => m.kind === "notice" && /couldn't use/.test(m.text))).toBe(true);
    const p = last(after, "proposal");
    expect(p.source).toBe("rules"); // basic mode handled it instead
    expect(p.proposal?.diff).toContain("Preferred nights: 6 → 7");
    const smuggled = new MockProvider(() => proposal({ patch: { ...nightsPatch(7), priceCents: 100 } as never }));
    const after2 = await sendMessage(deps(smuggled, d.repo), conv.id, "7 nights");
    expect(last(after2, "notice").text).toMatch(/couldn't use/);
  });

  it("never applies money the user didn't state", async () => {
    const inventive = new MockProvider(() =>
      proposal({ patch: patch({ budget: { targetDollars: null, clearTarget: false, hardLimitDollars: 4000, clearHardLimit: false } }), reply: "I set a limit." }),
    );
    const d = deps(inventive);
    const conv = await createConversation(d);
    const after = await sendMessage(d, conv.id, "Find me something cheaper");
    // Nothing else changed, so there is no proposal, only an explanation of what wasn't applied.
    expect(after.messages.some((m) => m.kind === "proposal")).toBe(false);
    expect(last(after, "reply").text).toMatch(/\$4,000\.00 was not applied because you didn't mention that amount/);
    expect(after.request.budget.hardLimitCents).toBeUndefined();
    // Alongside a legitimate change, the proposal carries the warning and excludes the amount.
    const mixed = new MockProvider(() =>
      proposal({ patch: { ...nightsPatch(7), budget: { targetDollars: null, clearTarget: false, hardLimitDollars: 4000, clearHardLimit: false } } }),
    );
    const after2 = await sendMessage(deps(mixed, d.repo), conv.id, "7 nights and cheaper");
    const p = last(after2, "proposal").proposal!;
    expect(p.warnings[0]).toMatch(/\$4,000\.00 was not applied/);
    expect(p.preview?.budget.hardLimitCents).toBeUndefined();
    expect(p.preview?.preferred.nights).toBe(7);
  });

  it("strips prices from the interpretation reply", async () => {
    const chatty = new MockProvider(() => proposal({ patch: nightsPatch(7), reply: "Seven nights will cost about $3,999." }));
    const d = deps(chatty);
    const conv = await createConversation(d);
    const after = await sendMessage(d, conv.id, "7 nights");
    expect(last(after, "proposal").text).not.toContain("$3,999");
  });

  it("degrades gracefully when the provider fails (rate limits, outages)", async () => {
    const down = new MockProvider(() => {
      throw new AiError("rate_limited");
    }, () => {
      throw new AiError("unavailable");
    });
    const d = deps(down);
    let conv = await createConversation(d);
    conv = await sendMessage(d, conv.id, "6 nights, 2 adults");
    expect(conv.messages.find((m) => m.kind === "notice")?.text).toMatch(/rate-limiting.*basic mode/);
    conv = await applyProposal(d, conv.id, last(conv, "proposal").id);
    const exp = last(conv, "explanation");
    expect(exp.explanation?.grounded).toBe("deterministic");
    expect(exp.explanation?.rejectedReason).toMatch(/temporarily unavailable/);
    expect(conv.lastResult).not.toBeNull();
  });

  it("preserves every unrelated preference across refinements", async () => {
    const d = deps(getProvider({}).provider); // basic mode, no key
    let conv = await createConversation(d);
    conv = await sendMessage(d, conv.id, "Two adults, six or seven nights, preferably Pop Century, Park Hopper Plus and a dining plan, keep it under $5,000");
    conv = await applyProposal(d, conv.id, last(conv, "proposal").id);
    const first = structuredClone(conv.request);
    conv = await sendMessage(d, conv.id, "What if we stayed one more night?");
    const p = last(conv, "proposal").proposal!;
    expect(p.diff).toEqual(["Preferred nights: 6 → 7"]);
    conv = await applyProposal(d, conv.id, last(conv, "proposal").id);
    const { preferred: p2, ...rest2 } = conv.request;
    const { preferred: p1, ...rest1 } = first;
    expect(rest2).toEqual(rest1);
    expect({ ...p2, nights: 6 }).toEqual(p1);
    expect(conv.request.budget.targetCents).toBe(500_000);
    expect(conv.request.dining.policy).toBe("prefer");
    // The explanation reports the change measured by the optimizer, before vs after.
    expect(last(conv, "explanation").explanation!.facts.some((f) => f.text.startsWith("Before this change the cheapest"))).toBe(true);
  });

  it("runs comparison variants through the optimizer", async () => {
    const d = deps(getProvider({}).provider);
    let conv = await createConversation(d);
    conv = await sendMessage(d, conv.id, "Compare deluxe vs value resorts");
    const p = last(conv, "proposal").proposal!;
    expect(p.comparisons.map((c) => c.label)).toEqual(["value resorts", "deluxe resorts"]);
    conv = await applyProposal(d, conv.id, last(conv, "proposal").id);
    const run = last(conv, "result").run!;
    const valueReq = p.comparisons[0]!.request!;
    const direct = optimize({ catalog: CATALOG, data: DATA, request: valueReq, now: NOW });
    const directCheapest = direct.ranked.find((e) => e.id === direct.awards.find((a) => a.kind === "cheapest")!.evaluationId)!;
    expect(run.variants[0]!.summary!.cheapest!.totalCents).toBe(directCheapest.totalCents);
    expect(last(conv, "explanation").text).toMatch(/Comparison "value resorts"/);
  });

  it("explains current results without re-running when nothing changes", async () => {
    const d = deps(goodModel());
    let conv = await createConversation(d);
    conv = await sendMessage(d, conv.id, "7 nights");
    conv = await applyProposal(d, conv.id, last(conv, "proposal").id);
    const runs = conv.messages.filter((m) => m.kind === "result").length;
    conv = await sendMessage(d, conv.id, "Why did that one win?");
    expect(conv.messages.filter((m) => m.kind === "result").length).toBe(runs);
    expect(last(conv).kind).toBe("explanation");
  });

  it("supports dismissing, auto-apply, editing in the form and restoring earlier plans", async () => {
    const d = deps(goodModel());
    let conv = await createConversation(d);
    conv = await sendMessage(d, conv.id, "7 nights");
    conv = await dismissProposal(d, conv.id, last(conv, "proposal").id);
    expect(last(conv, "proposal").proposal?.status).toBe("dismissed");
    await expect(applyProposal(d, conv.id, last(conv, "proposal").id)).rejects.toThrow(/can't be applied/);

    conv = await updateSettings(d, conv.id, { autoApply: true });
    conv = await sendMessage(d, conv.id, "5 nights");
    expect(conv.request.preferred.nights).toBe(5);
    expect(last(conv, "proposal").proposal?.status).toBe("applied");
    const snapshot = last(conv, "result").run!.request;

    const edited = { ...conv.request, party: { adults: 3, children: 0, infants: 0 } };
    conv = await runRequest(d, conv.id, edited, "form");
    expect(conv.request.party.adults).toBe(3);
    expect(last(conv, "result").run?.diff[0]).toMatch(/Travelers/);
    conv = await runRequest(d, conv.id, snapshot, "restore");
    expect(conv.request).toEqual(snapshot);
    await expect(runRequest(d, conv.id, { ...snapshot, party: { adults: 0 } }, "form")).rejects.toThrow(/Invalid request/);
  });

  it("starts from the planner's request when given one (those choices count as stated)", async () => {
    const d = deps(goodModel());
    const conv = await createConversation(d, { request: { ...defaultTripRequest(), party: { adults: 4, children: 1, infants: 0 } } });
    expect(conv.request.party.adults).toBe(4);
    expect(conv.confirmed).toContain("party");
  });
});

describe("provider configuration", () => {
  it("falls back to basic mode without an API key, and never needs one for the planner", () => {
    expect(getProvider({}).status).toMatchObject({ mode: "basic", provider: "rules" });
    expect(getProvider({ AI_PROVIDER: "rules", ANTHROPIC_API_KEY: "x" }).status.mode).toBe("basic");
    expect(getProvider({ AI_PROVIDER: "something-else", ANTHROPIC_API_KEY: "x" }).status.reason).toMatch(/Unknown AI_PROVIDER/);
  });
  it("uses Claude when a key is set, with an overridable model", () => {
    expect(getProvider({ ANTHROPIC_API_KEY: "test-key" }).status).toMatchObject({ mode: "ai", provider: "anthropic:claude-opus-5-5" });
    expect(getProvider({ ANTHROPIC_API_KEY: "test-key", AI_MODEL: "claude-sonnet-5-5" }).status.provider).toBe("anthropic:claude-sonnet-5-5");
  });
});

import { RequestError } from "@/lib/errors";
import { randomUUID } from "node:crypto";
import { todayIso } from "@/domain/dates";
import { tripContextFromRequest } from "@/itinerary/context";
import { compareItineraries, compareSummary, planItinerary, type ItineraryComparison } from "@/itinerary/engine";
import { defaultPreferences, emptyParkInfo, type Itinerary, type ItineraryInput } from "@/itinerary/types";
import { checkGrounding, unsupportedClaims } from "../grounding";
import { AiError } from "../providers/provider";
import { explanationSchema, type Conversation, type ConversationMessage, type ItineraryProposalRecord } from "../types";
import type { AssistantDeps } from "../service";
import { checkItineraryNumbers, itineraryExplanation, itineraryFacts } from "./digest";
import { applyItineraryPatch, itineraryProposalSchema, type ItineraryProposal } from "./patch";
import { interpretItineraryWithRules, isItineraryRequest } from "./rules";

/**
 * Itinerary planning in the assistant. Same contract as trip planning:
 *   message → interpret (AI or basic mode) → validated patch → proposal for review
 *   apply   → deterministic planner (+ comparison variants) → facts → explanation (grounded)
 * The AI never produces times, durations, hours or availability; the planner does.
 */

const today = (deps: AssistantDeps) => todayIso(deps.now?.() ?? new Date());
const msg = (deps: AssistantDeps, m: Omit<ConversationMessage, "id" | "at">): ConversationMessage => ({ id: randomUUID(), at: (deps.now?.() ?? new Date()).toISOString(), ...m });
const userTexts = (conv: Conversation) => conv.messages.filter((m) => m.kind === "user").map((m) => m.text);

/** Trip-pricing changes (nights, budget, resort, party...) stay with the trip planner even in an itinerary conversation. */
function looksLikeTripChange(text: string): boolean {
  return /\b(\d+ nights?|one more night|budget|\$\s?\d|adults?|children|kids|arriv(e|al) (a day|earlier|later)|switch to|deluxe|value resort|moderate resort|dvc|points|ticket type|park hopper plus|dining plan)\b/i.test(text);
}

export function routesToItinerary(conv: Conversation, text: string): boolean {
  return isItineraryRequest(text) || (!!conv.itinerary && !looksLikeTripChange(text));
}

async function ensureState(deps: AssistantDeps, conv: Conversation): Promise<string | null> {
  if (conv.itinerary) return null;
  const data = await deps.loadData({ includeIllustrative: conv.request.data.includeIllustrative });
  const r = tripContextFromRequest(conv.request, data, { kind: "request", label: conv.title === "New plan" ? "Your plan in this conversation" : conv.title }, today(deps));
  if (!r.ok) return r.errors.join(" ");
  conv.itinerary = { input: { context: r.context, prefs: defaultPreferences(), parkInfo: emptyParkInfo(), demo: false }, savedId: null, tripId: null, lastResult: null, lastComparison: null };
  return null;
}

async function interpret(deps: AssistantDeps, conv: Conversation, text: string): Promise<{ proposal: ItineraryProposal; source: string; notice?: string }> {
  const input = conv.itinerary!.input;
  const rules = () => interpretItineraryWithRules(text, input);
  if (deps.provider.kind === "rules" || !deps.provider.interpretItinerary) {
    return { proposal: rules(), source: "rules", ...(deps.provider.kind !== "rules" ? { notice: "The AI provider doesn't support itinerary requests; basic mode handled this message." } : {}) };
  }
  try {
    const raw = await deps.provider.interpretItinerary({ today: today(deps), input, history: conv.messages.slice(0, -1), message: text });
    const parsed = itineraryProposalSchema.safeParse(raw);
    if (!parsed.success) throw new AiError("invalid_output", parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return { proposal: parsed.data, source: deps.provider.id };
  } catch (err) {
    const e = err instanceof AiError ? err : new AiError("invalid_output", err instanceof Error ? err.message : undefined);
    return { proposal: rules(), source: "rules", notice: `${e.userMessage} I used basic mode for this message instead.` };
  }
}

/** Handle a message that is about the itinerary. The user's message is already in `conv.messages`. */
export async function sendItineraryMessage(deps: AssistantDeps, conv: Conversation, text: string, save: (c: Conversation) => Promise<Conversation>): Promise<Conversation> {
  const problem = await ensureState(deps, conv);
  if (problem) {
    conv.messages.push(msg(deps, { role: "assistant", kind: "reply", source: "app", text: `I can plan an itinerary once the trip's dates, resort and tickets are set. ${problem}` }));
    return save(conv);
  }
  const { proposal, source, notice } = await interpret(deps, conv, text);
  if (notice) conv.messages.push(msg(deps, { role: "system", kind: "notice", source: "app", text: notice }));
  const state = conv.itinerary!;
  const texts = userTexts(conv);
  const applied = applyItineraryPatch(state.input, proposal.patch, texts, today(deps));
  const base = applied.input ?? state.input;
  const comparisons = proposal.comparisons.slice(0, 3).map((c) => {
    const r = applyItineraryPatch(base, c.patch, texts, today(deps));
    return { label: c.label.slice(0, 80), input: r.input, diff: r.diff, errors: r.errors };
  });
  // Replies may not state times or durations the planner didn't produce.
  let reply = proposal.reply.trim();
  const allowed = [...texts, ...applied.diff, ...comparisons.flatMap((c) => [c.label, ...c.diff])].map((t, i) => ({ id: `U${i}`, text: t }));
  if (reply && checkItineraryNumbers(reply, allowed).length) reply = "Here's what I understood. Times and durations come from the planner once the changes are applied.";
  const extra = [...(proposal.unsupported.length ? proposal.unsupported : []), ...proposal.clarifications];
  const changes = applied.diff.length > 0 || comparisons.length > 0 || applied.errors.length > 0;
  if (changes) {
    const record: ItineraryProposalRecord = {
      preview: applied.input,
      diff: applied.diff,
      errors: applied.errors,
      warnings: applied.warnings,
      comparisons,
      status: applied.errors.length || comparisons.some((c) => c.errors.length) ? "invalid" : "pending",
    };
    conv.messages.push(msg(deps, { role: "assistant", kind: "itinerary_proposal", source, text: [reply, ...extra].filter(Boolean).join("\n\n"), itineraryProposal: record }));
    if (record.status === "pending" && conv.autoApply) return applyItineraryProposal(deps, conv, conv.messages[conv.messages.length - 1]!.id, save);
    return save(conv);
  }
  if (proposal.intent === "explain" && !proposal.unsupported.length) {
    if (!state.lastResult) return save(await planAndExplain(deps, conv, { question: text, diff: [], comparisons: [] }));
    await explainInto(deps, conv, state.lastResult, state.lastComparison ?? [], { question: text, diff: [] });
    return save(conv);
  }
  conv.messages.push(msg(deps, { role: "assistant", kind: "reply", source, text: [reply, ...extra].filter(Boolean).join("\n\n") || "Tell me how you'd like your park days to look." }));
  return save(conv);
}

export async function applyItineraryProposal(deps: AssistantDeps, conv: Conversation, messageId: string, save: (c: Conversation) => Promise<Conversation>): Promise<Conversation> {
  const m = conv.messages.find((x) => x.id === messageId);
  const record = m?.itineraryProposal;
  if (!m || !record || !conv.itinerary) throw new RequestError("Proposal not found");
  if (record.status !== "pending" || !record.preview) throw new RequestError(`This proposal can't be applied (${record.status}).`);
  const question = [...conv.messages].reverse().find((x) => x.kind === "user" && x.at <= m.at)?.text ?? "";
  conv.itinerary.input = record.preview;
  record.status = "applied";
  return save(
    await planAndExplain(deps, conv, {
      question,
      diff: record.diff,
      comparisons: record.comparisons.filter((c) => c.input).map((c) => ({ label: c.label, input: c.input!, diff: c.diff })),
    }),
  );
}

async function planAndExplain(
  deps: AssistantDeps,
  conv: Conversation,
  ctx: { question: string; diff: string[]; comparisons: { label: string; input: ItineraryInput; diff: string[] }[] },
): Promise<Conversation> {
  const state = conv.itinerary!;
  const opts = { today: today(deps) };
  const main = planItinerary(state.input, opts);
  let variants: { label: string; differs: string[]; input: ItineraryInput; itinerary: Itinerary }[] = [];
  if (ctx.comparisons.length === 1) {
    variants = [
      { label: "Current plan", differs: ["your current preferences"], input: state.input, itinerary: main },
      { label: ctx.comparisons[0]!.label, differs: ctx.comparisons[0]!.diff, input: ctx.comparisons[0]!.input, itinerary: planItinerary(ctx.comparisons[0]!.input, opts) },
    ];
  } else if (ctx.comparisons.length > 1) {
    variants = ctx.comparisons.slice(0, 2).map((c) => ({ label: c.label, differs: c.diff, input: c.input, itinerary: planItinerary(c.input, opts) }));
  }
  const details = variants.length === 2 ? compareItineraries(variants[0]!, variants[1]!) : null;
  state.lastResult = main;
  state.lastComparison = variants.length ? variants.map((v) => ({ label: v.label, differs: v.differs, itinerary: v.itinerary })) : null;
  state.lastComparisonDetails = details;
  const comparison = variants.length === 2 ? [`${variants[0]!.label} vs ${variants[1]!.label}:`, ...compareSummary(variants[0]!.itinerary, variants[1]!.itinerary)] : [];
  conv.messages.push(
    msg(deps, {
      role: "system",
      kind: "itinerary_result",
      source: "itinerary planner",
      text: main.headline,
      itineraryRun: { headline: main.headline, status: main.status, provisional: main.provisional, score: main.score?.total ?? null, comparison },
    }),
  );
  await explainInto(deps, conv, main, variants, { question: ctx.question, diff: ctx.diff }, details);
  return conv;
}

async function explainInto(
  deps: AssistantDeps,
  conv: Conversation,
  it: Itinerary,
  variants: { label: string; differs: string[]; itinerary: Itinerary }[],
  ctx: { question: string; diff: string[] },
  details: ItineraryComparison | null = conv.itinerary?.lastComparisonDetails ?? null,
) {
  const facts = itineraryFacts(it, variants, details);
  let note: string | undefined;
  let raw: unknown = null;
  try {
    raw = await deps.provider.explain({ question: ctx.question, diff: ctx.diff, facts });
  } catch (err) {
    note = `${err instanceof AiError ? err.userMessage : "The AI explanation failed."} Showing the planner's facts instead.`;
  }
  const parsed = raw === null ? null : explanationSchema.safeParse(raw);
  if (parsed && !parsed.success) note = "The AI explanation was malformed, so the planner's facts are shown instead.";
  let text: string | null = null;
  let cited: string[] = [];
  if (parsed?.success && parsed.data.message.trim()) {
    const money = checkGrounding(parsed.data.message, facts, parsed.data.citedFacts);
    const numbers = checkItineraryNumbers(parsed.data.message, facts);
    const claims = unsupportedClaims(parsed.data.message, facts);
    if (money.ok && numbers.length === 0 && claims.length === 0) {
      text = parsed.data.message.trim();
      cited = [...new Set(parsed.data.citedFacts)];
    } else {
      const figures = [...money.unknownAmounts, ...money.unknownRatios, ...numbers, ...money.unknownFacts];
      note = `The AI explanation was withheld because it contained ${[figures.length ? `figures the planner didn't produce: ${figures.join(", ")}` : null, claims.length ? `claims the facts don't support (${claims.join(", ")})` : null].filter(Boolean).join("; ")}.`;
    }
  }
  const det = text ? null : itineraryExplanation(facts, ctx.question, ctx.diff);
  conv.messages.push(
    msg(deps, {
      role: "assistant",
      kind: "explanation",
      source: text ? deps.provider.id : "itinerary planner facts",
      text: text ?? det!.message,
      explanation: { facts, cited: text ? cited : det!.cited, grounded: text ? "ai" : "deterministic", rejectedReason: note },
    }),
  );
}

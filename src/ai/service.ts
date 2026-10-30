import { randomUUID } from "node:crypto";
import { defaultTripRequest } from "@/data/defaults";
import { todayIso } from "@/domain/dates";
import { formatCents, type Cents } from "@/domain/money";
import { optimize } from "@/domain/optimizer/optimize";
import { parseTripRequest } from "@/domain/schema";
import type { Catalog, OptimizationResult, PriceData, TripRequest } from "@/domain/types";
import { baselineConfiguration } from "@/domain/optimizer/optimize";
import { configKey, fingerprint } from "@/monitoring/fingerprint";
import type { ObservationRecord } from "@/monitoring/observations";
import { buildDigest, summarizeRun } from "./digest";
import { historyFacts } from "./history";
import { checkGrounding, groundExplanation } from "./grounding";
import { applyPatch, defaultQuestions, diffRequests, moneyMentions } from "./patch";
import { AiError, type AiProvider } from "./providers/provider";
import { RulesProvider } from "./providers/rules";
import {
  explanationSchema,
  proposalSchema,
  type Conversation,
  type ConversationMessage,
  type Proposal,
  type ProposalRecord,
  type RequestSection,
} from "./types";

/**
 * The assistant workflow. The AI only interprets words and phrases
 * explanations; every price, total, saving and ranking comes from optimize().
 *
 *   message → provider.interpret → validate → applyPatch (deterministic, schema-checked)
 *           → proposal for review (or auto-apply)
 *   apply   → optimize() (+ one run per comparison) → facts digest
 *           → provider.explain → grounding check (or deterministic explanation)
 */

export interface ConversationRepo {
  get(id: string): Promise<Conversation | undefined>;
  save(c: Conversation): Promise<Conversation>;
}

export interface AssistantDeps {
  repo: ConversationRepo;
  provider: AiProvider;
  catalog: Catalog;
  loadData: (opts: { includeIllustrative: boolean }) => Promise<PriceData>;
  /** Recorded price observations for configuration fingerprints (price-history questions). */
  loadObservations?: (fingerprints: string[]) => Promise<ObservationRecord[]>;
  now?: () => Date;
}

const ALL_SECTIONS: RequestSection[] = ["party", "dates", "preferred", "resorts", "tickets", "dining", "transport", "budget", "objective", "eligibility", "data"];
const MAX_COMPARISONS = 3;

export class ConversationNotFound extends Error {}

const nowIso = (deps: AssistantDeps) => (deps.now?.() ?? new Date()).toISOString();

function message(deps: AssistantDeps, m: Omit<ConversationMessage, "id" | "at">): ConversationMessage {
  return { id: randomUUID(), at: nowIso(deps), ...m };
}

async function load(deps: AssistantDeps, id: string): Promise<Conversation> {
  const c = await deps.repo.get(id);
  if (!c) throw new ConversationNotFound(`Conversation ${id} not found`);
  return c;
}

/** Start a conversation, optionally from the planner's current request (whose choices count as stated). */
export async function createConversation(deps: AssistantDeps, opts: { request?: TripRequest; title?: string } = {}): Promise<Conversation> {
  const fromPlanner = opts.request ? parseTripRequest(opts.request) : null;
  if (fromPlanner && !fromPlanner.ok) throw new Error(`Invalid request: ${fromPlanner.errors.join("; ")}`);
  const at = nowIso(deps);
  const conv: Conversation = {
    id: randomUUID(),
    title: opts.title?.trim() || "New plan",
    createdAt: at,
    updatedAt: at,
    request: fromPlanner?.ok ? fromPlanner.request : defaultTripRequest(),
    confirmed: fromPlanner?.ok ? [...ALL_SECTIONS] : [],
    autoApply: false,
    messages: [],
    lastResult: null,
    lastVariants: [],
  };
  return deps.repo.save(conv);
}

function userTexts(conv: Conversation): string[] {
  return conv.messages.filter((m) => m.kind === "user").map((m) => m.text);
}

/** Money values the assistant may repeat without the optimizer: what the user said and what's in their request. */
function userMoney(conv: Conversation): Cents[] {
  const out = new Set<Cents>();
  for (const t of userTexts(conv)) for (const c of moneyMentions(t)) out.add(c);
  const r = conv.request;
  for (const c of [r.budget.targetCents, r.budget.hardLimitCents, r.dining.outOfPocketPerAdultPerNightCents, r.dining.outOfPocketPerChildPerNightCents, r.transport.rentalPerDayCents]) {
    if (c !== undefined) out.add(c);
  }
  return [...out];
}

/** Interpret with the configured provider; on provider failure or unusable output, fall back to basic mode (visibly). */
async function interpret(deps: AssistantDeps, conv: Conversation, text: string): Promise<{ proposal: Proposal; source: string; notice?: string }> {
  const input = {
    today: todayIso(deps.now?.() ?? new Date()),
    request: conv.request,
    confirmed: conv.confirmed,
    catalog: deps.catalog,
    history: conv.messages.slice(0, -1),
    lastRun: conv.lastResult ? summarizeRun(conv.lastResult) : null,
    message: text,
  };
  try {
    const raw = await deps.provider.interpret(input);
    const parsed = proposalSchema.safeParse(raw);
    if (!parsed.success) throw new AiError("invalid_output", parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return { proposal: parsed.data, source: deps.provider.id };
  } catch (err) {
    const e = err instanceof AiError ? err : new AiError("invalid_output", err instanceof Error ? err.message : undefined);
    if (deps.provider.kind === "rules") throw e;
    const fallback = (await new RulesProvider().interpret(input)) as Proposal;
    return { proposal: fallback, source: "rules", notice: `${e.userMessage} I used basic mode for this message instead.` };
  }
}

/** Handle a user message: interpret, then propose changes, ask, or explain. Never changes prices or the request directly. */
export async function sendMessage(deps: AssistantDeps, conversationId: string, text: string): Promise<Conversation> {
  let conv = await load(deps, conversationId);
  const trimmed = text.trim().slice(0, 4000);
  if (!trimmed) return conv;
  conv.messages.push(message(deps, { role: "user", kind: "user", text: trimmed }));
  if (conv.title === "New plan") conv.title = trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;

  let interpreted: Awaited<ReturnType<typeof interpret>>;
  try {
    interpreted = await interpret(deps, conv, trimmed);
  } catch (err) {
    const e = err instanceof AiError ? err : new AiError("invalid_output");
    conv.messages.push(message(deps, { role: "assistant", kind: "error", text: e.userMessage, source: deps.provider.id }));
    return save(deps, conv);
  }
  const { proposal, source, notice } = interpreted;
  if (notice) conv.messages.push(message(deps, { role: "system", kind: "notice", text: notice, source: "app" }));

  // The interpretation reply may not state prices (beyond the user's own numbers).
  let reply = proposal.reply.trim();
  if (reply && !checkGrounding(reply, [], [], userMoney(conv)).ok) {
    reply = "Here's what I understood. Prices come from the optimizer once the changes are applied.";
  }

  const patchResult = applyPatch(conv.request, proposal.patch, deps.catalog, userTexts(conv));
  const base = patchResult.request ?? conv.request;
  const comparisons = proposal.comparisons.slice(0, MAX_COMPARISONS).map((c) => {
    const r = applyPatch(base, c.patch, deps.catalog, userTexts(conv));
    return { label: c.label.slice(0, 80), request: r.request, diff: r.request ? diffRequests(base, r.request, deps.catalog) : [], errors: r.errors };
  });
  const changes = patchResult.diff.length > 0 || comparisons.length > 0 || patchResult.errors.length > 0;

  const clarifications = [...proposal.clarifications];
  if (!conv.messages.some((m) => m.kind === "result")) {
    const touched = new Set([...conv.confirmed, ...patchResult.touched]);
    for (const q of defaultQuestions(base, [...touched])) if (clarifications.length < 3) clarifications.push(q);
  }

  if (changes) {
    const record: ProposalRecord = {
      proposal,
      preview: patchResult.request,
      diff: patchResult.diff,
      adjustments: patchResult.adjustments,
      errors: patchResult.errors,
      warnings: patchResult.warnings,
      touched: patchResult.touched,
      comparisons,
      status: patchResult.errors.length || comparisons.some((c) => c.errors.length) ? "invalid" : "pending",
    };
    const extra = [
      ...(proposal.unsupported.length ? [`Not supported: ${proposal.unsupported.join(" ")}`] : []),
      ...(clarifications.length ? [clarifications.join(" ")] : []),
    ];
    conv.messages.push(message(deps, { role: "assistant", kind: "proposal", text: [reply, ...extra].filter(Boolean).join("\n\n"), source, proposal: record }));
    conv = await save(deps, conv);
    if (record.status === "pending" && conv.autoApply) return applyProposal(deps, conv.id, conv.messages[conv.messages.length - 1]!.id);
    return conv;
  }

  // No changes: explain current results, or reply/ask.
  if (proposal.intent === "explain") {
    if (!conv.lastResult) conv = await runAndExplain(deps, conv, { question: trimmed, diff: [], comparisons: [] });
    else await explainInto(deps, conv, conv.lastResult, { question: trimmed, diff: [] });
    return save(deps, conv);
  }
  const parts = [
    reply,
    ...patchResult.warnings,
    ...(proposal.unsupported.length ? [`I can't represent this in the optimizer: ${proposal.unsupported.join(" ")}`] : []),
    ...(clarifications.length ? clarifications : []),
  ].filter(Boolean);
  conv.messages.push(message(deps, { role: "assistant", kind: "reply", text: parts.join("\n\n") || "Could you tell me more about the trip you have in mind?", source }));
  return save(deps, conv);
}

/** Apply a reviewed proposal: update the request, run the optimizer, and explain the actual results. */
export async function applyProposal(deps: AssistantDeps, conversationId: string, messageId: string): Promise<Conversation> {
  const conv = await load(deps, conversationId);
  const msg = conv.messages.find((m) => m.id === messageId);
  const record = msg?.proposal;
  if (!msg || !record) throw new Error("Proposal not found");
  if (record.status !== "pending" || !record.preview) throw new Error(`This proposal can't be applied (${record.status}).`);
  const question = [...conv.messages].reverse().find((m) => m.kind === "user" && m.at <= msg.at)?.text ?? "";
  conv.request = record.preview;
  conv.confirmed = [...new Set([...conv.confirmed, ...record.touched])];
  record.status = "applied";
  const updated = await runAndExplain(deps, conv, {
    question,
    diff: record.diff,
    comparisons: record.comparisons.filter((c) => c.request).map((c) => ({ label: c.label, request: c.request! })),
  });
  return save(deps, updated);
}

export async function dismissProposal(deps: AssistantDeps, conversationId: string, messageId: string): Promise<Conversation> {
  const conv = await load(deps, conversationId);
  const record = conv.messages.find((m) => m.id === messageId)?.proposal;
  if (record && record.status === "pending") record.status = "dismissed";
  return save(deps, conv);
}

/** The user edited the plan in the form (or restored an earlier version): validate, run, explain. */
export async function runRequest(deps: AssistantDeps, conversationId: string, request: unknown, reason: "form" | "restore"): Promise<Conversation> {
  const conv = await load(deps, conversationId);
  const parsed = parseTripRequest(request);
  if (!parsed.ok) throw new Error(`Invalid request: ${parsed.errors.join("; ")}`);
  const diff = diffRequests(conv.request, parsed.request, deps.catalog);
  conv.request = parsed.request;
  if (reason === "form") conv.confirmed = [...ALL_SECTIONS];
  conv.messages.push(
    message(deps, {
      role: "user",
      kind: "user",
      text: reason === "form" ? `(Edited the plan in the form${diff.length ? `: ${diff.join("; ")}` : ""})` : "(Restored an earlier version of the plan)",
    }),
  );
  return save(deps, await runAndExplain(deps, conv, { question: reason === "form" ? "I edited the plan." : "I restored an earlier plan.", diff, comparisons: [] }));
}

export async function updateSettings(deps: AssistantDeps, conversationId: string, settings: { autoApply?: boolean; title?: string }): Promise<Conversation> {
  const conv = await load(deps, conversationId);
  if (settings.autoApply !== undefined) conv.autoApply = settings.autoApply;
  if (settings.title?.trim()) conv.title = settings.title.trim().slice(0, 100);
  return save(deps, conv);
}

async function runAndExplain(
  deps: AssistantDeps,
  conv: Conversation,
  ctx: { question: string; diff: string[]; comparisons: { label: string; request: TripRequest }[] },
): Promise<Conversation> {
  const previous = conv.lastResult ? summarizeRun(conv.lastResult) : null;
  const run = async (request: TripRequest): Promise<OptimizationResult> => {
    const data = await deps.loadData({ includeIllustrative: request.data.includeIllustrative });
    return optimize({ catalog: deps.catalog, data, request, now: deps.now?.() });
  };
  const result = await run(conv.request);
  const variants: Conversation["lastVariants"] = [];
  for (const c of ctx.comparisons) {
    try {
      variants.push({ label: c.label, summary: summarizeRun(await run(c.request)) });
    } catch (err) {
      variants.push({ label: c.label, summary: null, error: err instanceof Error ? err.message : "failed" });
    }
  }
  conv.lastResult = result;
  conv.lastVariants = variants;
  const summary = summarizeRun(result);
  conv.messages.push(
    message(deps, {
      role: "system",
      kind: "result",
      source: "optimizer",
      text: resultHeadline(summary, result),
      run: { request: conv.request, summary, variants, diff: ctx.diff },
    }),
  );
  await explainInto(deps, conv, result, { question: ctx.question, diff: ctx.diff }, previous, variants);
  return conv;
}

/** A one-line, optimizer-generated headline (no AI involved). */
function resultHeadline(s: ReturnType<typeof summarizeRun>, r: OptimizationResult): string {
  if (s.cheapest) {
    return `${r.demoMode ? "Illustrative results" : "Results"}: cheapest ${formatCents(s.cheapest.totalCents)}${s.bestValue ? `, best value ${formatCents(s.bestValue.totalCents)}` : ""}${s.bestAlternative ? `, best alternative saves ${formatCents(s.bestAlternative.savingsCents)} vs your plan` : ""}.`;
  }
  if (r.ranked.length === 1) return `One fully priced option: ${formatCents(r.ranked[0]!.totalCents)}.`;
  return "No option could be fully priced with the current requirements and price data.";
}

async function explainInto(
  deps: AssistantDeps,
  conv: Conversation,
  result: OptimizationResult,
  ctx: { question: string; diff: string[] },
  previous: ReturnType<typeof summarizeRun> | null = null,
  variants: Conversation["lastVariants"] = conv.lastVariants,
): Promise<void> {
  const facts = buildDigest({ result, request: conv.request, previous, variants, history: await loadHistoryFacts(deps, conv.request, result) });
  let raw: unknown = null;
  let note: string | undefined;
  try {
    raw = await deps.provider.explain({ question: ctx.question, diff: ctx.diff, facts });
  } catch (err) {
    note = `${err instanceof AiError ? err.userMessage : "The AI explanation failed."} Showing the optimizer's facts instead.`;
  }
  const parsed = raw === null ? null : explanationSchema.safeParse(raw);
  if (parsed && !parsed.success) note = "The AI explanation was malformed, so the optimizer's facts are shown instead.";
  const grounded = groundExplanation(parsed?.success ? parsed.data : null, facts, ctx, userMoney(conv));
  conv.messages.push(
    message(deps, {
      role: "assistant",
      kind: "explanation",
      source: grounded.grounded === "ai" ? deps.provider.id : "optimizer facts",
      text: grounded.message,
      explanation: { facts, cited: grounded.cited, grounded: grounded.grounded, rejectedReason: grounded.rejectedReason ?? note },
    }),
  );
}

/**
 * Price-history and switching facts for the preferred plan, from recorded
 * observations. A failure here (e.g. the database is down) only drops these
 * facts; the rest of the explanation still works.
 */
async function loadHistoryFacts(deps: AssistantDeps, request: TripRequest, result: OptimizationResult): Promise<string[]> {
  if (!deps.loadObservations) return [];
  try {
    const base = baselineConfiguration(request);
    const fps = "config" in base ? [fingerprint(configKey(base.config, request))] : [];
    const [observations, data] = await Promise.all([fps.length ? deps.loadObservations(fps) : [], deps.loadData({ includeIllustrative: request.data.includeIllustrative })]);
    return historyFacts({ request, result, data, observations });
  } catch {
    return ["Price history: recorded price history is unavailable right now (the database could not be reached)."];
  }
}

function save(deps: AssistantDeps, conv: Conversation): Promise<Conversation> {
  conv.updatedAt = nowIso(deps);
  return deps.repo.save(conv);
}

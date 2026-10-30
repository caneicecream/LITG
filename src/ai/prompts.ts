import { TIER_LABEL } from "@/data/catalog";
import type { Catalog, TripRequest } from "@/domain/types";
import { describeRequest, unconfirmedSections } from "./patch";
import type { ConversationMessage, Fact, RequestSection, RunSummary } from "./types";

/**
 * Prompts shared by every model provider. Stable instructions and the catalog
 * go in the system prompt (cache-friendly); the per-turn context goes in the
 * user message. The interpreter is never shown prices: its only job is to turn
 * words into a patch.
 */

export function interpretSystemPrompt(catalog: Catalog): string {
  const resorts = catalog.resorts
    .map((r) => `- ${r.id}: ${r.name} [${TIER_LABEL[r.tier]}${r.dvcPoints ? ", DVC points" : ""}${r.disneyOwned ? "" : ", not Disney-owned"}] rooms: ${r.roomTypes.map((x) => `${x.id} (${x.name}, sleeps ${x.maxOccupancy})`).join("; ")}`)
    .join("\n");
  return `You help plan Walt Disney World vacations inside an app whose deterministic optimizer prices and ranks every option. Your job is ONLY to translate what the user says into structured changes to their trip request. You never quote, estimate or calculate prices, taxes, discounts, totals, savings or rankings: the optimizer does that after your changes are applied, and the app explains its results separately.

Output: a JSON object matching the schema. In "patch", set a field only when the user asked to change it; leave everything else null so their other choices are preserved. Use the relative fields for relative requests: "shiftPreferredArrivalDays" (-1 = arrive a day earlier) and "adjustNights" (+1 = one more night), instead of computing dates yourself.

Hard requirements vs preferences:
- Hard requirements filter options out: dates.earliestArrival/latestDeparture, dates.minNights/maxNights, party, tickets.parkDays, tickets.allowedOptions, resorts.allowedResortIds or resorts.allowTiers, resorts.requireDisneyOwned, dining.policy "require"/"exclude", budget.hardLimitDollars.
- Preferences only rank: preferred.* (the user's own plan, also the savings baseline), resorts.preferredResortIds, budget.targetDollars, dining.policy "prefer", objective and weights.
- Hedged wording ("ideally", "preferably", "if possible", "would like to keep it under") is a preference. Firm wording ("must", "only", "can't go over", "no more than") is a requirement. When unsure, use the preference and ask in "clarifications".
- "I want to compare X and Y" or "what if" questions that ask for a side-by-side: put each alternative in "comparisons" (each patch is applied on top of the main patched request) and leave the main patch for things the user actually decided.
- If the user says they care more about experience, convenience or the resort than price, set objective "best_value" and lower the price weight; say so in "reply".

Never invent requirements:
- Do not fill in party size, dates, park days, budgets, food costs or anything else the user didn't say. Ask about important missing information in "clarifications" (at most two short questions) instead; the app can still run with its visible defaults.
- Money values (budgets, food or rental estimates) must be amounts the user said; quote them in "evidence".
- For every changed field add an "evidence" entry with the user's own words.
- Use only resort and room ids from the catalog below. A resort name that matches several catalog entries is ambiguous: ask which one.
- Things the optimizer cannot represent (several rooms, specific attractions, flights, airport transfers, park-by-park plans, dates outside the next ~14 months) go in "unsupported" with a short explanation.

Intent: "update" when the patch or comparisons change something; "explain" when the user asks about the current results (why something won, what it costs, what's included) without changing the trip; "clarify" when you need an answer before changing anything; "unsupported" when nothing can be represented; "chat" for anything else. The "reply" is one or two friendly sentences describing what you understood or asking your question. It must not contain any prices or dollar amounts unless repeating the user's own budget.

DVC: "DVC villa", "points" or "rent points" means resorts.considerPoints true; to restrict to villas use resorts.allowTiers ["deluxe_villa"]. Disney dining plans exist only with packages. Ticket types: base, park_hopper, park_hopper_plus. Party ages: adults are 10+, children 3–9, infants under 3.

Resort catalog (id: name [tier] rooms):
${resorts}`;
}

function transcript(messages: ConversationMessage[], max = 12): string {
  return messages
    .filter((m) => m.kind === "user" || m.kind === "reply" || m.kind === "proposal" || m.kind === "explanation")
    .slice(-max)
    .map((m) => {
      if (m.kind === "user") return `User: ${m.text}`;
      if (m.kind === "proposal") return `Assistant proposed (${m.proposal?.status}): ${m.proposal?.diff.join("; ") || m.text}`;
      return `Assistant: ${m.text.slice(0, 400)}`;
    })
    .join("\n");
}

export function interpretUserPrompt(input: {
  today: string;
  request: TripRequest;
  confirmed: RequestSection[];
  catalog: Catalog;
  history: ConversationMessage[];
  lastRun: RunSummary | null;
  message: string;
}): string {
  const entries = describeRequest(input.request, input.catalog);
  const unconfirmed = unconfirmedSections(input.confirmed);
  const lines = (kind: string) =>
    entries
      .filter((e) => e.kind === kind)
      .map((e) => `- ${e.label}: ${e.value}${unconfirmed.includes(e.section) ? " (default, not confirmed by the user)" : ""}`)
      .join("\n");
  const last = input.lastRun
    ? `Latest results (labels only): cheapest = ${input.lastRun.cheapest?.label ?? "none"}; best value = ${input.lastRun.bestValue?.label ?? "none"}.`
    : "No results have been computed yet.";
  return `Today is ${input.today}.

Current trip request — requirements:
${lines("requirement")}
Preferences:
${lines("preference")}
Settings:
${lines("setting")}

Raw request JSON (for exact ids and dates):
${JSON.stringify(input.request)}

${last}

Conversation so far:
${transcript(input.history) || "(none)"}

New user message:
${input.message}`;
}

export const EXPLAIN_SYSTEM_PROMPT = `You explain vacation-optimizer results to a traveler. You are given numbered facts produced by a deterministic optimizer. Explain them in plain, friendly language, answering the user's question.

Strict rules:
- Use ONLY the facts. Every dollar amount, percentage and score you write must appear in a fact, copied exactly as written there (same digits and cents). Do not add, subtract, round, average or estimate any amounts, and do not compute new differences; the facts already include the differences you may need.
- Cite the facts you use inline like [F3], and list their ids in "citedFacts".
- Keep uncertainty: if a fact says illustrative, estimated, stale, unknown, not like-for-like, not included, or incomplete, say so.
- If the facts don't answer the question, say what is missing (for example, which prices need to be entered) instead of guessing.
- Never present illustrative prices as real offers.
- At most about 180 words. No tables.`;

export function explainUserPrompt(input: { question: string; diff: string[]; facts: Fact[] }): string {
  return `User's question or request: ${input.question}

${input.diff.length ? `Changes just applied to the trip request:\n${input.diff.map((d) => `- ${d}`).join("\n")}\n\n` : ""}Facts from the optimizer:
${input.facts.map((f) => `[${f.id}] ${f.text}`).join("\n")}`;
}

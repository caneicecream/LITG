import { matchByName } from "@/data/importers/values";
import { addDays, todayIso } from "@/domain/dates";
import type { Catalog, ResortTier, TicketOption } from "@/domain/types";
import { EMPTY_PATCH, type Proposal, type RequestPatch } from "../types";
import type { AiProvider, InterpretInput } from "./provider";

/**
 * Basic mode: a small, deterministic interpreter used when no AI provider is
 * configured. It recognizes explicit phrasings only (party size, nights,
 * relative dates, months, budgets, resorts, tiers, tickets, dining, DVC,
 * objective). Anything it doesn't understand produces a clarification, never
 * a guess. Explanations come from the deterministic explainer.
 */

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14 };
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : (WORDS[s.toLowerCase()] ?? NaN));
const NUM = "(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen)";
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const TIER_WORDS: [RegExp, ResortTier][] = [
  [/\bvalue\b/, "value"],
  [/\bmoderate\b/, "moderate"],
  [/\bdeluxe villas?\b|\bdvc villas?\b/, "deluxe_villa"],
  [/\bdeluxe\b/, "deluxe"],
];

function dollars(s: string): number {
  const m = s.match(/\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|thousand|grand)?/i)!;
  const v = Number(m[1]!.replace(/,/g, ""));
  return m[2] ? v * 1000 : v;
}

export function interpretWithRules(input: InterpretInput): Proposal {
  const text = input.message.trim();
  const t = text.toLowerCase();
  const patch: RequestPatch = structuredClone(EMPTY_PATCH);
  const evidence: Proposal["evidence"] = [];
  const clarifications: string[] = [];
  const unsupported: string[] = [];
  const comparisons: Proposal["comparisons"] = [];
  const understood: string[] = [];
  const note = (field: string, quote: string, what: string) => {
    evidence.push({ field, userQuote: quote });
    understood.push(what);
  };
  let m: RegExpMatchArray | null;

  // Party
  if ((m = t.match(new RegExp(`${NUM}\\s+adults?`)))) {
    patch.party = { adults: num(m[1]!), children: null, infants: null };
    note("party.adults", m[0], `${num(m[1]!)} adults`);
  }
  if ((m = t.match(new RegExp(`${NUM}\\s+(?:kids?|children|child)`)))) {
    patch.party = { adults: patch.party?.adults ?? null, children: num(m[1]!), infants: null };
    note("party.children", m[0], `${num(m[1]!)} children`);
  } else if (/\bno kids\b|\bjust (?:the )?(?:two of us|adults)\b/.test(t)) {
    patch.party = { adults: patch.party?.adults ?? null, children: 0, infants: null };
    note("party.children", "no kids", "no children");
  }

  // Nights
  if ((m = t.match(/\b(?:one|1|an?) (?:more|extra|additional) nights?\b|\bstay(?:ed)? (?:one|a) (?:more )?night longer\b/))) {
    patch.adjustNights = 1;
    note("adjustNights", m[0], "one more night");
  } else if ((m = t.match(/\b(?:one|1) (?:fewer|less) nights?\b|\b(?:one|a) night shorter\b/))) {
    patch.adjustNights = -1;
    note("adjustNights", m[0], "one night fewer");
  } else if ((m = t.match(new RegExp(`${NUM}\\s*(?:or|to|-|–)\\s*${NUM}\\s+nights?`)))) {
    const a = num(m[1]!);
    const b = num(m[2]!);
    patch.dates = { earliestArrival: null, latestDeparture: null, minNights: Math.min(a, b), maxNights: Math.max(a, b) };
    patch.preferred = { arrival: null, nights: Math.min(a, b), resortId: null, roomTypeId: null, ticketOption: null, bookingMethod: null, dining: null };
    note("dates.nights", m[0], `${Math.min(a, b)}–${Math.max(a, b)} nights`);
  } else if ((m = t.match(new RegExp(`${NUM}\\s+nights?`)))) {
    const n = num(m[1]!);
    patch.dates = { earliestArrival: null, latestDeparture: null, minNights: n, maxNights: n };
    patch.preferred = { arrival: null, nights: n, resortId: null, roomTypeId: null, ticketOption: null, bookingMethod: null, dining: null };
    note("dates.nights", m[0], `${n} nights`);
  }

  // Relative arrival
  if ((m = t.match(new RegExp(`(?:arriv\\w*|come|get there|go)\\s+${NUM}\\s+days?\\s+(earlier|later|sooner)`))) || (m = t.match(/(?:arriv\w*|come|get there|go)\s+(a) day\s+(earlier|later|sooner)/))) {
    const n = num(m[1]!);
    patch.shiftPreferredArrivalDays = m[2] === "later" ? n : -n;
    note("shiftPreferredArrivalDays", m[0], `arrive ${n} day(s) ${m[2] === "later" ? "later" : "earlier"}`);
  }

  // Month window ("in March", "late October", "early February 2027")
  if ((m = t.match(new RegExp(`\\b(early|mid|late)?\\s*-?\\s*(${MONTHS.join("|")})\\b(?:\\s+(\\d{4}))?`)))) {
    const month = MONTHS.indexOf(m[2]!) + 1;
    const today = input.today || todayIso();
    let year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
    const mm = String(month).padStart(2, "0");
    const lastOf = (y: number) => new Date(Date.UTC(y, month, 0)).getUTCDate();
    const fromDay = m[1] === "early" ? 1 : m[1] === "mid" ? 10 : m[1] === "late" ? 18 : 1;
    // A window that has already started this year means next year (unless a year was given).
    if (!m[3] && `${year}-${mm}-${String(fromDay).padStart(2, "0")}` < today) year += 1;
    const last = lastOf(year);
    const [from, to] = m[1] === "early" ? [1, 12] : m[1] === "mid" ? [10, 22] : m[1] === "late" ? [18, last] : [1, last];
    const earliest = `${year}-${mm}-${String(from).padStart(2, "0")}`;
    const lastArrival = `${year}-${mm}-${String(to).padStart(2, "0")}`;
    const maxNights = patch.dates?.maxNights ?? input.request.dates.maxNights;
    patch.dates = {
      earliestArrival: earliest,
      latestDeparture: addDays(lastArrival, maxNights),
      minNights: patch.dates?.minNights ?? null,
      maxNights: patch.dates?.maxNights ?? null,
    };
    patch.preferred = { ...(patch.preferred ?? { nights: null, resortId: null, roomTypeId: null, ticketOption: null, bookingMethod: null, dining: null }), arrival: earliest };
    note("dates.window", m[0].trim(), `arrivals ${earliest} to ${lastArrival}`);
  }

  // Budget
  if ((m = t.match(/(?:can'?t go over|no more than|must not exceed|max(?:imum)?|hard limit(?: of)?|at most|cap(?: of)?)\s*(?:of\s*)?(\$\s?[\d,]+(?:\.\d+)?\s*(?:k|thousand|grand)?|[\d,]{3,}(?:\.\d+)?\s*(?:k|thousand|grand)?|\d+(?:\.\d+)?\s*(?:k|thousand|grand))/))) {
    patch.budget = { targetDollars: null, clearTarget: false, hardLimitDollars: dollars(m[1]!), clearHardLimit: false };
    note("budget.hardLimitDollars", m[0], `a hard limit of $${dollars(m[1]!).toLocaleString()}`);
  } else if ((m = t.match(/(?:under|below|less than|within|around|about|budget(?: of| is)?|keep (?:it|the total|things)?\s*(?:under|below)?)\s*(\$\s?[\d,]+(?:\.\d+)?\s*(?:k|thousand|grand)?|[\d,]{4,}(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:k|thousand|grand))/))) {
    patch.budget = { targetDollars: dollars(m[1]!), clearTarget: false, hardLimitDollars: null, clearHardLimit: false };
    note("budget.targetDollars", m[0], `a budget target of $${dollars(m[1]!).toLocaleString()} (tell me if it's a hard limit)`);
  } else if (/\bno budget\b|\bremove the budget\b/.test(t)) {
    patch.budget = { targetDollars: null, clearTarget: true, hardLimitDollars: null, clearHardLimit: true };
    note("budget", "no budget", "no budget limit");
  }

  // Comparisons between tiers ("compare deluxe vs value")
  const tiersMentioned = TIER_WORDS.filter(([re]) => re.test(t)).map(([, tier]) => tier);
  const compareWords = /\bcompare\b|\bversus\b|\bvs\.?\b|\bagainst\b/.test(t);
  if (compareWords && tiersMentioned.length >= 2) {
    for (const tier of tiersMentioned) {
      comparisons.push({ label: `${tier.replace("_", " ")} resorts`, patch: { ...structuredClone(EMPTY_PATCH), resorts: { allowedResortIds: null, allowTiers: [tier], requireDisneyOwned: null, preferredResortIds: null, considerPoints: tier === "deluxe_villa" ? true : null } } });
    }
    understood.push(`a side-by-side comparison of ${tiersMentioned.join(" and ")} resorts`);
  }

  // Specific resort: try every "at/switch to/prefer … <name>" phrase until one names a resort.
  let resortFound = false;
  if (!compareWords) {
    const phrases = t.matchAll(/\b(?:stay(?:ing)? at|switch(?:ed)? to|prefer(?:ably)?|ideally|at|try|in)\s+(?:the\s+)?(?:disney'?s\s+)?([a-z][a-z' &–-]{2,40}?)(?=[,.!?]| with| and| for| instead| resort|$)/g);
    for (const phrase of phrases) {
      const candidate = phrase[1]!.trim();
      const match = matchByName(candidate, input.catalog.resorts, { matchIds: false });
      if ("item" in match) {
        const r = match.item;
        patch.preferred = { ...(patch.preferred ?? { arrival: null, nights: null, ticketOption: null, bookingMethod: null, dining: null }), resortId: r.id, roomTypeId: null };
        patch.resorts = { allowedResortIds: null, allowTiers: null, requireDisneyOwned: null, preferredResortIds: [r.id], considerPoints: r.dvcPoints && /points|dvc/.test(t) ? true : null };
        note("preferred.resortId", phrase[0], `${r.name} as your preferred resort`);
        resortFound = true;
        break;
      }
      if (match.error.includes("ambiguous")) {
        clarifications.push(`Which resort did you mean: ${match.error.replace(/^"[^"]*" is ambiguous: /, "")}?`);
        resortFound = true;
        break;
      }
    }
  }
  if (!resortFound && !compareWords && tiersMentioned.length === 1 && /\bonly\b|\bstay at a\b|\bstay in a\b/.test(t)) {
    patch.resorts = { allowedResortIds: null, allowTiers: tiersMentioned, requireDisneyOwned: null, preferredResortIds: null, considerPoints: tiersMentioned[0] === "deluxe_villa" ? true : null };
    note("resorts.allowTiers", tiersMentioned[0]!, `only ${tiersMentioned[0]!.replace("_", " ")} resorts`);
  }

  // DVC
  if (/\bdvc\b|\bpoints?\b|\bvilla\b/.test(t) && !comparisons.length) {
    patch.resorts = { ...(patch.resorts ?? { allowedResortIds: null, allowTiers: null, requireDisneyOwned: null, preferredResortIds: null }), considerPoints: true };
    if (/\b(?:includes?|find|show)\b.*\bvilla\b|\bonly\b.*\bdvc\b/.test(t) && !patch.preferred?.resortId) patch.resorts.allowTiers = ["deluxe_villa"];
    note("resorts.considerPoints", "DVC", patch.resorts.allowTiers ? "DVC villas only, including point stays" : "DVC point stays considered");
  }

  // Tickets
  const optionIn = (s: string): TicketOption | null => (/hopper\s*plus|park hopper\+/.test(s) ? "park_hopper_plus" : /hopper/.test(s) ? "park_hopper" : /base ticket|1 park per day|one park per day/.test(s) ? "base" : null);
  if ((m = t.match(/\b(?:without|remove|no|skip|drop|don'?t need)\s+(?:the\s+)?(park hopper plus|hopper plus|park hopper|hopper)\b/))) {
    const drop = optionIn(m[1]!)!;
    const remaining = input.request.tickets.allowedOptions.filter((o) => o !== drop && !(drop === "park_hopper" && o === "park_hopper_plus"));
    patch.tickets = { parkDays: null, allowedOptions: remaining.length ? remaining : (["base", "park_hopper", "park_hopper_plus"] as TicketOption[]).filter((o) => o !== drop && !(drop === "park_hopper" && o === "park_hopper_plus")), parkOnArrivalDay: null, parkOnDepartureDay: null, allowThirdParty: null };
    note("tickets.allowedOptions", m[0], `no ${m[1]}`);
  } else {
    const opt = optionIn(t);
    if (opt) {
      patch.preferred = { ...(patch.preferred ?? { arrival: null, nights: null, resortId: null, roomTypeId: null, bookingMethod: null, dining: null }), ticketOption: opt };
      if (/\bmust\b|\bonly\b|\bneed\b|\brequire/.test(t)) {
        patch.tickets = { parkDays: null, allowedOptions: [opt], parkOnArrivalDay: null, parkOnDepartureDay: null, allowThirdParty: null };
      } else if (!input.request.tickets.allowedOptions.includes(opt)) {
        patch.tickets = { parkDays: null, allowedOptions: [...input.request.tickets.allowedOptions, opt], parkOnArrivalDay: null, parkOnDepartureDay: null, allowThirdParty: null };
      }
      note("preferred.ticketOption", opt.replace(/_/g, " "), `${opt.replace(/_/g, " ")} tickets`);
    }
  }
  if ((m = t.match(new RegExp(`${NUM}\\s+(?:park\\s+)?days?\\s+(?:in|at)\\s+the\\s+parks?|${NUM}\\s+park\\s+days?|${NUM}-day\\s+tickets?`)))) {
    const n = num((m[1] ?? m[2] ?? m[3])!);
    patch.tickets = { ...(patch.tickets ?? { allowedOptions: null, parkOnArrivalDay: null, parkOnDepartureDay: null, allowThirdParty: null }), parkDays: n };
    note("tickets.parkDays", m[0], `${n} park days`);
  }

  // Dining
  if ((m = t.match(/\b(?:without|no|skip|drop|remove)\s+(?:the\s+|a\s+)?(?:quick[- ]service\s+)?dining plan\b/))) {
    if (/\bcompare\b|\bsame trip\b/.test(t)) {
      comparisons.push({ label: "Without a dining plan", patch: { ...structuredClone(EMPTY_PATCH), dining: { policy: "exclude", foodPerAdultPerNightDollars: null, foodPerChildPerNightDollars: null } } });
      understood.push("a comparison without the dining plan");
    } else {
      patch.dining = { policy: "exclude", foodPerAdultPerNightDollars: null, foodPerChildPerNightDollars: null };
      note("dining.policy", m[0], "no dining plan");
    }
  } else if ((m = t.match(/\b(?:quick[- ]service (?:dining )?plan|dining plan)\b/))) {
    const quick = /quick/.test(m[0]);
    const firm = /\bmust\b|\bneed\b|\brequire/.test(t);
    patch.dining = { policy: firm ? "require" : "prefer", foodPerAdultPerNightDollars: null, foodPerChildPerNightDollars: null };
    patch.preferred = { ...(patch.preferred ?? { arrival: null, nights: null, resortId: null, roomTypeId: null, ticketOption: null }), dining: quick ? "quick_service_plan" : "dining_plan", bookingMethod: "package" };
    note("dining.policy", m[0], `${firm ? "a required" : "a preferred"} ${quick ? "Quick-Service " : ""}dining plan`);
  }

  // Objective
  if (/\bexperience\b|\bbest value\b|\bnot (?:just )?(?:the )?cheapest\b|\bcare more about\b/.test(t)) {
    patch.objective = { objective: "best_value", weights: { price: 30, resort: 25, convenience: 20, ticket: null, dining: null, dates: null } };
    note("objective", "experience over price", "ranking by best value with less weight on price");
  } else if (/\bcheapest\b|\blowest (?:price|cost|total)\b/.test(t) && !/\bwhy\b/.test(t)) {
    patch.objective = { objective: "lowest_cost", weights: null };
    note("objective", "cheapest", "ranking by lowest total cost");
  }
  if (/\bcheaper dates\b|\bflexible\b/.test(t) && !patch.dates?.earliestArrival) {
    clarifications.push("How flexible are your dates? Give me an earliest arrival and latest departure, or a month.");
  }

  // Unsupported
  if (/\b(two|2|three|3|multiple|separate) rooms\b/.test(t)) unsupported.push("Several rooms per party aren't supported yet; the optimizer prices one room for the whole party.");
  if (/\bflights?\b|\bairfare\b/.test(t)) unsupported.push("Flights aren't priced; add an estimate as an other expense in the planner.");

  const changed = Object.entries(patch).some(([, v]) => v !== null) || comparisons.length > 0;
  const asksWhy = /\b(why|explain|how much|what makes|break ?down|which promotions?|what'?s included)\b/.test(t) || /\?$/.test(text);
  const intent: Proposal["intent"] = changed ? "update" : clarifications.length ? "clarify" : unsupported.length ? "unsupported" : asksWhy ? "explain" : "chat";
  const reply = changed
    ? `I understood: ${understood.join("; ")}.`
    : intent === "explain"
      ? "Here's what the optimizer's results show."
      : intent === "chat"
        ? "Basic mode understands things like “6 nights”, “2 adults and 1 child”, “late October”, “under $4,500”, “switch to All-Star Movies”, “without Park Hopper Plus”, “compare deluxe vs value”, or “one more night”. For anything else, edit the plan directly."
        : "";
  return { intent, reply, patch, evidence, comparisons, clarifications, unsupported };
}

export class RulesProvider implements AiProvider {
  readonly id = "rules";
  readonly label = "Basic mode (no AI key configured)";
  readonly kind = "rules" as const;
  constructor(private readonly catalog?: Catalog) {}
  async interpret(input: InterpretInput): Promise<unknown> {
    return interpretWithRules(input);
  }
  async explain(): Promise<null> {
    return null;
  }
}

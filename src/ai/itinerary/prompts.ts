import { addDays, daysBetween, formatShortDate } from "@/domain/dates";
import { ATTRACTIONS, PARKS } from "@/itinerary/catalog";
import type { ItineraryInterpretInput } from "../providers/provider";

/** Prompts for itinerary interpretation (shared by every model provider). */
export function itinerarySystemPrompt(): string {
  const catalog = PARKS.map((p) => `- ${p.id}: ${p.name}\n${ATTRACTIONS.filter((a) => a.parkId === p.id).map((a) => `  - ${a.id}: ${a.name}`).join("\n")}`).join("\n");
  return `You help plan the days of a Walt Disney World trip inside an app whose deterministic itinerary planner decides the schedule. Your ONLY job is to translate what the user says into structured changes to their itinerary preferences ("patch"), side-by-side comparisons, clarifying questions, and things you can't represent.

Rules:
- Never invent or state park hours, closures, wait times, crowd levels, attraction details, ticket rules, or reservation or Lightning Lane availability. The app has none of this live information. If the user asks for such current facts, put a short explanation in "unsupported" saying the information isn't available and that they can enter what they know in the itinerary planner ("What you already know"), or plan provisionally.
- Dining reservations and Lightning Lane return windows may be added only when the user states the date and the time(s) in their message; copy the time exactly (HH:MM, 24-hour). Otherwise ask in "clarifications". Never claim Lightning Lane is available or bookable.
- Set a patch field only when the user asked to change it; leave everything else null so their other preferences are kept.
- "relaxed" → pace "relaxed" and relaxedSchedule true. "ride-focused", "as much as possible" → pace "packed" and maximizeAttractions true. "minimize walking" → minimizeWalking. "avoid crossing the park"/"backtracking" → reduceBacktracking. "keep afternoons flexible" → flexibleAfternoons. "move the most demanding day away from arrival" → avoidDemandingArrivalDay true. "an N-day plan" → parkDays N.
- "Compare X with Y" → two entries in "comparisons", each with its own patch, and leave the main patch empty. "What would we lose if we removed a park day?" → one comparison with parkDays one less than now.
- Use only park and attraction ids from the catalog below. Unknown names: ask.
- intent: "update" when the patch or comparisons change something; "explain" when the user asks about the current itinerary or wants it built without changes; "clarify", "unsupported" or "chat" otherwise. "reply" is one or two friendly sentences with no times, durations or numbers other than the user's own.

Catalog (park id: name, then attraction id: name). It is the app's approximate catalog, not live information:
${catalog}`;
}

export function itineraryUserPrompt(input: ItineraryInterpretInput): string {
  const c = input.input.context;
  const days = Array.from({ length: daysBetween(c.arrival, c.departure) + 1 }, (_, i) => addDays(c.arrival, i));
  const history = input.history
    .filter((m) => m.kind === "user" || m.kind === "itinerary_proposal" || m.kind === "explanation")
    .slice(-10)
    .map((m) => (m.kind === "user" ? `User: ${m.text}` : m.kind === "itinerary_proposal" ? `Assistant proposed (${m.itineraryProposal?.status}): ${m.itineraryProposal?.diff.join("; ")}` : `Assistant: ${m.text.slice(0, 300)}`))
    .join("\n");
  return `Today is ${input.today}.

Trip: ${days.map((d) => `${d} (${formatShortDate(d)})`).join(", ")}. Ticket: ${c.ticket ? `${c.ticket.days} park days, ${c.ticket.hopper ? "Park Hopper" : "one park per day"}` : "no park tickets"}. Party: ${c.party.adults} adults, ${c.party.children} children.

Current itinerary preferences (JSON):
${JSON.stringify(input.input.prefs)}

Dining reservations and Lightning Lane windows already entered: ${JSON.stringify({ dining: input.input.parkInfo.dining.map((d) => ({ date: d.date, time: d.time, name: d.name })), lightningLane: input.input.parkInfo.lightningLane.map((l) => ({ date: l.date, attractionId: l.attractionId, start: l.start, end: l.end })) })}

Conversation so far:
${history || "(none)"}

New user message:
${input.message}`;
}

import { z } from "zod";
import type { Cents } from "@/domain/money";
import type { OptimizationResult, TripRequest } from "@/domain/types";
import type { Itinerary, ItineraryInput } from "@/itinerary/types";

/**
 * The AI layer's contract. The model never returns prices, totals or
 * rankings: it returns a *patch* to the TripRequest (null = "leave unchanged"),
 * plus clarifying questions and things the optimizer can't represent. The
 * patch is applied deterministically (src/ai/patch.ts) and validated with the
 * existing TripRequest schema before anything runs.
 *
 * Every property is required and nullable (structured-output friendly); money
 * is in whole or decimal dollars as people say it, converted to cents in code.
 */

const ticketOption = z.enum(["base", "park_hopper", "park_hopper_plus"]);
const dining = z.enum(["out_of_pocket", "quick_service_plan", "dining_plan"]);
const tier = z.enum(["value", "moderate", "deluxe", "deluxe_villa", "partner", "off_property"]);
const tristate = z.enum(["yes", "no", "unknown"]);
const n = <T extends z.ZodType>(t: T) => t.nullable();

export const patchSchema = z
  .object({
    party: n(z.object({ adults: n(z.int()), children: n(z.int()), infants: n(z.int()) }).strict()),
    dates: n(
      z
        .object({
          earliestArrival: n(z.string().describe("YYYY-MM-DD")),
          latestDeparture: n(z.string().describe("YYYY-MM-DD")),
          minNights: n(z.int()),
          maxNights: n(z.int()),
        })
        .strict(),
    ),
    shiftPreferredArrivalDays: n(z.int().describe("Move the preferred arrival by this many days (−1 = a day earlier)")),
    adjustNights: n(z.int().describe("Change the preferred stay length by this many nights (+1 = one more night)")),
    preferred: n(
      z
        .object({
          arrival: n(z.string().describe("YYYY-MM-DD")),
          nights: n(z.int()),
          resortId: n(z.string()),
          roomTypeId: n(z.string()),
          ticketOption: n(ticketOption),
          bookingMethod: n(z.enum(["separate", "package", "points"])),
          dining: n(dining),
        })
        .strict(),
    ),
    resorts: n(
      z
        .object({
          allowedResortIds: n(z.array(z.string()).describe("Hard requirement: only these resorts. [] = any resort.")),
          allowTiers: n(z.array(tier).describe("Hard requirement: only resorts in these tiers (alternative to allowedResortIds).")),
          requireDisneyOwned: n(z.boolean()),
          preferredResortIds: n(z.array(z.string()).describe("Soft preference: only affects the best-value score.")),
          considerPoints: n(z.boolean()),
        })
        .strict(),
    ),
    tickets: n(
      z
        .object({
          parkDays: n(z.int()),
          allowedOptions: n(z.array(ticketOption).describe("Hard requirement: accepted ticket types.")),
          parkOnArrivalDay: n(z.boolean()),
          parkOnDepartureDay: n(z.boolean()),
          allowThirdParty: n(z.boolean()),
        })
        .strict(),
    ),
    dining: n(
      z
        .object({
          policy: n(z.enum(["require", "prefer", "consider", "exclude"])),
          foodPerAdultPerNightDollars: n(z.number()),
          foodPerChildPerNightDollars: n(z.number()),
        })
        .strict(),
    ),
    transport: n(z.object({ mode: n(z.enum(["no_car", "own_car", "rental_car"])), rentalPerDayDollars: n(z.number()) }).strict()),
    budget: n(
      z
        .object({
          targetDollars: n(z.number().describe("Soft target the user would like to stay under")),
          clearTarget: z.boolean(),
          hardLimitDollars: n(z.number().describe("A limit the user said must not be exceeded")),
          clearHardLimit: z.boolean(),
        })
        .strict(),
    ),
    objective: n(
      z
        .object({
          objective: n(z.enum(["lowest_cost", "best_value"])),
          weights: n(
            z
              .object({ price: n(z.number()), resort: n(z.number()), convenience: n(z.number()), ticket: n(z.number()), dining: n(z.number()), dates: n(z.number()) })
              .strict(),
          ),
        })
        .strict(),
    ),
    eligibility: n(z.object({ florida_resident: n(tristate), annual_passholder: n(tristate), military: n(tristate) }).strict()),
    includeIllustrative: n(z.boolean()),
  })
  .strict();

export type RequestPatch = z.infer<typeof patchSchema>;

export const proposalSchema = z
  .object({
    intent: z.enum(["update", "explain", "clarify", "unsupported", "chat"]),
    /** Short conversational reply. Must not state prices; those come from the optimizer. */
    reply: z.string(),
    patch: patchSchema,
    /** The user's own words that justify each change (shown for review; money changes are checked against them). */
    evidence: z.array(z.object({ field: z.string(), userQuote: z.string() }).strict()),
    /** Alternative versions of the request to optimize side by side (each applied on top of the patched request). */
    comparisons: z.array(z.object({ label: z.string(), patch: patchSchema }).strict()),
    clarifications: z.array(z.string()),
    unsupported: z.array(z.string()),
  })
  .strict();

export type Proposal = z.infer<typeof proposalSchema>;

export const explanationSchema = z
  .object({
    message: z.string(),
    citedFacts: z.array(z.string()),
  })
  .strict();

export type Explanation = z.infer<typeof explanationSchema>;

export const EMPTY_PATCH: RequestPatch = {
  party: null,
  dates: null,
  shiftPreferredArrivalDays: null,
  adjustNights: null,
  preferred: null,
  resorts: null,
  tickets: null,
  dining: null,
  transport: null,
  budget: null,
  objective: null,
  eligibility: null,
  includeIllustrative: null,
};

// ─────────────────────────────── Conversations ───────────────────────────────

/** Sections of the request the user has stated (vs defaults they haven't confirmed). */
export type RequestSection =
  | "party"
  | "dates"
  | "preferred"
  | "resorts"
  | "tickets"
  | "dining"
  | "transport"
  | "budget"
  | "objective"
  | "eligibility"
  | "data";

export interface Fact {
  id: string;
  text: string;
}

/** Compact summary of one optimizer run, kept with the conversation for comparisons and history. */
export interface RunSummary {
  runAt: string;
  demoMode: boolean;
  comparable: number;
  cheapest: { id: string; label: string; totalCents: Cents; perNightCents: Cents; dataStatus: string } | null;
  bestValue: { id: string; label: string; totalCents: Cents; score: number | null } | null;
  bestAlternative: { id: string; label: string; totalCents: Cents; savingsCents: Cents } | null;
  baselineTotalCents: Cents | null;
}

export interface ProposalRecord {
  proposal: Proposal;
  /** The request the patch would produce (validated). Null when the patch is invalid. */
  preview: TripRequest | null;
  diff: string[];
  adjustments: string[];
  errors: string[];
  warnings: string[];
  /** Request sections the patch changed (they count as confirmed by the user once applied). */
  touched: RequestSection[];
  comparisons: { label: string; request: TripRequest | null; diff: string[]; errors: string[] }[];
  status: "pending" | "applied" | "dismissed" | "invalid";
}

export type MessageKind = "user" | "reply" | "proposal" | "result" | "explanation" | "error" | "notice" | "itinerary_proposal" | "itinerary_result";

/** A proposed change to the itinerary preferences or known park information (reviewed before it applies). */
export interface ItineraryProposalRecord {
  /** The validated input the change would produce (null when invalid). */
  preview: ItineraryInput | null;
  diff: string[];
  errors: string[];
  warnings: string[];
  comparisons: { label: string; input: ItineraryInput | null; diff: string[]; errors: string[] }[];
  status: "pending" | "applied" | "dismissed" | "invalid";
}

/** The itinerary a conversation is planning (present once itinerary planning starts). */
export interface ItineraryState {
  input: ItineraryInput;
  savedId: string | null;
  tripId: string | null;
  lastResult: Itinerary | null;
  lastComparison: { label: string; differs: string[]; itinerary: Itinerary }[] | null;
}

export interface ConversationMessage {
  id: string;
  at: string;
  role: "user" | "assistant" | "system";
  kind: MessageKind;
  text: string;
  /** Which provider produced the text ("anthropic:claude-opus-5-5", "rules", "optimizer"). */
  source?: string;
  proposal?: ProposalRecord;
  /** For results: the request that was optimized and its summary, so a decision can be revisited. */
  run?: {
    request: TripRequest;
    summary: RunSummary;
    variants: { label: string; summary: RunSummary | null; error?: string }[];
    diff: string[];
  };
  itineraryProposal?: ItineraryProposalRecord;
  /** For itinerary results: what was planned (summary; the full plan is in the conversation's itinerary state). */
  itineraryRun?: { headline: string; status: Itinerary["status"]; provisional: boolean; score: number | null; comparison: string[] };
  /** For explanations: facts the text is grounded in, and whether the AI text passed the grounding check. */
  explanation?: { facts: Fact[]; cited: string[]; grounded: "ai" | "deterministic"; rejectedReason?: string };
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  request: TripRequest;
  confirmed: RequestSection[];
  autoApply: boolean;
  messages: ConversationMessage[];
  lastResult: OptimizationResult | null;
  /** Variant results of the latest run, summarized. */
  lastVariants: { label: string; summary: RunSummary | null; error?: string }[];
  /** Itinerary planning (Milestone 5); absent in older conversations. */
  itinerary?: ItineraryState;
}

import type { Catalog, TripRequest } from "@/domain/types";
import type { ConversationMessage, Fact, RequestSection, RunSummary } from "../types";
import type { ItineraryInput } from "@/itinerary/types";

/**
 * A small, vendor-neutral interface. Providers return *raw* output; the
 * service validates it (zod) and never trusts it with prices or totals.
 */
export interface InterpretInput {
  today: string;
  request: TripRequest;
  confirmed: RequestSection[];
  catalog: Catalog;
  history: ConversationMessage[];
  lastRun: RunSummary | null;
  message: string;
}

export interface ItineraryInterpretInput {
  today: string;
  input: ItineraryInput;
  history: ConversationMessage[];
  message: string;
}

export interface ExplainInput {
  question: string;
  diff: string[];
  facts: Fact[];
}

export interface AiProvider {
  /** Stable id, e.g. "anthropic:claude-opus-5-5" or "rules". */
  readonly id: string;
  readonly label: string;
  readonly kind: "llm" | "rules" | "mock";
  /** Interpret a message into a proposal (raw; validated by the caller). */
  interpret(input: InterpretInput): Promise<unknown>;
  /** Interpret an itinerary request into an itinerary proposal (raw; validated by the caller). Optional: basic mode handles it otherwise. */
  interpretItinerary?(input: ItineraryInterpretInput): Promise<unknown>;
  /** Explain optimizer facts (raw; grounding-checked by the caller). Null = use the deterministic explanation. */
  explain(input: ExplainInput): Promise<unknown | null>;
}

export type AiErrorKind = "not_configured" | "auth" | "rate_limited" | "unavailable" | "timeout" | "refused" | "invalid_output" | "bad_request";

const USER_MESSAGE: Record<AiErrorKind, string> = {
  not_configured: "The AI assistant isn't configured. The planner and the basic assistant still work.",
  auth: "The AI provider rejected the API key. Check the key in your environment settings.",
  rate_limited: "The AI provider is rate-limiting requests right now. Please try again in a minute.",
  unavailable: "The AI provider is temporarily unavailable. Please try again shortly.",
  timeout: "The AI provider took too long to respond. Please try again.",
  refused: "The AI model declined to process that message. Try rephrasing it.",
  invalid_output: "The AI returned something I couldn't use, so nothing was changed. Please try rephrasing.",
  bad_request: "The request to the AI provider was rejected. This is likely a bug in the app.",
};

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    readonly detail?: string,
  ) {
    super(USER_MESSAGE[kind] + (detail ? ` (${detail})` : ""));
    this.name = "AiError";
  }
  get userMessage() {
    return USER_MESSAGE[this.kind];
  }
  get retryable() {
    return this.kind === "rate_limited" || this.kind === "unavailable" || this.kind === "timeout";
  }
}

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { EXPLAIN_SYSTEM_PROMPT, explainUserPrompt, interpretSystemPrompt, interpretUserPrompt } from "../prompts";
import { explanationSchema, proposalSchema } from "../types";
import { AiError, type AiProvider, type ExplainInput, type InterpretInput } from "./provider";

/**
 * Claude via the official Anthropic SDK (server-side only; the key never
 * reaches the browser). Structured outputs constrain the response to the
 * proposal/explanation schemas; the service still validates semantically.
 * Server-side refusal fallbacks are enabled by default (AI_FALLBACKS=off disables).
 */

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The subset of the SDK client used here (injectable for tests). */
export interface ParseClient {
  beta: { messages: { parse: (params: never) => Promise<{ stop_reason: string | null; parsed_output: unknown }> } };
}

export interface AnthropicProviderOptions {
  model: string;
  /** Effort for interpretation (default "medium") and explanations (default "low"). */
  interpretEffort: Effort;
  explainEffort: Effort;
  fallbacks: boolean;
  client?: ParseClient;
  apiKey?: string;
}

export class AnthropicProvider implements AiProvider {
  readonly kind = "llm" as const;
  readonly id: string;
  readonly label: string;
  private readonly client: ParseClient;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.id = `anthropic:${opts.model}`;
    this.label = `Claude (${opts.model})`;
    this.client =
      opts.client ?? (new Anthropic({ apiKey: opts.apiKey, timeout: 90_000, maxRetries: 2 }) as unknown as ParseClient);
  }

  interpret(input: InterpretInput): Promise<unknown> {
    return this.call(interpretSystemPrompt(input.catalog), interpretUserPrompt(input), proposalSchema, this.opts.interpretEffort);
  }

  explain(input: ExplainInput): Promise<unknown> {
    return this.call(EXPLAIN_SYSTEM_PROMPT, explainUserPrompt(input), explanationSchema, this.opts.explainEffort);
  }

  private async call(system: string, user: string, schema: z.ZodType, effort: Effort): Promise<unknown> {
    const params = {
      model: this.opts.model,
      max_tokens: 16000,
      system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
      messages: [{ role: "user" as const, content: user }],
      output_config: { effort, format: betaZodOutputFormat(schema) },
      ...(this.opts.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    };
    let res: { stop_reason: string | null; parsed_output: unknown };
    try {
      res = await this.client.beta.messages.parse(params as never);
    } catch (err) {
      throw mapError(err);
    }
    if (res.stop_reason === "refusal") throw new AiError("refused");
    if (res.stop_reason === "max_tokens") throw new AiError("invalid_output", "response was cut off");
    if (res.parsed_output === null || res.parsed_output === undefined) throw new AiError("invalid_output", "no structured output");
    return res.parsed_output;
  }
}

/** Typed SDK errors, most specific first. Anything else (e.g. a schema parse failure) is unusable output. */
export function mapError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new AiError("auth");
  if (err instanceof Anthropic.RateLimitError) return new AiError("rate_limited");
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AiError("timeout");
  if (err instanceof Anthropic.APIConnectionError) return new AiError("unavailable", "connection failed");
  if (err instanceof Anthropic.BadRequestError) return new AiError("bad_request", err.message.slice(0, 200));
  if (err instanceof Anthropic.APIError) {
    // 5xx and 529 (overloaded) after the SDK's own retries.
    return new AiError("unavailable", `status ${err.status ?? "unknown"}`);
  }
  return new AiError("invalid_output", err instanceof Error ? err.message.slice(0, 200) : undefined);
}

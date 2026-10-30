import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicProvider, mapError, type ParseClient } from "@/ai/providers/anthropic";
import { AiError } from "@/ai/providers/provider";
import { CATALOG } from "@/data/catalog";
import { defaultTripRequest } from "@/data/defaults";
import { proposal } from "./helpers";

/** The SDK client is mocked: no network calls in tests. */
function fakeClient(respond: (params: Record<string, unknown>) => unknown) {
  const calls: Record<string, unknown>[] = [];
  const client: ParseClient = {
    beta: {
      messages: {
        parse: (async (params: Record<string, unknown>) => {
          calls.push(params);
          return respond(params);
        }) as never,
      },
    },
  };
  return { client, calls };
}

const input = { today: "2026-10-30", request: defaultTripRequest(), confirmed: [], catalog: CATALOG, history: [], lastRun: null, message: "7 nights" };
const make = (client: ParseClient, fallbacks = true) =>
  new AnthropicProvider({ model: "claude-opus-5-5", interpretEffort: "medium", explainEffort: "low", fallbacks, client });

describe("Anthropic provider", () => {
  it("sends a structured-output request with refusal fallbacks and a cached system prompt", async () => {
    const { client, calls } = fakeClient(() => ({ stop_reason: "end_turn", parsed_output: proposal({}) }));
    await make(client).interpret(input);
    const p = calls[0]!;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect((p.output_config as { effort: string }).effort).toBe("medium");
    expect((p.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    expect((p.system as { cache_control: unknown }[])[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(p).not.toHaveProperty("tool_choice"); // forced tool use is not used
    expect(JSON.stringify(p.messages)).toContain("7 nights");
    const { client: c2, calls: calls2 } = fakeClient(() => ({ stop_reason: "end_turn", parsed_output: { message: "x", citedFacts: [] } }));
    await make(c2, false).explain({ question: "why", diff: [], facts: [{ id: "F1", text: "fact" }] });
    expect(calls2[0]).not.toHaveProperty("fallbacks");
    expect((calls2[0]!.output_config as { effort: string }).effort).toBe("low");
  });

  it("maps refusals, truncation and missing output to errors instead of guessing", async () => {
    for (const [res, kind] of [
      [{ stop_reason: "refusal", parsed_output: null }, "refused"],
      [{ stop_reason: "max_tokens", parsed_output: null }, "invalid_output"],
      [{ stop_reason: "end_turn", parsed_output: null }, "invalid_output"],
    ] as const) {
      const { client } = fakeClient(() => res);
      await expect(make(client).interpret(input)).rejects.toMatchObject({ kind });
    }
  });

  it("maps typed SDK errors to retryable and non-retryable kinds", async () => {
    const h = new Headers();
    expect(mapError(new Anthropic.RateLimitError(429, {}, "slow down", h))).toMatchObject({ kind: "rate_limited", retryable: true });
    expect(mapError(new Anthropic.AuthenticationError(401, {}, "bad key", h)).kind).toBe("auth");
    expect(mapError(new Anthropic.InternalServerError(529, {}, "overloaded", h))).toMatchObject({ kind: "unavailable", retryable: true });
    expect(mapError(new Anthropic.APIConnectionTimeoutError()).kind).toBe("timeout");
    expect(mapError(new Anthropic.APIConnectionError({ message: "down" })).kind).toBe("unavailable");
    expect(mapError(new Anthropic.BadRequestError(400, {}, "bad", h)).kind).toBe("bad_request");
    expect(mapError(new SyntaxError("Unexpected token")).kind).toBe("invalid_output");
    const { client } = fakeClient(() => {
      throw new Anthropic.RateLimitError(429, {}, "slow down", h);
    });
    await expect(make(client).interpret(input)).rejects.toBeInstanceOf(AiError);
  });
});

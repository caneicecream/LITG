import { AnthropicProvider } from "./anthropic";
import type { AiProvider } from "./provider";
import { RulesProvider } from "./rules";

/**
 * Provider selection from environment variables (server-side only):
 *   AI_PROVIDER        "anthropic" | "rules"   (default: anthropic when a key is set, otherwise rules)
 *   ANTHROPIC_API_KEY  Claude API key (never sent to the browser)
 *   AI_MODEL           default "claude-opus-5-5"
 *   AI_EFFORT          interpretation effort: low | medium | high | xhigh | max (default medium)
 *   AI_FALLBACKS       "off" disables server-side refusal fallbacks (default on)
 * Adding another vendor means implementing AiProvider and a case here.
 */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

export interface AiStatus {
  mode: "ai" | "basic";
  provider: string;
  label: string;
  /** Why the app is in basic mode, when it is. */
  reason?: string;
}

export function getProvider(env: Record<string, string | undefined> = process.env): { provider: AiProvider; status: AiStatus } {
  const requested = (env.AI_PROVIDER ?? "").toLowerCase();
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (requested === "rules") return basic("AI_PROVIDER is set to rules.");
  if (requested && requested !== "anthropic") return basic(`Unknown AI_PROVIDER "${env.AI_PROVIDER}".`);
  if (!key) return basic("No ANTHROPIC_API_KEY is set.");
  const effort = (EFFORTS as readonly string[]).includes(env.AI_EFFORT ?? "") ? (env.AI_EFFORT as Effort) : "medium";
  const provider = new AnthropicProvider({
    apiKey: key,
    model: env.AI_MODEL?.trim() || "claude-opus-5-5",
    interpretEffort: effort,
    explainEffort: "low",
    fallbacks: env.AI_FALLBACKS?.toLowerCase() !== "off",
  });
  return { provider, status: { mode: "ai", provider: provider.id, label: provider.label } };
}

function basic(reason: string): { provider: AiProvider; status: AiStatus } {
  const provider = new RulesProvider();
  return { provider, status: { mode: "basic", provider: provider.id, label: provider.label, reason } };
}

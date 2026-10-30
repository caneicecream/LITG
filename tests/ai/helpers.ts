import { CATALOG } from "@/data/catalog";
import { ILLUSTRATIVE_DATA } from "@/data/illustrative";
import { TAX_RATES, TRANSPORT } from "@/data/reference";
import { mergePriceData } from "@/data/sources";
import type { AssistantDeps, ConversationRepo } from "@/ai/service";
import { EMPTY_PATCH, type Conversation, type Proposal, type RequestPatch } from "@/ai/types";
import type { AiProvider, ExplainInput, InterpretInput } from "@/ai/providers/provider";

/** Mocked AI provider for tests: scripted outputs, records its inputs. No network. */
export class MockProvider implements AiProvider {
  readonly id = "mock:test-model";
  readonly label = "Mock";
  readonly kind = "llm" as const;
  interpretCalls: InterpretInput[] = [];
  explainCalls: ExplainInput[] = [];
  constructor(
    public onInterpret: (input: InterpretInput) => unknown | Promise<unknown>,
    public onExplain: (input: ExplainInput) => unknown | Promise<unknown> = () => null,
  ) {}
  async interpret(input: InterpretInput) {
    this.interpretCalls.push(input);
    return this.onInterpret(input);
  }
  async explain(input: ExplainInput) {
    this.explainCalls.push(input);
    return this.onExplain(input);
  }
}

export class MemoryRepo implements ConversationRepo {
  store = new Map<string, Conversation>();
  async get(id: string) {
    const c = this.store.get(id);
    return c ? structuredClone(c) : undefined;
  }
  async save(c: Conversation) {
    this.store.set(c.id, structuredClone(c));
    return structuredClone(c);
  }
}

export const NOW = new Date("2026-10-30T12:00:00Z");
export const DATA = mergePriceData([{ taxRates: TAX_RATES, transport: TRANSPORT }, ILLUSTRATIVE_DATA]);

export function deps(provider: AiProvider, repo = new MemoryRepo()): AssistantDeps & { repo: MemoryRepo } {
  return { repo, provider, catalog: CATALOG, loadData: async () => DATA, now: () => NOW };
}

export function patch(p: Partial<RequestPatch>): RequestPatch {
  return { ...structuredClone(EMPTY_PATCH), ...p };
}

export function proposal(p: Partial<Proposal>): Proposal {
  return { intent: "update", reply: "", patch: patch({}), evidence: [], comparisons: [], clarifications: [], unsupported: [], ...p };
}

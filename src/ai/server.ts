import { CATALOG } from "@/data/catalog";
import { loadPriceData } from "@/data/sources";
import { getConversation, saveConversation } from "@/data/store";
import { getProvider } from "./providers/config";
import type { AssistantDeps } from "./service";

/** Server-side wiring: local JSON store, configured provider (key from env), real price data. */
export function assistantDeps(): AssistantDeps {
  return {
    repo: { get: getConversation, save: saveConversation },
    provider: getProvider().provider,
    catalog: CATALOG,
    loadData: loadPriceData,
  };
}

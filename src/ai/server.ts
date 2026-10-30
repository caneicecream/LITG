import { CATALOG } from "@/data/catalog";
import { loadPriceData } from "@/data/sources";
import { getConversation, listPrices, saveConversation, storeKind } from "@/data/store";
import { getProvider } from "./providers/config";
import type { AssistantDeps } from "./service";

/** Server-side wiring: configured store and provider (key from env), real price data and recorded observations. */
export function assistantDeps(): AssistantDeps {
  return {
    repo: { get: getConversation, save: saveConversation },
    provider: getProvider().provider,
    catalog: CATALOG,
    loadData: loadPriceData,
    loadObservations: async (fingerprints) => {
      if ((await storeKind()) === "postgres") {
        const [{ appDb }, { observationsForFingerprints }] = await Promise.all([import("@/db/pool"), import("@/db/observations")]);
        return observationsForFingerprints(appDb()!.query, fingerprints);
      }
      // JSON store: rebuild observations from each entry's re-check history.
      const { observationsForImport } = await import("@/db/importJson");
      const now = new Date().toISOString();
      return (await listPrices()).flatMap((e) => (e.kind === "stay_quote" ? observationsForImport(e, now) : [])).filter((o) => o.fingerprint && fingerprints.includes(o.fingerprint));
    },
  };
}

import { z } from "zod";
import type { SourceConfig } from "../config.ts";
import { FetchError, type PoliteFetcher } from "../http.ts";
import type { Availability, Condition, Listing, SourceResult } from "../types.ts";

type BestBuySource = Extract<SourceConfig, { kind: "bestbuy_api" }>;

const API = "https://api.bestbuy.com/v1/products";
const FIELDS = "sku,name,salePrice,regularPrice,onlineAvailability,orderable,condition,url";

const productSchema = z.object({
  sku: z.union([z.number(), z.string()]).transform(String),
  name: z.string(),
  salePrice: z.number().nullable().optional(),
  regularPrice: z.number().nullable().optional(),
  onlineAvailability: z.boolean().nullable().optional(),
  orderable: z.string().nullable().optional(),
  condition: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
});
const responseSchema = z.object({ products: z.array(z.unknown()) });

/** Builds one Products API request URL (official Best Buy Developer API). */
export function bestBuyUrl(filter: string, apiKey: string): string {
  const qs = new URLSearchParams({ apiKey, format: "json", pageSize: "100", show: FIELDS });
  return `${API}(${filter})?${qs}`;
}

export function searchFilter(phrase: string): string {
  return phrase
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `search=${encodeURIComponent(w)}`)
    .join("&");
}

function availabilityOf(p: z.infer<typeof productSchema>): Availability {
  const orderable = p.orderable?.toLowerCase() ?? "";
  if (orderable === "preorder") return "preorder";
  if (p.onlineAvailability === true) return "in_stock";
  if (p.onlineAvailability === false) return "out_of_stock";
  return "unknown";
}

function conditionOf(value: string | null | undefined): Condition {
  const v = value?.toLowerCase() ?? "";
  if (v === "new") return "new";
  if (v.includes("refurb")) return "refurbished";
  if (v.includes("pre-owned") || v.includes("used") || v.includes("open")) return "used";
  return "unknown";
}

export async function checkBestBuy(
  source: BestBuySource,
  fetcher: PoliteFetcher,
  now: Date,
  apiKey: string | undefined,
): Promise<SourceResult> {
  if (!apiKey) return { sourceId: source.id, ok: false, kind: "config", error: "BESTBUY_API_KEY is not set" };
  const filters = source.searches.map(searchFilter);
  if (source.skus.length) filters.push(`sku in(${source.skus.join(",")})`);

  const bySku = new Map<string, Listing>();
  let parsed = 0;
  for (const filter of filters) {
    let body: unknown;
    try {
      const res = await fetcher.get(bestBuyUrl(filter, apiKey), { checkRobots: false, accept: "application/json" });
      body = JSON.parse(res.text);
    } catch (e) {
      if (e instanceof FetchError) {
        const hint = e.kind === "blocked" ? " Check that BESTBUY_API_KEY is valid and approved." : "";
        return { sourceId: source.id, ok: false, kind: e.kind, error: e.message + hint };
      }
      return { sourceId: source.id, ok: false, kind: "parse", error: "Best Buy returned something that isn't JSON" };
    }
    const shape = responseSchema.safeParse(body);
    if (!shape.success) return { sourceId: source.id, ok: false, kind: "parse", error: "unexpected Best Buy response shape" };
    for (const raw of shape.data.products) {
      const p = productSchema.safeParse(raw);
      if (!p.success) continue;
      parsed++;
      const product = p.data;
      const price = product.salePrice ?? product.regularPrice;
      bySku.set(product.sku, {
        key: `bestbuy:${product.sku}`,
        sourceId: source.id,
        sourceKind: "bestbuy_api",
        retailer: "Best Buy",
        title: product.name,
        url: product.url ?? `https://www.bestbuy.com/site/searchpage.jsp?st=${product.sku}`,
        priceCents: typeof price === "number" ? Math.round(price * 100) : null,
        availability: availabilityOf(product),
        condition: conditionOf(product.condition),
        seller: "Best Buy",
        observedAt: now.toISOString(),
      });
    }
  }
  return { sourceId: source.id, ok: true, listings: [...bySku.values()], note: `${parsed} products from ${filters.length} queries` };
}

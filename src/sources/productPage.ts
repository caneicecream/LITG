import type { SourceConfig } from "../config.ts";
import { FetchError, type PoliteFetcher } from "../http.ts";
import { checkTitle } from "../match.ts";
import { toCents } from "../money.ts";
import type { Availability, Condition, Listing, SourceResult } from "../types.ts";

type ProductPageSource = Extract<SourceConfig, { kind: "product_page" }>;

export interface PageOffer {
  title: string;
  priceCents: number | null;
  availability: Availability;
  condition: Condition;
  seller?: string;
  basis: "json-ld" | "meta";
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

const NAMED: Record<string, string> = {
  quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", reg: "®", trade: "™", copy: "©",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", amp: "&",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

export function mapAvailability(value: unknown): Availability {
  if (typeof value !== "string") return "unknown";
  const v = value.split("/").pop()!.toLowerCase().replace(/[^a-z]/g, "");
  if (["instock", "limitedavailability", "onlineonly", "instoreonly", "available"].includes(v)) return "in_stock";
  if (["preorder", "presale", "backorder"].includes(v)) return "preorder";
  if (["outofstock", "soldout", "discontinued", "oos", "unavailable"].includes(v)) return "out_of_stock";
  return "unknown";
}

export function mapCondition(value: unknown): Condition {
  if (typeof value !== "string") return "unknown";
  const v = value.split("/").pop()!.toLowerCase();
  if (v.includes("new")) return "new";
  if (v.includes("refurb")) return "refurbished";
  if (v.includes("used") || v.includes("damaged")) return "used";
  return "unknown";
}

function typeIs(node: Json, type: string): boolean {
  return asArray(node["@type"] as string | string[] | undefined).some((t) => typeof t === "string" && t.toLowerCase() === type.toLowerCase());
}

/** Every schema.org Product object in a JSON-LD document, however it is nested. */
function findProducts(node: unknown, out: Json[] = [], depth = 0): Json[] {
  if (depth > 12) return out;
  if (Array.isArray(node)) node.forEach((n) => findProducts(n, out, depth + 1));
  else if (isObj(node)) {
    if (typeIs(node, "Product") || typeIs(node, "ProductGroup")) out.push(node);
    for (const [k, v] of Object.entries(node)) if (k !== "offers") findProducts(v, out, depth + 1);
  }
  return out;
}

interface RawOffer {
  priceCents: number | null;
  currency?: string;
  availability: Availability;
  condition: Condition;
  seller?: string;
}

function offersOf(product: Json): RawOffer[] {
  const out: RawOffer[] = [];
  const visit = (o: unknown) => {
    if (!isObj(o)) return;
    if (typeIs(o, "AggregateOffer")) {
      const inner = asArray(o.offers as unknown);
      if (inner.length) inner.forEach(visit);
      else {
        out.push({
          priceCents: toCents(o.lowPrice ?? o.price),
          currency: o.priceCurrency as string | undefined,
          availability: mapAvailability(o.availability),
          condition: mapCondition(o.itemCondition),
        });
      }
      return;
    }
    const spec = asArray(o.priceSpecification as unknown).find(isObj);
    const seller = isObj(o.seller) && typeof o.seller.name === "string" ? o.seller.name : undefined;
    out.push({
      priceCents: toCents(o.price ?? spec?.price),
      currency: (o.priceCurrency ?? spec?.priceCurrency) as string | undefined,
      availability: mapAvailability(o.availability),
      condition: mapCondition(o.itemCondition ?? product.itemCondition),
      seller,
    });
  };
  asArray(product.offers as unknown).forEach(visit);
  // ProductGroup variants carry their own offers.
  asArray(product.hasVariant as unknown).forEach((v) => isObj(v) && asArray(v.offers as unknown).forEach(visit));
  return out;
}

function bestOffer(offers: RawOffer[]): RawOffer | undefined {
  const usd = offers.filter((o) => o.priceCents !== null && (!o.currency || o.currency.toUpperCase() === "USD"));
  const available = usd.filter((o) => o.availability === "in_stock" || o.availability === "preorder");
  const pool = available.length ? available : usd;
  return [...pool].sort((a, b) => a.priceCents! - b.priceCents!)[0] ?? offers[0];
}

function metaContent(html: string, names: string[]): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (!key || !names.includes(key)) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (content !== undefined) return decodeEntities(content);
  }
  return undefined;
}

/** Reads the price and stock a retailer publishes as structured data on a product page. */
export function extractOffer(html: string): PageOffer | null {
  const products: Json[] = [];
  const scripts = html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of scripts) {
    const body = m[1]!.trim().replace(/^<!--|-->$/g, "").replace(/^\s*\/\/<!\[CDATA\[|\/\/\]\]>\s*$/g, "");
    try {
      findProducts(JSON.parse(body), products);
    } catch {
      // A broken block is common; others on the page may still be fine.
    }
  }
  const named = products.map((p) => ({ p, name: typeof p.name === "string" ? decodeEntities(p.name) : "" }));
  const chosen = named.find((x) => checkTitle(x.name).isConsole) ?? named.find((x) => x.name);
  if (chosen) {
    const offer = bestOffer(offersOf(chosen.p));
    if (offer) {
      return {
        title: chosen.name,
        priceCents: offer.priceCents,
        availability: offer.availability,
        condition: offer.condition,
        seller: offer.seller,
        basis: "json-ld",
      };
    }
  }

  const price = metaContent(html, ["product:price:amount", "og:price:amount", "price"]);
  if (price === undefined) return null;
  const currency = metaContent(html, ["product:price:currency", "og:price:currency", "pricecurrency"]);
  if (currency && currency.toUpperCase() !== "USD") return null;
  const title =
    metaContent(html, ["og:title", "twitter:title"]) ??
    decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "");
  return {
    title,
    priceCents: toCents(price),
    availability: mapAvailability(metaContent(html, ["product:availability", "og:availability", "availability"])),
    condition: mapCondition(metaContent(html, ["product:condition", "og:condition"])),
    basis: "meta",
  };
}

export async function checkProductPage(source: ProductPageSource, fetcher: PoliteFetcher, now: Date): Promise<SourceResult> {
  try {
    const { text } = await fetcher.get(source.url, { checkRobots: true });
    const offer = extractOffer(text);
    if (!offer) {
      return {
        sourceId: source.id,
        ok: false,
        kind: "parse",
        error: "no structured price data on the page (it may load prices with JavaScript, or served a bot check)",
      };
    }
    const listing: Listing = {
      key: `page:${source.id}`,
      sourceId: source.id,
      sourceKind: "product_page",
      retailer: source.retailer,
      title: offer.title || `${source.retailer} product page`,
      url: source.url,
      priceCents: offer.priceCents,
      availability: offer.availability,
      condition: offer.condition,
      seller: offer.seller,
      observedAt: now.toISOString(),
    };
    return { sourceId: source.id, ok: true, listings: [listing], note: `read from ${offer.basis}` };
  } catch (e) {
    if (e instanceof FetchError) return { sourceId: source.id, ok: false, kind: e.kind, error: e.message };
    throw e;
  }
}
